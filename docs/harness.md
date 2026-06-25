# Harness

A harness is a **declarative agent**: you describe a runtime, model, tools, skills, memory, and observability in one
config, and the CLI builds the infrastructure for you — no agent code required. When you are ready to own the code, you
`export` the harness into a deployable Strands Python agent that you can edit, run locally, and deploy like any other
agent in the project.

A harness is the right tool when you want to stand up a working agent from configuration alone. An exported agent is the
right tool when you want to customize behavior in Python.

## Command surface

| Command          | Description                                                                |
| ---------------- | -------------------------------------------------------------------------- |
| `add harness`    | Add a harness resource (runtime + model + memory)                          |
| `add tool`       | Add a tool to a harness (`--harness <name> --type <type> --name <name>`)   |
| `add skill`      | Add a skill to a harness (`--harness <name>` + `--path` / `--s3` / `--git`)|
| `export harness` | Export a harness config to a deployable Strands Python agent under `app/`  |
| `remove harness` | Remove a harness and its `app/<name>/` directory                           |

Run `agentcore add harness --help` (and the same for `add tool`, `add skill`, `export harness`) for the full,
authoritative flag list.

## Config model

A harness is declared in `agentcore/agentcore.json` under `harnesses`, with its supporting files (system prompt,
optional Dockerfile, skill sources) on disk under `app/<harnessName>/`:

```
agentcore/
  agentcore.json            # the harnesses[] entry lives here
  app/
    <harnessName>/
      system-prompt.md      # the agent's system prompt (defaults to "You are a helpful assistant")
      ...                   # optional Dockerfile, skill directories, assets
```

The harness entry bundles, in one place:

- **Runtime + model** — provider (`bedrock`, `open_ai`, `gemini`, `lite_llm`), model ID, API format, and sampling
  controls (`--temperature`, `--top-p`, `--top-k`, `--model-max-tokens`).
- **Memory** — disabled by default; opt in with `--memory-mode managed` (and `--memory-strategies`) for a new managed
  store, or `--memory-mode existing` with `--memory-name` / `--memory-arn` to reuse one.
- **Execution limits** — `--max-iterations`, `--max-tokens`, `--timeout`, `--truncation-strategy`, plus runtime
  lifecycle controls (`--idle-timeout`, `--max-lifetime`).
- **Networking** — `--network-mode PUBLIC|VPC` with `--subnets` / `--security-groups` for VPC mode.
- **Observability** — emitted automatically; no extra config needed.

### Add a harness

```bash
# 1. Create a project
agentcore create --name MyProject --defaults
cd MyProject

# 2. Add a harness (runtime + model + memory in one config)
agentcore add harness \
  --name support_bot \
  --model-provider bedrock \
  --model-id anthropic.claude-3-5-sonnet-20240620-v1:0
```

### Add tools

Tools are attached to a harness by name. Supported types are `agentcore_browser`, `agentcore_code_interpreter`,
`remote_mcp`, `agentcore_gateway`, and `inline_function`:

```bash
# A managed AgentCore browser tool
agentcore add tool --harness support_bot --type agentcore_browser --name browser

# A remote MCP server
agentcore add tool --harness support_bot --type remote_mcp --name docs --url https://mcp.example.com

# A project gateway (resolves the ARN from deployed state)
agentcore add tool --harness support_bot --type agentcore_gateway --name docs-gw --gateway my-gateway
```

### Add skills

Skills add reusable capabilities to a harness from a local path, an S3 URI, or a git repository:

```bash
# From an installed skill on disk
agentcore add skill --harness support_bot --path ./skills/refunds

# From S3
agentcore add skill --harness support_bot --s3 s3://my-bucket/skills/refunds

# From a git repo (optionally a subdirectory + auth credential)
agentcore add skill --harness support_bot --git https://github.com/org/skills --git-path refunds
```

## Export → Strands agent

`export harness` turns a harness config into a deployable Strands Python agent under `app/<targetAgentName>/`. This is a
one-way step: it generates code you own, then registers it in `agentcore.json` so the rest of the project lifecycle
(`dev`, `deploy`, `invoke`) treats it like any other agent.

```bash
agentcore export harness --name support_bot
# generated runtime agent defaults to support_botAgent (override with --target-agent-name)
```

What the export does:

1. Reads the harness config from `agentcore/agentcore.json` and its files under `app/<harnessName>/`.
2. Maps it to the Strands template and renders the Python agent into `app/<targetAgentName>/`.
3. Adds the generated agent (and any required credentials) to `agentcore/agentcore.json`.
4. Writes `app/<targetAgentName>/EXPORT_NOTES.md`.

After a successful export:

```
app/<targetAgentName>/    Python agent (Strands)
agentcore/agentcore.json  updated with the new runtime agent
EXPORT_NOTES.md           review for manual follow-up items
```

Use `--build CodeZip` (default) or `--build Container` to choose how the exported agent is packaged. Container builds
also generate a `uv.lock`; if `uv` is not installed, the export records a follow-up note instead of failing.

## Read `EXPORT_NOTES.md` before you deploy

> After `export harness`, **read `app/<targetAgentName>/EXPORT_NOTES.md` before running `agentcore deploy`.**

The exporter automates as much as it safely can, but some steps depend on choices it cannot make for you — a custom
Dockerfile that needs the agent build layer appended, a referenced Dockerfile that does not exist yet, a missing AWS
deployment target, or a `uv.lock` that still needs generating. Every item the exporter could not automate is written to
`EXPORT_NOTES.md`. A clean export produces:

```
No manual steps required.
```

Otherwise the file lists each item under **Items requiring manual follow-up**. Complete every item before running
`agentcore deploy`, then proceed like any other agent:

```bash
cat app/support_botAgent/EXPORT_NOTES.md   # read this first
agentcore dev                              # run the exported agent locally
agentcore deploy                           # deploy to AWS
```

## See also

- [Memory](memory.md) — strategies available to a harness via `--memory-mode managed`
- [Gateway](gateway.md) — gateways usable as `agentcore_gateway` tools
- [Frameworks](frameworks.md) — the Strands runtime the exporter targets
- [Container Builds](container-builds.md) — `--build Container` packaging
