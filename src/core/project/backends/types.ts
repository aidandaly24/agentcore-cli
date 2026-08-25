import type {
  DeployResult,
  Project,
  ProjectEvent,
  ProjectInvokableResource,
} from "../../../handlers/project/types";
import type { AwsDeploymentTarget } from "../../../projectSchemas/aws-targets";

export type DeployBackendInput = {
  /** Fully resolved account and region selected from aws-targets.json. */
  target: AwsDeploymentTarget;
};

export type ResolveDeployedResourceBackendInput = {
  target: AwsDeploymentTarget;
  resourceType: ProjectInvokableResource;
  name: string;
};

/** Builds the deployable artifacts owned by a project's selected backend. */
export interface ProjectBackend {
  build(project: Project): AsyncGenerator<ProjectEvent, void>;
  deploy(project: Project, input: DeployBackendInput): AsyncGenerator<ProjectEvent, DeployResult>;
  resolveDeployedResource(
    project: Project,
    input: ResolveDeployedResourceBackendInput,
  ): Promise<string>;
}
