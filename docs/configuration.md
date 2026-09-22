# Configuration

[Back to README](../README.md) | [Command reference](../command.md)

## Harness Project Files

`project create` (without `--template`) and `project add harness` share the same
scaffolding flow. Each harness has `app/<name>/harness.yaml` and
`app/<name>/system-prompt.md`. YAML is the harness configuration format.
The YAML contains the supplied settings and
commented optional examples. Tools are opt-in. Newly scaffolded harnesses
explicitly use `memory: { mode: managed }` unless another memory configuration
was supplied. Reading an existing file with no `memory` setting still means
disabled memory; reading never adds the scaffold default.

```yaml
name: assistant
model:
  provider: bedrock
  modelId: global.anthropic.claude-sonnet-4-6
# Instructions come from system-prompt.md unless systemPrompt is set inline.
# systemPrompt: You are a helpful assistant.
memory:
  mode: managed
```

Both deployment and local export use inline `systemPrompt` text when it is
provided. Otherwise, instructions come from `system-prompt.md` next to
`harness.yaml`. Prompt contents are not trimmed, and blank prompts are rejected.
Prompt settings do not resolve local file references.

```yaml
systemPrompt: |
  You are a concise assistant.
truncation:
  strategy: summarization
  config:
    summarization:
      summarizationSystemPrompt: Keep decisions and open questions.
```

`project add harness --system-prompt "Your instructions"` writes the supplied
text to `system-prompt.md`, leaving `systemPrompt` out of the generated YAML.
Summary instructions in
`truncation.config.summarization.summarizationSystemPrompt` are inline text.

Skill paths refer to the **runtime/container filesystem**,
not local files to package. Other fields do not support local includes.
Malformed YAML, duplicate keys, and schema violations fail the read.
Unknown fields at the harness root and directly inside `model` are stripped
from the parsed configuration. Nested configurations use their own validation
schemas. Free-form
maps such as headers, tags, environment variables, `additionalParams`, and
`inputSchema` still accept arbitrary keys.
Build, deploy, and export do not rewrite harness YAML or remove its comments.
`agentcore.json` is the version-2 project registry. Deployment targets,
JSON CLI flags/output, and service payloads do not use YAML.

## Source-Aware Flags

Source-aware values: any field flag documented as such accepts the value inline,
`file://<path>` to read it from a file, or `-` to read it from stdin (the AWS CLI
`file://` convention). A command reads stdin from at most one flag. For example,
`--instructions file://order-quality.txt` or `--instructions -`.

## Project Credentials

Project credentials: a `credentials[]` entry in `agentcore.json` is named by its
spec name and keeps its secret in `agentcore/.env.local` under
`AGENTCORE_CREDENTIAL_<NAME>` (with a field suffix for OAuth2 and payment
values). `project deploy` provisions the Identity credential provider before
synth under the name `<project>_<target>_<credential>`, so two targets in one
account and region get separate providers, and records its ARN in
`deployed-state.json` under the spec name. A credential removed from the spec
has its provider deleted on the next deploy of each target, after the stack
update. Tearing a target down (deploying a spec with nothing left to deploy,
which is where `project remove all` leads) deletes every provider the target
owns: API key, OAuth2 and payment.

Providers not recorded as owned by a deployment target are not removed by
project deploys or teardowns. Delete unused providers explicitly with
`agentcore identity api-key-credential-provider
delete --name <credential>`, the `oauth2-credential-provider` equivalent, or
`aws bedrock-agentcore-control delete-payment-credential-provider` once nothing
else uses them.

## Global Settings

`config` reads and persists global settings. For example,
`agentcore config telemetry.enabled false` disables usage telemetry.
