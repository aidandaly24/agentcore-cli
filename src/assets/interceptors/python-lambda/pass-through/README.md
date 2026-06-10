# {{ Name }} — pass-through interceptor

A minimal AgentCore Gateway Interceptor that returns the request/response unchanged.

## Envelope

The handler reads `event["interceptorInputVersion"] == "1.0"` and returns
`{"interceptorOutputVersion": "1.0", "mcp": ...}`. **The output version is mandatory**;
missing it causes the gateway to silently reject the response.

## Structured errors over exceptions

Don't throw. Return a structured envelope so the gateway doesn't retry the same
event and double-invoke. Example:

```python
return {
    "interceptorOutputVersion": "1.0",
    "mcp": {
        "transformedGatewayResponse": {
            "statusCode": 403,
            "headers": {"Content-Type": "application/json"},
            "body": {"error": "Authorization denied"},
        }
    },
}
```

## Idempotency

For interceptors with external side effects (writing to S3, calling a third-party
API), use `event["mcp"]["invocationId"]` as the idempotency key — see the
commented-in example in `handler.py`.

## Cold start

Lambda cold starts can push the first invocation past the gateway's interceptor
budget. If telemetry shows a steady stream of first-invocation timeouts, configure
provisioned concurrency on the function. The schema's default `timeoutSeconds: 30`
is a comfortable upper bound for typical workloads.
