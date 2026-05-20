# {{ Name }} — jwt-scope-authorizer (REQUEST, Node.js 22.x)

Decode the inbound `Authorization: Bearer …` JWT, read the `scope`/`scp` claim,
and short-circuit unauthorized requests with a structured 403.

## What you must edit

Update `ALLOWED_SCOPES` in `index.mjs` to reflect your scope vocabulary.

## Why REQUEST-only

The structured 403 lives in `transformedGatewayResponse`, which the gateway
serves directly to the caller. RESPONSE-point interceptors should not authorize;
that's too late in the lifecycle.

## Envelope

`interceptorOutputVersion: "1.0"` is mandatory on every return path.

## Structured errors over exceptions

Don't throw on auth failure. Throwing tells the gateway to retry, double-invoking
your handler. Always return the deny envelope.
