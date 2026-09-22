# Runtime

[Back to README](../README.md) | [Command reference](../command.md#runtime-commands)

To invoke or inspect logs and traces by project resource name rather than a
physical Runtime ID, see [project workflows](command-examples.md#project-workflows).
For resource picker behavior, see
[Runtime and Memory menus](command-examples.md#runtime-and-memory-menus).

## Inspect Runtimes

```bash
# Inspect deployed Runtimes without project configuration or deployment
agentcore runtime get --id <runtimeId>
agentcore runtime list --max-results 20
agentcore runtime version get --id <runtimeId> --version <version>
agentcore runtime version list --id <runtimeId> --max-results 20
agentcore runtime endpoint get --id <runtimeId> --qualifier DEFAULT
agentcore runtime endpoint list --id <runtimeId> --max-results 20

# Follow a Runtime's logs live by resource ID (Ctrl+C to stop)
agentcore runtime logs --id <runtimeId>
agentcore runtime logs --id <runtimeId> --level error --query "database"

# Search a past window instead (--since/--until switch to search mode)
agentcore runtime logs --id <runtimeId> --since 1h --limit 100
agentcore runtime logs --id <runtimeId> --since 2026-08-30T12:00:00Z --until now --json

# List recent traces (they take 2-3 minutes to appear), then download one
agentcore runtime traces list --id <runtimeId> --since 30m
agentcore runtime traces get <traceId> --id <runtimeId> --output trace.json
```

## Invoke a Runtime

Headless invocation accepts inline, file, or stdin payload bytes:

```bash
# Inline
agentcore runtime invoke \
  --id <runtimeId> \
  --payload '{"action":"status"}' \
  --content-type application/json \
  --accept text/event-stream

# File
agentcore runtime invoke --id <runtimeId> --payload file://request.json

# stdin
cat request.json | agentcore runtime invoke --id <runtimeId> --payload -
```

CUSTOM_JWT Runtimes require `--bearer-token`. The token accepts the same inline,
`file://`, or stdin sources as the payload; payload and token cannot both read
stdin.

```bash
agentcore runtime invoke \
  --id <runtimeId> \
  --payload file://request.json \
  --bearer-token file://$HOME/.config/agentcore/runtime-token
```

For MCP Runtimes, initialize first, then pass the returned Runtime and MCP
session IDs to later methods. MCP requests accept both JSON and SSE responses.

```bash
agentcore runtime invoke \
  --id <runtimeId> \
  --payload '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"agentcore-cli","version":"1"}}}' \
  --accept 'application/json, text/event-stream' \
  --mcp-protocol-version 2025-03-26 \
  --mcp-method initialize

agentcore runtime invoke \
  --id <runtimeId> \
  --payload '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  --accept 'application/json, text/event-stream' \
  --session-id <returnedRuntimeSessionId> \
  --mcp-session-id <returnedMcpSessionId> \
  --mcp-protocol-version 2025-03-26 \
  --mcp-method tools/list
```

Raw stdout always streams exact response bytes as they arrive, regardless of
content type. `--output-file` streams the same bytes directly to disk. Binary or
unknown responses require `--output-file` or `--json` when stdout is a terminal.
Response metadata is written to stderr.

`--json` buffers the complete response, including streaming representations, and
emits one metadata envelope without interpreting the customer body. If a raw or
file response fails, bytes already written remain available and the stderr
summary reports `complete=false`. A failed JSON response emits no partial
envelope.

```bash
agentcore runtime invoke \
  --id <runtimeId> \
  --payload file://request.bin \
  --content-type application/octet-stream \
  --accept application/octet-stream \
  --output-file response.bin

agentcore runtime invoke --id <runtimeId> --payload '{"action":"status"}' --json
# {"statusCode":200,"contentType":"application/json","bodyEncoding":"utf8","body":"{\"ok\":true}","complete":true}
```

Without `--payload`, Runtime Invoke opens a persistent JSON console for repeated
requests. The console sends inline `application/json` payloads and renders each
response according to its returned content type. Bare invoke opens the Runtime
and endpoint pickers; `--id` skips the Runtime picker, and `--id` plus
`--qualifier` opens the console directly. `--session-id` resumes that Runtime
session in the console. `--user-id`, `--header`, and `--bearer-token` seed
request context that persists across sends and endpoint changes within that
Runtime. The console never displays their values, and switching Runtimes clears
them. Interactive bearer tokens may be inline or `file://` sources, but not
stdin.

| Shortcut      | Action                                       |
| ------------- | -------------------------------------------- |
| `Enter`       | Send the JSON request                        |
| `Shift+Enter` | Insert a newline                             |
| `Ctrl+T`      | Change Runtime or endpoint                   |
| `Ctrl+V`      | Toggle raw and pretty completed JSON         |
| `Esc`         | Interrupt an active request or navigate back |
| `↑`/`↓`       | Scroll response history                      |

Runtime Invoke accepts Runtime IDs from the current account only. It does not
accept ARNs, `--version`, `--interactive`, cross-account targets, or custom
request paths. All requests use the Runtime `/invocations` route, including MCP
Runtimes.

## Open a Runtime shell

Runtime Shell opens a persistent interactive terminal in a Runtime session.
Bare shell opens the Runtime and endpoint pickers. `--id` skips the Runtime
picker, and `--id` plus `--qualifier` connects directly.

```bash
agentcore runtime shell
agentcore runtime shell --id <runtimeId>
agentcore runtime shell --id <runtimeId> --qualifier DEFAULT
```

Use `--session-id` to open the shell in a specific Runtime session/VM:

```bash
agentcore runtime shell \
  --id <runtimeId> \
  --qualifier DEFAULT \
  --session-id <runtimeSessionId>
```

CUSTOM_JWT Runtimes require `--bearer-token`. Interactive bearer tokens may be
inline or `file://` sources, but not stdin.

The shell forwards terminal input byte-for-byte, including `Ctrl+C`, `Ctrl+D`,
escape sequences, and full-screen terminal applications. Terminal resize events
update the remote PTY. Running `exit` or sending `Ctrl+D` terminates the remote
shell.

Runtime Shell requires TTY stdin and stdout and does not support `--json`.
