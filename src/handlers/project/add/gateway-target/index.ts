import type { TargetConfiguration } from "@aws-sdk/client-bedrock-agentcore-control";
import z from "zod";
import { InputValidationError } from "../../../../errors";
import { SourceResolver } from "../../../../io";
import type { AgentCoreGatewayTarget, OutboundAuth } from "../../../../projectSchemas/gateway";
import type { Credential } from "../../../../projectSchemas/credential";
import { createHandler, flag, ProjectKey } from "../../../../router";
import { parseJsonObjectFlag } from "../../../utils";
import type { Project } from "../../types";
import type { AddProjectResourceConfig } from "../types";
import { httpsEndpoint, translateTargetConfiguration } from "./configuration";

export const createAddGatewayTargetHandler = (config: AddProjectResourceConfig) =>
  createHandler({
    name: "gateway-target",
    description: "adds a Target to a project Gateway",
    flags: [
      flag("gateway", "name of the parent Gateway in this project", z.string().optional()),
      flag("name", "the Target name", z.string().optional()),
      flag("endpoint", "external MCP server HTTPS endpoint", z.string().optional()),
      flag("runtime", "name of a Runtime declared in this project", z.string().optional()),
      flag("runtime-endpoint", "named endpoint on the selected Runtime", z.string().optional()),
      flag(
        "target-configuration",
        "complete Target configuration (JSON; inline, file://<path>, or - for stdin)",
        z.string().optional(),
      ),
      flag(
        "outbound-auth",
        "Target authentication: none, oauth, or api-key",
        z.enum(["none", "oauth", "api-key"]).optional(),
      ),
      flag(
        "credential-name",
        "name of a compatible credential declared in this project",
        z.string().optional(),
      ),
      flag("scope", "OAuth scope", z.array(z.string()).optional()),
    ],
    handle: async (ctx, flags) => {
      if (!flags.gateway) {
        throw new InputValidationError("required option '--gateway <gateway>' not specified");
      }
      if (!flags.name) {
        throw new InputValidationError("required option '--name <name>' not specified");
      }
      const modes = [
        ["--endpoint", flags.endpoint],
        ["--runtime", flags.runtime],
        ["--target-configuration", flags["target-configuration"]],
      ].filter(([, value]) => value !== undefined);
      if (modes.length !== 1) {
        throw new InputValidationError(
          "specify exactly one of '--endpoint', '--runtime', or '--target-configuration'",
        );
      }
      if (flags["runtime-endpoint"] !== undefined && flags.runtime === undefined) {
        throw new InputValidationError("--runtime-endpoint requires --runtime");
      }

      const project = ctx.require(ProjectKey);
      const outboundAuth = projectOutboundAuth(project, {
        type: flags["outbound-auth"],
        credentialName: flags["credential-name"],
        scopes: flags.scope,
      });

      let target: AgentCoreGatewayTarget;
      let inlineSchema;
      if (flags.endpoint !== undefined) {
        target = {
          name: flags.name,
          targetType: "mcpServer",
          endpoint: httpsEndpoint(flags.endpoint, "--endpoint"),
          outboundAuth,
        };
      } else if (flags.runtime !== undefined) {
        target = {
          name: flags.name,
          targetType: "httpRuntime",
          httpRuntime: {
            runtime: flags.runtime,
            runtimeEndpoint: flags["runtime-endpoint"],
          },
          outboundAuth,
        };
      } else {
        const source = new SourceResolver({ stdin: config.io.stdin });
        const targetConfiguration = parseJsonObjectFlag<TargetConfiguration>(
          "target-configuration",
          await source.resolveText("target-configuration", flags["target-configuration"]),
        )!;
        const translated = translateTargetConfiguration(
          flags.name,
          targetConfiguration,
          outboundAuth,
        );
        target = translated.target;
        inlineSchema = translated.inlineSchema;
      }

      for await (const event of config.projectManager.addResource(project, {
        resourceType: "gateway-target",
        gatewayName: flags.gateway,
        resourceConfig: target,
        inlineSchema,
      })) {
        config.io.stderr.write(`${event.message}\n`);
      }
      config.io.stderr.write(
        `added Target '${flags.name}' to Gateway '${flags.gateway}' in '${project.name}'\n`,
      );
    },
  });

type OutboundAuthInput = {
  type?: "none" | "oauth" | "api-key";
  credentialName?: string;
  scopes?: string[];
};

function projectOutboundAuth(project: Project, input: OutboundAuthInput): OutboundAuth | undefined {
  if (!input.type) {
    if (input.credentialName) {
      throw new InputValidationError("--credential-name requires --outbound-auth oauth or api-key");
    }
    if (input.scopes) {
      throw new InputValidationError("--scope requires --outbound-auth oauth");
    }
    return undefined;
  }
  if (input.type === "none") {
    if (input.credentialName || input.scopes) {
      throw new InputValidationError(
        "--outbound-auth none cannot be combined with --credential-name or --scope",
      );
    }
    return { type: "NONE" };
  }
  if (!input.credentialName) {
    throw new InputValidationError(`--outbound-auth ${input.type} requires --credential-name`);
  }
  if (input.type === "api-key" && input.scopes) {
    throw new InputValidationError("--scope is valid only with --outbound-auth oauth");
  }

  const credential = project.spec.credentials.find(
    (candidate) => candidate.name === input.credentialName,
  );
  if (!credential) {
    throw new InputValidationError(
      `credential '${input.credentialName}' does not exist in credentials[]`,
    );
  }
  assertCredentialType(credential, input.type);
  return {
    type: input.type === "oauth" ? "OAUTH" : "API_KEY",
    credentialName: input.credentialName,
    scopes: input.type === "oauth" ? input.scopes : undefined,
  };
}

function assertCredentialType(credential: Credential, auth: "oauth" | "api-key"): void {
  const expected = auth === "oauth" ? "OAuthCredentialProvider" : "ApiKeyCredentialProvider";
  if (credential.authorizerType !== expected) {
    throw new InputValidationError(
      `credential '${credential.name}' is a ${credential.authorizerType}, not a ${expected}`,
    );
  }
}
