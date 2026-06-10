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

## Writing a handler

### With the SDK (recommended for managed interceptors)

The scaffolded templates use the **`bedrock-agentcore` SDK**, which owns the request/response envelope so you only write
business logic. You return a typed `InterceptorResponse`; the SDK stamps the required version, builds the wire shape,
and converts any thrown error into a safe response (so the gateway never retries and double-invokes).

```python
# Python — handler.py
from bedrock_agentcore.gateway.interceptor import interceptor, InterceptorEvent, InterceptorResponse

@interceptor()
def handler(event: InterceptorEvent, context) -> InterceptorResponse:
    if not event.request.headers.get("authorization"):
        return InterceptorResponse.deny(403, {"error": "forbidden"})
    return InterceptorResponse.pass_through(event)
```

```javascript
// Node — index.mjs
import { InterceptorResponse, createInterceptor } from 'bedrock-agentcore/gateway';

export const handler = createInterceptor(event => {
  if (!event.request?.headers?.authorization) return InterceptorResponse.deny(403, { error: 'forbidden' });
  return InterceptorResponse.passThrough(event);
});
```

Test a handler with a unit test against a sample event — no deploy required:

```python
from bedrock_agentcore.gateway.interceptor import InterceptorEvent
from handler import handler

def test_denies_missing_token():
    event = InterceptorEvent.sample_request(headers={})
    result = handler(event.raw)
    assert result["mcp"]["transformedGatewayResponse"]["statusCode"] == 403
```

### The envelope contract (without the SDK)

External interceptors — and managed handlers written in another language — must satisfy the same contract by hand. The
SDK's typed models are the canonical reference; here is the raw shape.

**Input** the gateway sends your Lambda:

```jsonc
{
  "interceptorInputVersion": "1.0",
  "mcp": {
    // present at the REQUEST point (and echoed at RESPONSE):
    "gatewayRequest": { "path": "...", "httpMethod": "...", "headers": {}, "body": {} },
    // present only at the RESPONSE point:
    "gatewayResponse": { "statusCode": 200, "headers": {}, "body": {} },
  },
}
```

**Output** your Lambda must return:

```jsonc
{
  "interceptorOutputVersion": "1.0", // REQUIRED — omitting it makes the gateway SILENTLY ignore your interceptor
  "mcp": {
    // continue to the target with a (possibly modified) request — REQUEST point:
    "transformedGatewayRequest": { "headers": {}, "body": {} },
    // OR return/transform a response (RESPONSE point, or a REQUEST-point short-circuit like a 403):
    // "transformedGatewayResponse": { "statusCode": 200, "headers": {}, "body": {} }
  },
}
```

Two footguns the SDK handles for you, and that you must handle yourself without it:

- **Omitting `interceptorOutputVersion`** → the gateway treats the interceptor as a no-op and passes traffic through
  unchanged, with no error anywhere. Always set it.
- **Throwing instead of returning** → the gateway retries and invokes your interceptor twice. Catch your own errors and
  return a structured response (e.g. a 500) instead.

A non-SDK handler (any language) just needs to read the input shape and return the output shape — for example, a Go
Lambda that returns `{"interceptorOutputVersion":"1.0","mcp":{"transformedGatewayRequest":{...}}}`.

## Operational verbs

```bash
# Tail logs for a managed interceptor
agentcore logs interceptor --name auth-check --follow

# Search logs by time window
agentcore logs interceptor --name auth-check --since 1h --until now
```

`logs interceptor` is managed-only — for an external interceptor it prints a copy-pasteable `aws logs tail` remediation
and exits non-zero, because the CLI doesn't own that Lambda's log group. The log group is created on the interceptor's
first invocation, so send a request through the gateway before tailing.

`agentcore status` lists interceptors under their own section, showing deployment state (`deployed`, `local-only`,
`pending-removal`) alongside mode and interception points (e.g. `managed — REQUEST+RESPONSE`).

## Cross-account external interceptors

When `--lambda-arn`'s account ID does not match the deploy target's account, the gateway can still be wired to the
foreign Lambda (its role's identity policy grants `lambda:InvokeFunction` on the ARN), but the **first invocation
fails** until you add a matching resource-based policy to the Lambda granting the gateway role permission to invoke it.

The CLI emits a concise heads-up at preflight, then — **after deploy**, once the gateway's execution role ARN actually
exists — prints the exact `add-permission` command with the resolved role ARN interpolated. The gateway role lives in
your own account and is printed unmasked so it is copy-pasteable; the foreign Lambda ARN is masked.

```
Cross-account interceptor "central-auth" needs a resource-based policy on its Lambda.
  Lambda: arn:*:lambda:us-east-1:****1111:function:central-auth-prod
Run this in the Lambda's account before sending traffic through the gateway:

  aws lambda add-permission \
    --function-name <your-interceptor-function-name> \
    --statement-id GatewayInterceptorInvoke \
    --action lambda:InvokeFunction \
    --principal arn:aws:iam::<gateway-account>:role/<gateway-exec-role>
```

The gateway role ARN is also stored in `deployed-state.json` under the gateway's `roleArn`. Run the command once in the
Lambda's account before sending traffic through the gateway.

> **Partitions:** the examples above use the `aws` partition. In GovCloud or China, substitute your partition
> (`aws-us-gov`, `aws-cn`) in the ARNs.

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
