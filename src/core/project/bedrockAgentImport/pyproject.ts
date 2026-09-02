import type { BedrockAgentImportFramework } from "./types";

export function generateImportPyproject(input: {
  runtimeName: string;
  framework: BedrockAgentImportFramework;
  hasMemory: boolean;
  hasCodeInterpreter: boolean;
}): string {
  // Pinned to the minor, not the patch, unlike the scaffolded templates: `langgraph ~= 1.0.2`
  // resolves to 1.0.10, whose langgraph-prebuilt fails to import, generating a broken project.
  const dependencies = [
    "aws-opentelemetry-distro ~= 0.18.0",
    `bedrock-agentcore${input.hasMemory ? "[memory]" : ""} ~= 1.9`,
    "boto3 ~= 1.43",
    "botocore[crt] ~= 1.43",
  ];

  if (input.framework === "strands") {
    dependencies.push("strands-agents ~= 1.15");
    // 0.1.x caps strands-agents below 1.0 and ships no code_interpreter module, so it cannot be
    // resolved alongside strands-agents 1.x.
    if (input.hasCodeInterpreter) dependencies.push("strands-agents-tools ~= 0.2.16");
  } else {
    dependencies.push(
      "langchain ~= 1.0",
      "langchain-aws ~= 1.0",
      "langgraph ~= 1.0",
      "opentelemetry-instrumentation-langchain ~= 0.59.0",
    );
  }

  return `[build-system]
requires = ["hatchling ~= 1.27"]
build-backend = "hatchling.build"

[project]
name = "${pythonPackageName(input.runtimeName)}"
version = "0.1.0"
requires-python = ">=3.10"
dependencies = [
${dependencies.map((dependency) => `    "${dependency}",`).join("\n")}
]

[tool.hatch.build.targets.wheel]
packages = ["."]
`;
}

function pythonPackageName(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "") || "imported-agent"
  );
}
