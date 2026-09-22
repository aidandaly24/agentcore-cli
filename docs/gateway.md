# Gateway

[Back to README](../README.md) | [Command reference](../command.md#gateway-commands)

For project resource names and deployment targets, see
[command examples](command-examples.md#project-workflows).

## Inspect Gateways and Generate Policies

```bash
# Inspect Gateway resources without project configuration or deployment
agentcore gateway get --id <gatewayId>
agentcore gateway list --max-results 20
agentcore gateway invoke --id <gatewayId> --payload file://request.json
agentcore gateway invoke --id <gatewayId> # open the persistent JSON console
agentcore gateway target get --gateway-id <gatewayId> --target-id <targetId>
agentcore gateway target list --gateway-id <gatewayId> --max-results 20
agentcore gateway connector get --gateway-id <gatewayId> --id <targetId>
agentcore gateway connector list --gateway-id <gatewayId> --max-results 20
agentcore gateway rule get --gateway-id <gatewayId> --rule-id <ruleId>
agentcore gateway rule list --gateway-id <gatewayId> --max-results 20
agentcore gateway policy generate --gateway-id <gatewayId> --prompt "forbid IAM callers from every tool"
agentcore gateway policy generate --gateway-id <gatewayArn> --prompt file://policy.txt --json
# Pipe the generated Cedar into a project (run inside the project)
agentcore gateway policy generate --gateway-id <gatewayId> --prompt "..." \
  | agentcore project add policy --engine Guardrails --name Generated --statement -
```

## Invoke a Gateway

Gateway Invoke is a project-independent HTTP request command with headless and
interactive modes. It gets the Gateway by ID, uses the returned HTTPS origin,
selects authentication from the Gateway's authorizer, and preserves the request
and response bodies.

```bash
# MCP Gateway: use the exact gatewayUrl returned by GetGateway.
agentcore gateway invoke \
  --id <gatewayId> \
  --payload '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"agentcore-cli","version":"1"}}}' \
  --accept 'application/json, text/event-stream' \
  --mcp-protocol-version 2025-03-26

# HTTP target: --path is relative to the Gateway origin.
agentcore gateway invoke \
  --id <gatewayId> \
  --path support-agent/invocations \
  --payload file://request.json \
  --session-id <runtimeSessionId>

# Inference target.
agentcore gateway invoke \
  --id <gatewayId> \
  --path inference/v1/messages \
  --payload file://message.json \
  --json

# GET requests do not accept a payload.
agentcore gateway invoke \
  --id <gatewayId> \
  --method GET \
  --path inference/v1/models
```

`--path` replaces the path in the returned Gateway URL while retaining its
origin. It must remain relative to the selected Gateway and may include a query
string. Omitting it uses the returned `gatewayUrl` exactly. Supported methods
are `GET`, `POST` (the default), and `DELETE`. POST requires `--payload`; DELETE
may include one. Payloads accept inline bytes, `file://<path>`, or `-` for stdin.

Authentication follows `GetGateway.authorizerType`: `AWS_IAM` and
`AUTHENTICATE_ONLY` requests use SigV4, `CUSTOM_JWT` requires `--bearer-token`,
and `NONE` uses unsigned HTTPS. Bearer tokens accept inline, `file://`, or stdin
sources; payload and token cannot both read stdin.

Raw responses stream exact bytes to stdout. `--output-file` streams those bytes
to disk, while `--json` buffers one envelope containing status, selected session
and request metadata, body encoding, and body. Binary or unknown output requires
`--output-file` or `--json` when stdout is a terminal. Response metadata goes to
stderr in raw and file modes. Redirects are returned without being followed.
Non-2xx response bodies use the selected output mode before the command exits
with a failure status.

Without `--payload`, Gateway Invoke opens a persistent POST JSON console. Bare
invoke opens the Gateway picker, while `--id` opens the selected Gateway
directly. `--path`, `--session-id`, MCP session flags, `--header`, and
`--bearer-token` seed the console. Interactive bearer tokens may be inline or
`file://` sources, but not stdin. Explicit headless-only flags such as
`--method`, `--accept`, `--content-type`, `--output-file`, or `--json` keep the
command headless.

The console generates and displays a Runtime session ID, adopts returned Runtime
and MCP sessions, and streams textual responses as they arrive. An empty path
uses the exact `gatewayUrl`; `Ctrl+P` edits the raw Gateway-relative path and
`Ctrl+T` switches Gateways. Switching Gateways clears request context, while
changing paths preserves the draft and Gateway authentication but starts fresh
sessions.

| Shortcut      | Action                                       |
| ------------- | -------------------------------------------- |
| `Enter`       | Send the JSON request                        |
| `Shift+Enter` | Insert a newline                             |
| `Ctrl+P`      | Edit the Gateway-relative path               |
| `Ctrl+T`      | Change Gateway                               |
| `Ctrl+V`      | Toggle raw and pretty completed JSON         |
| `Esc`         | Interrupt an active request or navigate back |
| `↑`/`↓`       | Scroll response history                      |

Gateway Invoke has no request-type selector, target/path discovery,
tool/model discovery command, authentication editor, or protocol-specific
payload builder. Callers provide the Gateway-relative route and protocol payload
directly. GET and DELETE remain available through headless invoke.

## Interactive Menus

The Gateway TUI is read-only: bare Gateway, Target, Connector, and Rule
branches and their `get`/`list` leaves open command menus and scoped selection
flows. Connector is presented as a separate resource experience while using
Gateway Target operations internally.

Create and deploy Gateways through an AgentCore project. The Gateway menu's
TUI-only `create` entry provides `project create`,
`project add gateway --name MyGateway`, and `project deploy` guidance.

```bash
agentcore gateway
agentcore gateway list
agentcore gateway get
agentcore gateway target list
agentcore gateway target get
agentcore gateway connector list
agentcore gateway connector get
agentcore gateway rule list
agentcore gateway rule get
```
