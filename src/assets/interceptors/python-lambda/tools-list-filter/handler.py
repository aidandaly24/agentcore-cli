"""
AgentCore Gateway Interceptor — tools-list-filter (RESPONSE point).

When the gateway answers a `tools/list` MCP call, strip the response body of
any tools the calling principal isn't allowed to see. Other MCP method
responses pass through unchanged.

Edit the `is_authorized()` predicate to match your authorization model.

Envelope contract:
  Inputs:  event["mcp"]["gatewayResponse"]["body"]["result"]["tools"]
  Outputs: {"interceptorOutputVersion": "1.0", "mcp": {...}}
"""
from typing import Any, Dict, List


def is_authorized(tool_name: str, request_headers: Dict[str, str]) -> bool:
    """Return True if the caller is allowed to see this tool.

    Default implementation: allow everything. Replace with real logic
    (read groups from JWT, check feature flag, consult policy engine, etc.).
    """
    _ = (tool_name, request_headers)
    return True


def lambda_handler(event, context):
    response = event.get("mcp", {}).get("gatewayResponse")
    if response is None:
        # Defensive: should not happen at RESPONSE point.
        return {"interceptorOutputVersion": "1.0", "mcp": {}}

    request_headers: Dict[str, str] = (
        event.get("mcp", {}).get("gatewayRequest", {}).get("headers", {}) or {}
    )

    body = response.get("body") or {}
    method = body.get("method") or (event.get("mcp", {}).get("gatewayRequest", {}).get("body", {}) or {}).get("method")
    is_tools_list = method == "tools/list" or "tools" in (body.get("result") or {})

    if not is_tools_list:
        # Pass through unchanged.
        return {
            "interceptorOutputVersion": "1.0",
            "mcp": {"transformedGatewayResponse": response},
        }

    result = body.get("result") or {}
    tools: List[Dict[str, Any]] = result.get("tools") or []
    filtered: List[Dict[str, Any]] = [t for t in tools if is_authorized(str(t.get("name", "")), request_headers)]

    new_body = dict(body)
    new_result = dict(result)
    new_result["tools"] = filtered
    new_body["result"] = new_result

    return {
        "interceptorOutputVersion": "1.0",
        "mcp": {
            "transformedGatewayResponse": {
                "statusCode": response.get("statusCode", 200),
                "headers": response.get("headers", {}),
                "body": new_body,
            }
        },
    }
