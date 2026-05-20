# {{ Name }} — jwt-scope-authorizer (REQUEST)

Decode the inbound `Authorization: Bearer …` JWT, read the `scope`/`scp` claim,
and short-circuit unauthorized requests with a structured 403.

## What you must edit

Update `ALLOWED_SCOPES` in `handler.py` to reflect your scope vocabulary.

## Why this is REQUEST-only

The structured 403 lives in `transformedGatewayResponse`, which the gateway
serves directly to the caller. RESPONSE-point interceptors should not authorize;
that's too late in the lifecycle.

## Envelope

`interceptorOutputVersion: "1.0"` is mandatory on every return path. Missing it
causes the gateway to silently reject the response and serve the upstream
result unmodified.

## Structured errors over exceptions

Don't throw on auth failure. Throwing tells the gateway to retry, double-invoking
your handler. Always return the deny envelope.
