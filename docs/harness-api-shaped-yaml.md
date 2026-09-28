# Harness Project Configuration

[Back to README](../README.md) | [Legacy flat YAML](harness-project-configuration.md) | [Command reference](../command.md)

New Harness projects write `app/<name>/harness.yaml` using the Harness API's model, memory, tool, skill, and runtime-environment field names. The project also writes `system-prompt.md` next to it. `agentcore/agentcore.json` registers the Harness and its directory; the YAML configures that Harness.

```yaml
name: assistant
model:
  bedrockModelConfig:
    modelId: global.anthropic.claude-sonnet-4-6
tools: []
allowedTools: ["*"]
skills: []
memory:
  managedMemoryConfiguration: {}
truncation:
  strategy: sliding_window
environmentVariables: {}
tags: {}
```

`name` is the project's Harness name, not the physical service name; deployment composes the physical name from the project, target, and Harness names. After editing, run `agentcore deploy` from the project directory. A local edit does not update an already deployed Harness.

This format retains the CLI's project behavior: it creates the execution role when `executionRoleArn` is absent, discovers the sibling `system-prompt.md`, and can build a local `dockerfile`. Those are project inputs, not `CreateHarness` request fields. `tools` and `allowedTools` are top-level API fields, not children of `model`.

## Model and instructions

Choose exactly one model configuration under `model`:

| Model variant        | Required input         | Other supported options                                                        |
| -------------------- | ---------------------- | ------------------------------------------------------------------------------ |
| `bedrockModelConfig` | `modelId`              | `apiFormat`, `temperature`, `topP`, `maxTokens`                                |
| `openAiModelConfig`  | `modelId`, `apiKeyArn` | `apiFormat`, `temperature`, `topP`, `maxTokens`                                |
| `geminiModelConfig`  | `modelId`, `apiKeyArn` | `topK`, `temperature`, `topP`, `maxTokens`                                     |
| `liteLlmModelConfig` | `modelId`              | `apiKeyArn`, `apiBase`, `additionalParams`, `temperature`, `topP`, `maxTokens` |

`apiKeyArn` references an AgentCore Identity API-key credential provider, not the raw secret. `model.maxTokens` limits one model call; the top-level `maxTokens` limits the whole invocation. See [Harness models](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-models.html).

Edit `system-prompt.md` for instructions. To override it in YAML, supply one text block in the API shape:

```yaml
systemPrompt:
  - text: |
      You are a helpful assistant.
```

The CLI writes `--system-prompt` input to `system-prompt.md`, leaving this field absent. The inline text is literal, not a filename. Existing flat files keep their string-valued `systemPrompt`.

## Tools, access, and skills

`tools` declares additional tools; `allowedTools` filters the tools the model may choose. The latter is not an IAM policy. `["*"]` allows all available tools, including built-in tools.

```yaml
tools:
  - name: research
    type: remote_mcp
    config:
      remoteMcp:
        url: https://mcp.example.com/mcp
allowedTools:
  - "@builtin"
  - "@research/search"
```

Each tool type has its matching `config` variant. Browser and Code Interpreter can omit their configuration to use built-in resources. [Harness tools](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-tools.html) describes the other tool types and patterns.

`skills` names source locations, not tool permissions. Replace `skills: []` with any combination of these sources:

```yaml
skills:
  - awsSkills:
      paths: [core-skills/aws-serverless]
  - s3:
      uri: s3://my-bucket/skills/support/
  - git:
      url: https://github.com/example/skills.git
      path: skills/support
  - path: /opt/skills/local
```

For private Git skills, set `git.auth.credentialName` to a project credential or `git.auth.credentialArn` to an existing Identity credential provider. The Harness role must be able to read the credential. `path` alone refers to a directory inside the running environment; it does not upload local files. [Harness skills](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-skills.html) covers source behavior.

## Memory and context

Select one memory variant. The generated file chooses `managedMemoryConfiguration: {}`; omitting `memory` when editing an existing file disables it.

```yaml
# Managed memory with optional settings:
memory:
  managedMemoryConfiguration:
    strategies: [SEMANTIC, SUMMARIZATION]
    eventExpiryDuration: 30
```

To use a memory declared in this project, replace that block with:

```yaml
memory:
  agentCoreMemoryConfiguration:
    name: ConversationMemory
    messagesCount: 20
    retrievalConfig:
      topK: 5
```

`name` and the flat `retrievalConfig` are project conveniences. For an external memory, use `arn` instead of `name`; per-namespace retrieval tuning by ARN is not supported by the current project resolver. To disable memory explicitly, set `memory: { disabled: {} }`.

`truncation` controls what conversation history is sent to the model, not saved Memory events. The default scaffold selects `sliding_window`; use `config.slidingWindow.messagesCount` to tune it, or choose `summarization` or `none`. `maxIterations`, top-level `maxTokens`, and `timeoutSeconds` are optional per-invocation limits. [Harness limits](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-operations.html#harness-limits) describes service defaults.

## Environment and security

Omit `environment` and `environmentArtifact` for the service-provided PUBLIC environment. To use a pre-built ECR image:

```yaml
environmentArtifact:
  containerConfiguration:
    containerUri: 123456789012.dkr.ecr.us-west-2.amazonaws.com/my-harness:latest
```

To use VPC networking or runtime-session settings, replace the sample IDs and supply `environment`:

```yaml
environment:
  agentCoreRuntimeEnvironment:
    networkConfiguration:
      networkMode: VPC
      networkModeConfig:
        subnets: [subnet-0123456789abcdef0]
        securityGroups: [sg-0123456789abcdef0]
    lifecycleConfiguration:
      idleRuntimeSessionTimeout: 900
      maxLifetime: 28800
    filesystemConfigurations:
      - sessionStorage:
          mountPath: /mnt/session
      - efsAccessPoint:
          accessPointArn: arn:aws:elasticfilesystem:us-west-2:123456789012:access-point/fsap-0123456789abcdef0
          mountPath: /mnt/data
```

EFS and S3 Files mounts require VPC mode and unique paths under `/mnt`. The file supports up to two mounts of each type. S3 Files uses the `s3FilesAccessPoint` variant with an `arn:aws:s3files:...` access point ARN. Network egress and execution-role permissions must also allow access to models, tool endpoints, and skill sources.

For a local container build, use `dockerfile: Dockerfile` instead of `environmentArtifact`. The path is relative to this Harness directory. A Dockerfile build in VPC mode also needs the CodeBuild VPC ID, which the Harness API does not accept. Keep that project-only input separate:

```yaml
dockerfile: Dockerfile
networkConfig:
  vpcId: vpc-0123456789abcdef0
```

Omitting `authorizerConfiguration` uses AWS IAM for callers. For JWT authentication, supply the API-shaped variant:

```yaml
authorizerConfiguration:
  customJWTAuthorizer:
    discoveryUrl: https://id.example.com/.well-known/openid-configuration
    allowedAudience: [my-harness-app]
```

Caller authorization is distinct from permissions on the Harness execution role. Deployment creates a role unless you supply `executionRoleArn`; a supplied role must already have the required permissions. Environment variable values are stored in plaintext: use Identity credentials, not `environmentVariables`, for secrets.

## Existing files

The CDK project reader and CLI export continue accepting [legacy flat Harness files](harness-project-configuration.md), including `model.provider`, `memory.mode`, and `networkMode`. Neither build nor export rewrites an existing file or removes its comments. New files use the API-shaped form; do not combine the two model or memory formats in one file. The new form rejects unknown root and model-variant keys instead of silently discarding them.
