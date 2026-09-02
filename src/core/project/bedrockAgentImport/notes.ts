import type { BedrockAgentImportNote, BedrockAgentSnapshot } from "./types";

export const IMPORT_NOTES_FILE = "IMPORT_NOTES.md";

export function renderImportNotes(
  snapshot: BedrockAgentSnapshot,
  notes: BedrockAgentImportNote[],
): string {
  const lines = [
    "# Bedrock Agent Import Notes",
    "",
    `Source agent: \`${snapshot.agentName}\` (\`${snapshot.sourceAgentId}\`)`,
    `Source version: \`${snapshot.sourceAgentVersion}\``,
    "",
    "The generated application is an editable translation of the selected Bedrock Agent version.",
    "It does not invoke the source agent alias at runtime.",
    "",
  ];

  if (notes.length === 0) {
    lines.push("No manual follow-up was identified.");
    return `${lines.join("\n")}\n`;
  }

  lines.push("## Manual Follow-up", "");
  for (const note of notes) {
    lines.push(`- **${note.category}:** ${note.message}`);
  }
  return `${lines.join("\n")}\n`;
}
