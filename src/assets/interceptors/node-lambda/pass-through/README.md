# {{ Name }} — pass-through interceptor (Node.js 22.x)

A minimal AgentCore Gateway Interceptor that returns the request/response unchanged.

## Envelope

The handler reads `event.interceptorInputVersion === "1.0"` and returns
`{ interceptorOutputVersion: "1.0", mcp: ... }`. **The output version is mandatory**;
missing it causes the gateway to silently reject the response.

## Structured errors over exceptions

Don't throw. Return a structured envelope so the gateway doesn't retry the same
event and double-invoke. Example:

```js
return {
  interceptorOutputVersion: '1.0',
  mcp: {
    transformedGatewayResponse: {
      statusCode: 403,
      headers: { 'Content-Type': 'application/json' },
      body: { error: 'Authorization denied' },
    },
  },
};
```

## Idempotency

For interceptors with external side effects (writing to S3, calling a third-party
API), use `event.mcp.invocationId` as the idempotency key — see the commented-in
example in `index.mjs`.

## Cold start

Lambda cold starts can push the first invocation past the gateway's interceptor
budget. Configure provisioned concurrency on the function if telemetry shows
first-invocation timeouts.
