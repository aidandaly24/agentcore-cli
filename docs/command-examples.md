# Command Examples

[Back to README](../README.md) | [Command reference](../command.md)

Examples are independent. Replace angle-bracket placeholders with your resource
identifiers before running them. For detailed invocation and configuration
behavior, see [Runtime](runtime.md), [Gateway](gateway.md),
[Payments](payments.md), and [Configuration](configuration.md).

## Project Workflows

### Create a Project

The default is a managed Harness project configured by specification, without
model-loop code to maintain:

```bash
agentcore project create --name MyAssistant
cd MyAssistant && agentcore project deploy
agentcore project invoke harness --prompt "hello"
```

Run `agentcore project create` bare in a terminal for the guided wizard
(name, Harness or template, confirmation), which drives the same creation path.

### Runtime Templates

Select a template to scaffold Runtime code. `agent-python-strands` and its
container variant accept `--model-provider` and `--api-key`.
`agent-python-strands-container` provides a container build; other templates
are CodeZip-only. Use `empty` for a project with no Runtime or Harness.
Each command below is an alternative and runs from outside an existing project:

```bash
agentcore project create --name MyAgent --template agent-python-strands
# The same Strands agent built as a container image, with a Dockerfile.
agentcore project create --name MyAgent --template agent-python-strands-container
# A LangChain agent on Bedrock, built with create_agent.
agentcore project create --name MyAgent --template agent-python-langchain
```

### Import a Bedrock Agent

Translate an existing Amazon Bedrock Agent version into editable Runtime code
with `project add runtime --type import` from inside a project. The selected
alias identifies the immutable source version; generated code invokes models
and translated tools directly rather than proxying the alias. Use `--framework`
`strands` (default) or `langgraph`. The alias must point at a prepared version,
not the mutable DRAFT that the built-in test alias (`TSTALIASID`) routes to.
Anything that could not be translated is listed in the generated `IMPORT_NOTES.md`.

```bash
agentcore project add runtime --name MyImportedAgent --type import \
  --agent-id A1B2C3D4E5 --agent-alias-id XYZ123ABC4 --region us-east-1 \
  --framework strands
```

### Export a Harness

`project export harness` "ejects" a harness to code you own: it renders a
Python Strands agent under `app/<target-agent-name>/` mapping the harness spec
(model, system prompt, tools, skills, memory, execution limits), registers the
new runtime in `agentcore.json` (the harness entry stays), and writes an
`EXPORT_NOTES.md` in the agent directory listing anything that could not be
mapped mechanically. Pass `--name <harness>` for an in-project harness or
`--arn <harnessArn>` to fetch a deployed one (the fetch uses the region
embedded in the ARN); `--target-agent-name` overrides the default
`<harnessName>Agent`. The exported agent is always a `CodeZip` runtime: it
declares its own dependencies, so it needs no image build. If the harness used a
pre-built container image or a custom Dockerfile, that is reported in
`EXPORT_NOTES.md` rather than rebuilt. Path-based skills are not supported,
since the exported agent has no container filesystem to read them from.

### Invoke a Project Resource

Run `agentcore project invoke` from inside a project to choose a deployed
Runtime or Harness interactively. Headless invocation keeps each resource's
existing input contract:

```bash
agentcore project invoke runtime \
  --name checkout \
  --payload '{"prompt":"Check order 123."}' \
  --content-type application/json

agentcore project invoke harness \
  --name support \
  --prompt "Help with my account."
```

Use `--target` to select a deployment target. When a project declares exactly
one resource of the requested type, `--name` may be omitted.

### Inspect Project Logs

Project logging resolves a logical resource name through the selected
deployment target, so physical IDs and deployment regions do not need to be
supplied:

```bash
agentcore project log runtime
agentcore project log runtime --name checkout --target production
agentcore project log runtime --name checkout --since 1h --level error
agentcore project log harness
agentcore project log harness --name support --target production
agentcore project log harness --name support --since 1h --level error
```

When the project declares exactly one resource of the requested type, `--name`
may be omitted. For Harnesses, the CLI also resolves the managed Harness to its
underlying Runtime before reading CloudWatch. Use the imperative
`agentcore runtime logs` or `agentcore harness logs` commands when addressing a
physical resource directly or working outside a project.

### Inspect Project Traces

Project tracing uses the same logical resource and deployment target
resolution, then lists or downloads traces from the resolved Runtime's
deployment region:

```bash
agentcore project traces runtime list
agentcore project traces runtime list --name checkout --target production --since 30m
agentcore project traces runtime get <traceId> --name checkout --output trace.json
agentcore project traces harness list
agentcore project traces harness list --name support --target production --since 30m
agentcore project traces harness get <traceId> --name support --output trace.json
```

When the project declares exactly one resource of the requested type, `--name`
may be omitted. For Harnesses, the CLI resolves the underlying Runtime before
querying its traces. Use the imperative `agentcore runtime traces` or
`agentcore harness traces` commands when addressing a physical resource
directly or working outside a project.

```bash
# Resolve project resources by logical name and deployment target
agentcore project log harness --name support --target production --since 1h
agentcore project traces runtime list --name checkout --target production --since 30m
agentcore project traces runtime get <traceId> --name checkout --output trace.json
agentcore project traces harness list --name support --target production --since 30m
agentcore project traces harness get <traceId> --name support --output trace.json
```

### Linked Resource Views

A bare `project status` opens a Linked Resources view that groups the project's
resources by agent and forwards to each deployed resource's detail page.
The harness hub (`harness get`) ends with the same kind of Linked Resources tree
for the Runtime, Memory, Gateway, Browser, Code Interpreter and
credential providers wired to that harness, each opening in its own region.

### Remove Project Resources

Removal updates the project specification and keeps code under `app/`.
Deploy the project afterward to apply resource removals in AWS. For credential
provider cleanup and target teardown behavior, see
[Project Credentials](configuration.md#project-credentials).

```bash
# Remove resources from a project's spec (run inside the project)
agentcore project remove memory --name recall
agentcore project remove credential --name svc-key   # also deletes its .env.local entries
agentcore project remove gateway-target --gateway tools --name search
agentcore project remove all                         # y/N prompt; empties every collection
agentcore project remove all --yes                   # non-interactive
```

## Harness

```bash
# Create a harness; a default execution role is created for you.
agentcore harness create \
  --name my-agent \
  --system-prompt "You are a helpful assistant." \
  --model '{"bedrockModelConfig":{"modelId":"us.anthropic.claude-sonnet-4-5-20250929-v1:0"}}' \
  --json

# List and inspect
agentcore harness list --json
agentcore harness get --id <harnessId> --json

# One-shot prompt (buffers the service stream, then prints the completed transcript as JSON)
agentcore harness invoke --id <harnessId> --prompt "Summarize this repo." --json

# Interactive chat (no --prompt): opens the TUI chat at that harness/session
agentcore harness invoke --id <harnessId>
agentcore harness invoke --id <harnessId> --session-id <session> --qualifier PROD

# Run a shell command inside the agent runtime
agentcore harness exec --id <harnessId> --command "ls -la" --json
```

## Memory

```bash
# Inspect AgentCore Memories without project configuration or deployment
agentcore memory get --id <memoryId>
agentcore memory get --id <memoryId> --view without_decryption
agentcore memory list --max-results 20
agentcore memory event get --id <memoryId> --actor-id <actorId> --session-id <sessionId> --event-id <eventId>
agentcore memory event list --id <memoryId> --actor-id <actorId> --session-id <sessionId> --max-results 20
agentcore memory record get --id <memoryId> --record-id <recordId>
agentcore memory record list --id <memoryId> --namespace <namespace> --max-results 20
```

### Runtime and Memory Menus

Bare Runtime branches and leaves, plus `memory`, `memory get`, and `memory list`,
require a TTY on stdin and stdout.
The Runtime and Memory menus include a TUI-only `create` entry that explains
their project-based creation flow. It points to `project create` and the
matching `project add` command without adding unsupported imperative
`runtime create` or `memory create` commands.
For Runtime Invoke, supplying a payload or headless-only request or output flags
runs headlessly; `--session-id` can instead seed the persistent console.
Supplying Memory operation flags runs those commands headlessly, and `--json`
always suppresses TUI rendering. The `memory event`, `memory record`,
`memory actor`, and `memory session` groups open interactive menus when run
bare in a terminal; their supported leaves provide scoped selection flows.
Headless calls require the resource selectors shown by each command's help.

```bash
agentcore runtime
agentcore runtime list
agentcore runtime get
agentcore runtime version list
agentcore runtime endpoint list
agentcore memory
agentcore memory list
agentcore memory get
agentcore memory event
agentcore memory record
agentcore memory actor
agentcore memory session
```

## Identity

```bash
# Manage API key credential providers
agentcore identity api-key-credential-provider create --name my-provider --api-key <key>
agentcore identity api-key-credential-provider get --name my-provider
agentcore identity api-key-credential-provider list --max-results 10
agentcore identity api-key-credential-provider update --name my-provider --api-key <new-key>
agentcore identity api-key-credential-provider delete --name my-provider

# Manage OAuth2 credential providers (guided Custom OAuth2, or --provider-configuration for other vendors)
agentcore identity oauth2-credential-provider create \
  --name my-oauth-provider \
  --vendor CustomOauth2 \
  --client-id <client-id> \
  --discovery-url https://issuer.example.com/.well-known/openid-configuration \
  --client-secret -
agentcore identity oauth2-credential-provider get --name my-oauth-provider
agentcore identity oauth2-credential-provider list --max-results 10
agentcore identity oauth2-credential-provider delete --name my-oauth-provider
```

The Identity TUI is read-only: bare `identity` branches and the `get`/`list`
leaves open interactive menus and detail views. Mutations (`create`, `update`,
`delete`) remain available through the CLI and are omitted from the TUI menus.

```bash
agentcore identity
agentcore identity api-key-credential-provider list
agentcore identity api-key-credential-provider get
agentcore identity oauth2-credential-provider list
agentcore identity oauth2-credential-provider get
```

## Evaluators

```bash
# Manage evaluators
# Create an LLM-as-a-Judge evaluator with a rating-scale preset.
agentcore eval evaluator llm-as-a-judge create \
  --name order-support-quality \
  --level SESSION \
  --model us.anthropic.claude-sonnet-4-5-20250929-v1:0 \
  --instructions "Judge from {context} whether the order-support agent answered correctly." \
  --rating-scale 1-5-quality \
  --json

# Create a code-based (Lambda-backed) evaluator; timeout defaults to the service value.
agentcore eval evaluator code-based create \
  --name refund-policy-compliance \
  --level SESSION \
  --lambda-arn arn:aws:lambda:us-west-2:123456789012:function:refund-policy \
  --json

# Get, list, delete.
agentcore eval evaluator get --id <evaluatorId> --json
agentcore eval evaluator list --max-results 20 --json
agentcore eval evaluator delete --id <evaluatorId> --json
```
