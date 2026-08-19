import { InputValidationError } from "../../../../errors";
import type { AgentCoreGatewayTarget, ConnectorId } from "../../../../projectSchemas/gateway";

export function connectorTargetFromShortcut(
  name: string,
  connectorId: ConnectorId,
  knowledgeBase?: string,
): AgentCoreGatewayTarget {
  switch (connectorId) {
    case "web-search":
      return {
        name,
        targetType: "connector",
        connectorId,
        configurations: [{ name: "WebSearch", parameterValues: { maxResults: 10 } }],
      };
    case "bedrock-knowledge-bases":
      if (!knowledgeBase) {
        throw new InputValidationError(
          "--connector bedrock-knowledge-bases requires --knowledge-base",
        );
      }
      return {
        name,
        targetType: "connector",
        connectorId,
        configurations: [{ name: "Retrieve", parameterValues: { knowledgeBaseId: knowledgeBase } }],
      };
  }
}

export function httpsEndpoint(value: string, option: string): string {
  try {
    if (new URL(value).protocol !== "https:") {
      throw new InputValidationError(`${option} must use HTTPS`);
    }
  } catch (error) {
    if (error instanceof InputValidationError) throw error;
    throw new InputValidationError(`${option} must be a valid HTTPS URL`, { cause: error });
  }
  return value;
}
