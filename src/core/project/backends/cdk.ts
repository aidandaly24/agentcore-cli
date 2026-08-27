import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Stack } from "@aws-sdk/client-cloudformation";
import { ProjectStateError } from "../../../errors/errors";
import type { DeployResult, Project, ProjectEvent } from "../../../handlers/project/types";
import {
  FsReadWriteJson,
  requireTool,
  runProcess,
  type ProcessRunner,
  type ReadWriteJson,
} from "../../../io";
import type { Logger } from "../../../logging";
import type { AwsDeploymentTarget } from "../../../projectSchemas/aws-targets";
import type {
  DeployBackendInput,
  ProjectBackend,
  ResolveDeployedResourceBackendInput,
} from "./types";
import { stackArtifactIdForTarget } from "./cdk/assembly";
import { readDeployedState, updateTargetState } from "./cdk/deployedState";
import {
  probeBootstrap,
  resolveAwsAccount,
  type AccountResolver,
  type BootstrapProbe,
} from "./cdk/environment";
import {
  createCdkCredentialResolver,
  createCdkRunner,
  loadBootstrapTemplate,
  type BootstrapTemplateLoader,
  type CdkCredentialResolver,
  type CdkRunner,
} from "./cdk/toolkit";
import { describeStack } from "./cdk/stackReader";

type StackDescriber = typeof describeStack;

function sanitizeName(name: string): string {
  return name.replaceAll("_", "-");
}

function deployedResourceId(
  stack: Stack,
  input: ResolveDeployedResourceBackendInput,
): string | undefined {
  if (!stack.StackName) return undefined;
  const resourceName = sanitizeName(input.name);
  const exportName =
    input.resourceType === "runtime"
      ? `${stack.StackName}-${resourceName}-RuntimeId`
      : `${stack.StackName}-Harness-${resourceName}-Id`;
  return stack.Outputs?.find((output) => output.ExportName === exportName)?.OutputValue;
}

export type CdkBackendConfig = {
  logger: Logger;
  runner?: ProcessRunner;
  checkTool?: typeof requireTool;
  json?: ReadWriteJson;
  cdk?: CdkRunner;
  resolveCredentials?: CdkCredentialResolver;
  bootstrap?: BootstrapProbe;
  resolveAccount?: AccountResolver;
  loadBootstrapTemplate?: BootstrapTemplateLoader;
  describeStack?: StackDescriber;
};

/** Builds and deploys projects through the scaffolded CDK app. */
export class CdkBackend implements ProjectBackend {
  private readonly logger: Logger;
  private readonly runner: ProcessRunner;
  private readonly checkTool: typeof requireTool;
  private readonly json: ReadWriteJson;
  private readonly cdk: CdkRunner;
  private readonly resolveCredentials: CdkCredentialResolver;
  private readonly bootstrap: BootstrapProbe;
  private readonly resolveAccount: AccountResolver;
  private readonly loadBootstrapTemplate: BootstrapTemplateLoader;
  private readonly describeStack: StackDescriber;

  constructor(config: CdkBackendConfig) {
    this.logger = config.logger;
    this.runner = config.runner ?? runProcess;
    this.checkTool = config.checkTool ?? requireTool;
    this.json = config.json ?? new FsReadWriteJson({ logger: config.logger });
    this.cdk = config.cdk ?? createCdkRunner(config.logger);
    this.resolveCredentials =
      config.resolveCredentials ?? createCdkCredentialResolver(config.logger);
    this.bootstrap = config.bootstrap ?? probeBootstrap;
    this.resolveAccount = config.resolveAccount ?? resolveAwsAccount;
    this.loadBootstrapTemplate = config.loadBootstrapTemplate ?? loadBootstrapTemplate;
    this.describeStack = config.describeStack ?? describeStack;
  }

  public async *build(project: Project): AsyncGenerator<ProjectEvent, void> {
    const cdkDir = this.cdkDirectory(project);

    if (!existsSync(join(cdkDir, "node_modules"))) {
      throw new ProjectStateError(
        `CDK dependencies are missing for project '${project.name}'. ` +
          `Run 'cd ${cdkDir} && npm install'.`,
      );
    }
    await this.checkTool("npm", "Install Node.js: https://nodejs.org/");

    yield { message: "Synthesizing CloudFormation templates" };
    await this.runner(
      ["npm", "run", "cdk", "--", "synth", "--quiet", "--output", this.assemblyDirectory(project)],
      {
        cwd: cdkDir,
        onOutput: (chunk) => this.logger.debug(chunk),
      },
    );
  }

  public async *deploy(
    project: Project,
    input: DeployBackendInput,
  ): AsyncGenerator<ProjectEvent, DeployResult> {
    const { target } = input;
    yield { message: `Verifying AWS account ${target.account}` };
    const credentials = await this.credentialsFor(target);

    yield* this.build(project);
    const assemblyDirectory = this.assemblyDirectory(project);
    const stackArtifactId = await stackArtifactIdForTarget(
      this.json,
      assemblyDirectory,
      target.name,
    );
    const options = { assemblyDirectory, credentials, region: target.region };

    const bootstrap = await this.bootstrap(target.region, credentials);
    this.logger
      .child({
        account: target.account,
        region: target.region,
        bootstrapState: bootstrap.kind,
        ...("version" in bootstrap && { bootstrapVersion: bootstrap.version }),
      })
      .debug("checked CDK bootstrap stack");

    if (bootstrap.kind !== "current") {
      const environment = `aws://${target.account}/${target.region}`;
      yield { message: `Bootstrapping ${environment}` };
      const template = await this.loadBootstrapTemplate();
      try {
        await this.cdk(
          {
            kind: "bootstrap",
            environments: [environment],
            ...(template && { templateFile: template.path }),
          },
          options,
        );
      } finally {
        await template?.cleanup();
      }
    }

    yield { message: `Deploying ${stackArtifactId}` };
    const { outputs, stackArn } = await this.cdk({ kind: "deploy", stackArtifactId }, options);

    // Persist the deployed stack's ARN so later commands read live resource
    // state from CFN.  Merged per target, so deploying one target never drops another's recorded state
    if (stackArn) {
      await updateTargetState(this.json, project.rootPath, target.name, { stackArn });
    }

    return { outputs };
  }

  public async resolveDeployedResource(
    project: Project,
    input: ResolveDeployedResourceBackendInput,
  ): Promise<string> {
    const { target } = input;
    const deployedState = await readDeployedState(this.json, project.rootPath);
    const stackArn = deployedState.targets[target.name]?.stackArn;
    if (!stackArn) {
      throw new ProjectStateError(
        `Project '${project.name}' is not deployed to target '${target.name}'. ` +
          `Run 'agentcore project deploy --target ${target.name}' first.`,
      );
    }

    const credentials = await this.credentialsFor(target);
    const stack = await this.describeStack(target.region, credentials, stackArn);
    if (!stack) {
      throw new ProjectStateError(
        `Project '${project.name}' is not deployed to target '${target.name}'. ` +
          `Run 'agentcore project deploy --target ${target.name}' first.`,
      );
    }

    const id = deployedResourceId(stack, input);
    if (id) return id;

    const label = input.resourceType === "runtime" ? "Runtime" : "Harness";
    throw new ProjectStateError(
      `${label} '${input.name}' is not deployed to target '${target.name}'. ` +
        `Run 'agentcore project deploy --target ${target.name}' first.`,
    );
  }

  private async credentialsFor(target: AwsDeploymentTarget) {
    const credentials = await this.resolveCredentials(target.region);
    const account = await this.resolveAccount(target.region, credentials);
    if (account !== target.account) {
      throw new ProjectStateError(
        `Deployment target '${target.name}' expects AWS account ${target.account}, ` +
          `but the active credentials belong to ${account}.`,
      );
    }
    return credentials;
  }

  private cdkDirectory(project: Project): string {
    return join(project.rootPath, "agentcore", "cdk");
  }

  private assemblyDirectory(project: Project): string {
    return join(this.cdkDirectory(project), "cdk.out");
  }
}
