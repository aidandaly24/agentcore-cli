import type { BedrockAgentImportFramework } from "./types";

export function generateImportPyproject(input: {
  runtimeName: string;
  framework: BedrockAgentImportFramework;
  hasMemory: boolean;
  hasCodeInterpreter: boolean;
  hasKnowledgeBases: boolean;
}): string {
  // Compatible-release (`~=`) pinning, like the repository's scaffolded templates, bounded at the
  // level where the ecosystem allows breaking changes: `~= X.Y` for 1.0+ packages (minor upgrades
  // are safe, majors are not) and `~= X.Y.Z` below 1.0, where minors may break.
  //
  // Pinning a 1.0+ package to its patch series is actively wrong here: `langgraph ~= 1.0.2`
  // resolves to 1.0.10, whose bundled langgraph-prebuilt imports a symbol its own
  // langgraph.runtime does not export, so the generated agent fails at import.
  const dependencies = [
    "aws-opentelemetry-distro ~= 0.18.0",
    `bedrock-agentcore${input.hasMemory ? "[memory]" : ""} ~= 1.9`,
    "botocore[crt] ~= 1.43",
  ];

  if (input.framework === "strands") {
    dependencies.push("strands-agents ~= 1.15");
    if (input.hasCodeInterpreter) dependencies.push("strands-agents-tools ~= 0.1.0");
    // The scaffolded templates never import boto3 directly, so they do not declare it. The
    // generated knowledge-base tool does, and a direct import should not rely on a transitive.
    if (input.hasKnowledgeBases) dependencies.push("boto3 ~= 1.43");
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
