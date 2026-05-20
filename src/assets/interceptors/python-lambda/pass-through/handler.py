"""
AgentCore Gateway Interceptor — pass-through (REQUEST or RESPONSE point).

Inputs (REQUEST point):
  event["interceptorInputVersion"] == "1.0"
  event["mcp"]["gatewayRequest"] == {path, httpMethod, headers, body}

Inputs (RESPONSE point):
  event["mcp"]["gatewayResponse"] == {statusCode, headers, body}

Outputs (always):
  interceptorOutputVersion: "1.0"
  mcp: { transformedGatewayRequest? , transformedGatewayResponse? }

Foot-guns avoided by this template:
  - interceptorOutputVersion is always set (missing -> silent rejection).
  - Errors are returned as structured response envelopes, never thrown
    (throwing triggers gateway retries -- fires the interceptor twice).

Streaming guard (RESPONSE only -- uncomment if your gateway streams):
  # invocation_index = event.get("mcp", {}).get("invocationIndex", 0)
  # if invocation_index > 0:
  #     # Subsequent invocations: do not mutate headers/statusCode.
  #     pass

Idempotency (uncomment if your handler has external side effects):
  # idempotency_key = event.get("mcp", {}).get("invocationId")
  # if idempotency_key and seen(idempotency_key):
  #     return cached_response(idempotency_key)
"""


def lambda_handler(event, context):
    request = event.get("mcp", {}).get("gatewayRequest")
    response = event.get("mcp", {}).get("gatewayResponse")

    output_mcp = {}
    if request is not None:
        output_mcp["transformedGatewayRequest"] = {
            "headers": request.get("headers", {}),
            "body": request.get("body", {}),
        }
    if response is not None:
        output_mcp["transformedGatewayResponse"] = {
            "statusCode": response.get("statusCode", 200),
            "headers": response.get("headers", {}),
            "body": response.get("body", {}),
        }

    return {
        "interceptorOutputVersion": "1.0",
        "mcp": output_mcp,
    }
