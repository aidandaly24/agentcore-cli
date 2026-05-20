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

## Quick start — external (BYO ARN)

```bash
agentcore add interceptor \
  --name central-auth \
  --gateway my-gateway \
  --interception-points REQUEST \
  --lambda-arn arn:aws:lambda:us-east-1:111111111111:function:central-auth-prod
```

The CLI does not scaffold any code; the only artifact is the JSON entry in `agentcore.json`.

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

## Removal

```bash
agentcore remove interceptor --name auth-check
agentcore deploy
```

Managed-mode removal also deletes the scaffolded `app/<name>/` directory. External-mode removal touches only the JSON
entry. The next `deploy` reconciles the gateway via CloudFormation — no imperative `UpdateGateway` calls.

## Limitations / out of scope (P0)

- PII-redaction template (requires customer-specific patterns).
- Audit-logging template (OpenSearch / S3 wiring).
- Provisioned concurrency.
- Multi-gateway shared interceptor pools.
- Console UX parity.
- Streaming-aware first-invocation guard as active code (shipped commented-in).
