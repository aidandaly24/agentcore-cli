# {{ Name }} — tools-list-filter (RESPONSE, Node.js 22.x)

Strip unauthorized tools from `tools/list` responses before they reach the agent.
Other MCP method responses pass through unchanged.

## What you must edit

Replace the placeholder `isAuthorized()` function with your real logic. Common
patterns:

- Read groups/roles from a JWT in `requestHeaders.authorization`.
- Look up an entitlement record in DynamoDB.
- Consult a Cedar / OPA policy engine.

## Envelope

`interceptorOutputVersion: "1.0"` is mandatory on every return path.

## Structured errors over exceptions

If you must error out, return a structured response envelope (e.g., `502` with
a JSON error body) — never throw. Throwing fires the interceptor twice.

## Cold start

This handler runs once per `tools/list` request, which is infrequent compared
to per-tool-invocation interceptors. Cold starts are usually fine here.
