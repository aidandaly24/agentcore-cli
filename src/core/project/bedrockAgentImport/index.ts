import { InputValidationError } from "../../../errors";
import { LangGraphBedrockAgentTranslator } from "./langGraphTranslator";
import { BedrockAgentSnapshotLoader, type CreateBedrockAgentClient } from "./loader";
import { StrandsBedrockAgentTranslator } from "./strandsTranslator";
import {
  BEDROCK_AGENT_IMPORT_REGIONS,
  type BedrockAgentImportPlan,
  type BedrockAgentImportRequest,
  type BedrockAgentTranslator,
  type CoreBedrockAgentImporter,
} from "./types";

type BedrockAgentImporterConfig = {
  createClient?: CreateBedrockAgentClient;
  translators?: Partial<Record<BedrockAgentImportRequest["framework"], BedrockAgentTranslator>>;
};

export class BedrockAgentImporter implements CoreBedrockAgentImporter {
  private readonly loader: BedrockAgentSnapshotLoader;
  private readonly translators?: BedrockAgentImporterConfig["translators"];

  constructor(config: BedrockAgentImporterConfig = {}) {
    this.loader = new BedrockAgentSnapshotLoader(config.createClient);
    this.translators = config.translators;
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
    const translator =
      this.translators?.[request.framework] ??
      (request.framework === "strands"
        ? new StrandsBedrockAgentTranslator(snapshot, request)
        : new LangGraphBedrockAgentTranslator(snapshot, request));
    return translator.translate(snapshot, request);
  }
}

export * from "./types";
