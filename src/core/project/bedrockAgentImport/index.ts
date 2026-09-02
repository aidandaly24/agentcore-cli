import { InputValidationError } from "../../../errors";
import { LangGraphBedrockAgentTranslator } from "./langGraphTranslator";
import { BedrockAgentSnapshotLoader, type CreateBedrockAgentClient } from "./loader";
import { StrandsBedrockAgentTranslator } from "./strandsTranslator";
import {
  BEDROCK_AGENT_IMPORT_REGIONS,
  type BedrockAgentImportPlan,
  type BedrockAgentImportRequest,
  type CoreBedrockAgentImporter,
} from "./types";

type BedrockAgentImporterConfig = {
  createClient?: CreateBedrockAgentClient;
};

export class BedrockAgentImporter implements CoreBedrockAgentImporter {
  private readonly loader: BedrockAgentSnapshotLoader;

  constructor(config: BedrockAgentImporterConfig = {}) {
    this.loader = new BedrockAgentSnapshotLoader(config.createClient);
  }

  async import(request: BedrockAgentImportRequest): Promise<BedrockAgentImportPlan> {
    const region = BEDROCK_AGENT_IMPORT_REGIONS.find((candidate) => candidate === request.region);
    if (!region) {
      throw new InputValidationError(
        `'${request.region}' is not a supported Bedrock Agent region for import. ` +
          `Supported regions: ${BEDROCK_AGENT_IMPORT_REGIONS.join(", ")}. ` +
          "Pass --region <region> to select the source agent's region.",
      );
    }

    const snapshot = await this.loader.load({
      region,
      agentId: request.agentId,
      agentAliasId: request.agentAliasId,
    });
    return request.framework === "strands"
      ? new StrandsBedrockAgentTranslator(snapshot, request).translate()
      : new LangGraphBedrockAgentTranslator(snapshot, request).translate();
  }
}

export * from "./types";
