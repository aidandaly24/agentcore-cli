import type { BedrockAgentImportFramework } from "./types";

export function generateImportPyproject(input: {
  runtimeName: string;
  framework: BedrockAgentImportFramework;
  hasMemory: boolean;
  hasCodeInterpreter: boolean;
}): string {
  const dependencies = [
    "aws-opentelemetry-distro",
    `bedrock-agentcore${input.hasMemory ? "[memory]" : ""} >= 1.9.1`,
    "boto3 >= 1.38.0",
    "botocore[crt] >= 1.35.0",
  ];

  if (input.framework === "strands") {
    dependencies.push("strands-agents >= 1.13.0");
    if (input.hasCodeInterpreter) dependencies.push("strands-agents-tools >= 0.2.16");
  } else {
    dependencies.push(
      "langchain >= 1.0.3",
      "langchain-aws >= 1.0.0",
      "langgraph >= 1.0.2",
      "opentelemetry-instrumentation-langchain >= 0.59.0",
    );
  }

  return `[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[project]
name = "${pythonPackageName(input.runtimeName)}"
version = "0.1.0"
requires-python = ">=3.12"
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
