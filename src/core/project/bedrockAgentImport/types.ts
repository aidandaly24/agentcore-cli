import z from "zod";

export const BEDROCK_AGENT_IMPORT_REGIONS = [
  "ap-northeast-1",
  "ap-northeast-2",
  "ap-south-1",
  "ap-southeast-1",
  "ap-southeast-2",
  "ca-central-1",
  "eu-central-1",
  "eu-central-2",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "sa-east-1",
  "us-east-1",
  "us-east-2",
  "us-gov-west-1",
  "us-west-2",
] as const;

export const BedrockAgentImportFrameworkSchema = z.enum(["strands", "langgraph"]);
export type BedrockAgentImportFramework = z.infer<typeof BedrockAgentImportFrameworkSchema>;

export const BedrockAgentImportMemorySchema = z.enum(["none", "shortTerm", "longAndShortTerm"]);
export type BedrockAgentImportMemory = z.infer<typeof BedrockAgentImportMemorySchema>;

export type BedrockAgentImportRequest = {
  runtimeName: string;
  region: string;
  agentId: string;
  agentAliasId: string;
  framework: BedrockAgentImportFramework;
  memory: BedrockAgentImportMemory;
};

export type ImportedInferenceConfiguration = {
  temperature?: number;
  topP?: number;
  topK?: number;
  maximumLength?: number;
  stopSequences?: string[];
};

export type ImportedFunctionParameter = {
  type: string;
  description?: string;
  required: boolean;
};

export type ImportedFunction = {
  name: string;
  description?: string;
  parameters: Record<string, ImportedFunctionParameter>;
};

export type ImportedActionGroup = {
  name: string;
  description?: string;
  parentActionSignature?: string;
  functions: ImportedFunction[];
  hasApiSchema: boolean;
  hasLambdaExecutor: boolean;
  returnsControl: boolean;
};

export type ImportedKnowledgeBase = {
  id: string;
  name: string;
  description?: string;
  arn?: string;
};

export type ImportedGuardrail = {
  identifier: string;
  version: string;
};

export type ImportedCollaborator = {
  name: string;
  instruction: string;
  relayConversationHistory?: string;
  agent: BedrockAgentSnapshot;
};

export type BedrockAgentSnapshot = {
  region: string;
  sourceAgentId: string;
  sourceAgentVersion: string;
  agentName: string;
  description?: string;
  foundationModel: string;
  instruction: string;
  inferenceConfiguration?: ImportedInferenceConfiguration;
  hasPromptOverrides: boolean;
  guardrail?: ImportedGuardrail;
  sourceMemoryEnabled: boolean;
  actionGroups: ImportedActionGroup[];
  knowledgeBases: ImportedKnowledgeBase[];
  collaborators: ImportedCollaborator[];
  notes: BedrockAgentImportNote[];
};

export const BedrockAgentImportNoteSchema = z.object({
  category: z.string().min(1),
  message: z.string().min(1),
});
export type BedrockAgentImportNote = z.infer<typeof BedrockAgentImportNoteSchema>;

export const BedrockAgentImportPlanSchema = z.object({
  framework: BedrockAgentImportFrameworkSchema,
  sourceAgentId: z.string().min(1),
  sourceAgentAliasId: z.string().min(1),
  sourceAgentVersion: z.string().min(1),
  description: z.string().optional(),
  files: z.record(z.string().min(1), z.string()),
  notes: z.array(BedrockAgentImportNoteSchema),
});
export type BedrockAgentImportPlan = z.infer<typeof BedrockAgentImportPlanSchema>;

export interface CoreBedrockAgentImporter {
  import(request: BedrockAgentImportRequest): Promise<BedrockAgentImportPlan>;
}
