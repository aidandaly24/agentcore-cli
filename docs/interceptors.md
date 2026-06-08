# Lambda Interceptors

AgentCore Gateway Interceptors are customer-owned Lambda functions that the gateway invokes on every MCP request to
inspect, transform, or short-circuit traffic. They run at one of two interception points:

- **REQUEST** — before the gateway invokes the target.
- **RESPONSE** — after the target returns, before the gateway replies to the caller.

A gateway can carry up to **2 interceptors** (one REQUEST + one RESPONSE), or a single interceptor wired to both points.

## Modes

The CLI supports two first-class modes, mirroring the existing code-based evaluator pattern:

| Mode                  | What the CLI owns                                                                                                                                            | When to use                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| **Managed** (default) | Scaffolds a templated Lambda project under `app/<name>/`, packages it, deploys it, renders the resulting ARN into the gateway's `InterceptorConfigurations`. | You want the CLI to own the source tree and deploy artifact end-to-end. |
| **External**          | You pass an already-deployed Lambda ARN with `--lambda-arn`. The CLI plugs the ARN into the gateway and grants `lambda:InvokeFunction` to the gateway role.  | You have a centralized auth Lambda or a third-party-owned function.     |

## Quick start — managed

```bash
# Single REQUEST-point interceptor with the JWT scope authorizer template
agentcore add interceptor \
  --name auth-check \
  --gateway my-gateway \
  --interception-points REQUEST \
  --template jwt-scope-authorizer \
  --runtime python3.12

# Edit app/auth-check/handler.py with your scope rules, then:
agentcore deploy
```

Managed interceptors can attach extra IAM permissions to their execution role with `--additional-policies` (a
comma-separated list of JSON policy-document file paths relative to the interceptor's code directory, or managed-policy
ARNs):

```bash
agentcore add interceptor \
  --name auth-check \
  --gateway my-gateway \
  --interception-points REQUEST \
  --template jwt-scope-authorizer \
  --additional-policies execution-role-policy.json,arn:aws:iam::aws:policy/AmazonDynamoDBReadOnlyAccess
```

## Quick start — external (BYO ARN)

```bash
agentcore add interceptor \
  --name central-auth \
  --gateway my-gateway \
  --interception-points REQUEST \
  --lambda-arn arn:aws:lambda:us-east-1:111111111111:function:central-auth-prod
```

The CLI does not scaffold any code; the only artifact is the JSON entry in `agentcore.json`.

## Interactive (TUI)

Running `agentcore add interceptor` with no flags (in a TTY) launches the interactive wizard. It is also reachable from
the top-level `agentcore add` menu under **Interceptor**. The wizard collects the same fields as the flags above:

```
name → gateway → interception points → mode
  ├─ managed:  template → runtime → advanced → confirm
  └─ external: Lambda ARN → confirm
```

The **Advanced** step is a multi-select for the optional managed-mode settings — pick only the ones you need and the
wizard injects just those sub-steps:

| Advanced setting        | Sub-step                                          | Default  |
| ----------------------- | ------------------------------------------------- | -------- |
| Lambda timeout          | Timeout in seconds (1–300)                        | `30`     |
| Additional IAM policies | Comma-separated policy file paths or managed ARNs | _(none)_ |
| Pass request headers    | Yes / No                                          | `Yes`    |

Removal is also interactive: `agentcore remove interceptor` (or the **Interceptor** entry in `agentcore remove`) lists
your interceptors, previews exactly what will change — including the scaffolded `app/<name>/` directory for managed mode
— and confirms before writing.

## Dual-point on a single Lambda

A single interceptor can serve both REQUEST and RESPONSE on the same gateway:

```bash
agentcore add interceptor \
  --name dual-point \
  --gateway my-gateway \
  --interception-points REQUEST,RESPONSE \
  --template pass-through \
  --runtime python3.12
```

This counts as one interceptor against the cardinality cap.

## Templates (managed mode)

| Template               | Point(s)            | Purpose                                                                                                            |
| ---------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `pass-through`         | REQUEST or RESPONSE | Minimal compliant handler. Demonstrates the input/output envelope and the streaming guard.                         |
| `jwt-scope-authorizer` | REQUEST             | Decodes the inbound `Authorization` JWT and short-circuits with a structured 403 if the required scope is missing. |
| `tools-list-filter`    | RESPONSE            | Strips unauthorized tools from `tools/list` responses based on a customer-supplied `is_authorized()` predicate.    |

Each template ships in both Python 3.12 and Node.js 22.x. Pick with `--runtime python3.12` (default) or
`--runtime nodejs22.x`.

## Operational verbs

```bash
# Tail logs for a managed interceptor
agentcore logs interceptor --name auth-check --follow

# Search logs by time window
agentcore logs interceptor --name auth-check --since 1h --until now

# Invoke synthetically with a payload file
agentcore invoke interceptor --name auth-check --payload-file ./test-event.json
```

For external interceptors, both verbs print a copy-pasteable `aws` CLI remediation and exit non-zero — the CLI doesn't
own those Lambdas.

`agentcore status` lists interceptors under their own section, showing deployment state (`deployed`, `local-only`,
`pending-removal`) alongside mode and interception points (e.g. `managed — REQUEST+RESPONSE`).

## Cross-account external interceptors

When `--lambda-arn`'s account ID does not match the deploy target's account, the CLI emits a **warning** at preflight
(with masked account IDs) and **continues** the deploy. The deploy itself succeeds — the gateway role's identity policy
grants `lambda:InvokeFunction` on the foreign ARN. What doesn't work yet is the first invocation: AWS Lambda requires a
matching resource-based policy on the function granting the gateway role permission to invoke it.

Example warning (account IDs masked to last 4 digits):

```
WARNING: Cross-account interceptor detected for "central-auth".
  Gateway account(s): ****1947
  Lambda:             arn:aws:lambda:us-east-1:****1111:function:central-auth-prod

Deploy will succeed, but the first interceptor invocation will fail until
you add a resource-based policy to the Lambda. Run this in the Lambda's
account (once per interceptor) before sending traffic through the gateway:

  aws lambda add-permission \
    --function-name <your-interceptor-function-name> \
    --statement-id GatewayServiceRoleInvoke \
    --action lambda:InvokeFunction \
    --principal <gateway-role-arn-from-deployed-state>

Continuing with deploy...
```

Run the snippet once in the Lambda's account, before sending traffic through the gateway.

## Schema

```jsonc
{
  "interceptors": [
    {
      "name": "auth-check",
      "gatewayName": "my-gateway",
      "interceptionPoints": ["REQUEST"],
      "passRequestHeaders": true,
      "config": {
        "managed": {
          "codeLocation": "app/auth-check/",
          "entrypoint": "handler.lambda_handler",
          "timeoutSeconds": 30,
          "runtime": "python3.12",
          "additionalPolicies": ["execution-role-policy.json"],
        },
      },
    },
    {
      "name": "central-auth",
      "gatewayName": "my-gateway",
      "interceptionPoints": ["RESPONSE"],
      "passRequestHeaders": true,
      "config": {
        "external": {
          "lambdaArn": "arn:aws:lambda:us-east-1:111111111111:function:central-auth-prod",
        },
      },
    },
  ],
}
```

`config.managed` and `config.external` are mutually exclusive (exactly one must be set).

### Fields

| Field                | Required | Default | Meaning                                                                                                                |
| -------------------- | -------- | ------- | ---------------------------------------------------------------------------------------------------------------------- |
| `name`               | yes      | —       | Interceptor name (≤24 chars; used in the Lambda function name).                                                        |
| `gatewayName`        | yes      | —       | The gateway this interceptor attaches to.                                                                              |
| `interceptionPoints` | yes      | —       | `["REQUEST"]`, `["RESPONSE"]`, or both. Max 1 interceptor per point per gateway (2 per gateway).                       |
| `passRequestHeaders` | no       | `true`  | Whether the gateway forwards the **inbound request's HTTP headers** to your interceptor. See below.                    |
| `config.managed`     | one of   | —       | CLI scaffolds and deploys the Lambda. `codeLocation`, `entrypoint`, `timeoutSeconds`, `runtime`, `additionalPolicies`. |
| `config.external`    | one of   | —       | You supply an existing Lambda `lambdaArn`; the CLI wires it without scaffolding code.                                  |

#### `passRequestHeaders` — read this before disabling it

The inbound request's headers include the **caller's `Authorization` token**. `passRequestHeaders` controls whether the
gateway copies those headers into the event your interceptor receives:

- `true` (default): your handler can read request headers (e.g. `event.mcp.gatewayRequest.headers.authorization`).
- `false`: the gateway sends an **empty** headers map; your handler cannot see the caller's headers or token.

> **Disabling headers silently breaks header-reading interceptors.** If your handler reads headers — including the
> built-in **`jwt-scope-authorizer`** template, whose entire job is to read the `Authorization` token — setting
> `passRequestHeaders: false` (or passing `--no-pass-request-headers`) makes it receive empty headers and silently
> no-op, with no runtime error. Only disable header forwarding for interceptors that genuinely do not read headers.
> `agentcore deploy` warns if it detects a header-reading handler with `passRequestHeaders` disabled.

## Removal

```bash
agentcore remove interceptor --name auth-check
agentcore deploy
```

Managed-mode removal also deletes the scaffolded `app/<name>/` directory. External-mode removal touches only the JSON
entry. The next `deploy` reconciles the gateway via CloudFormation — no imperative `UpdateGateway` calls.
