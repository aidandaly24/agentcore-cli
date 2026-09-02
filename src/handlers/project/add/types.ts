import type { AppIO } from "../../../io";
import type { CoreBedrockAgentImporter } from "../../../core/project/bedrockAgentImport";
import type { ProjectManager } from "../types";

export type AddProjectResourceConfig = {
  projectManager: ProjectManager;
  io: AppIO;
  bedrockAgentImporter: CoreBedrockAgentImporter;
};
