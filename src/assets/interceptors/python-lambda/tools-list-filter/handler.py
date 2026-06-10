"""
AgentCore Gateway Interceptor — tools-list-filter (RESPONSE point).

When the gateway answers a `tools/list` MCP call, strip the response body of
any tools the calling principal isn't allowed to see. Other MCP method
responses pass through unchanged.

The `@interceptor()` decorator owns the envelope (version + wire shape) and
turns any raised exception into a safe response. Edit the `is_authorized()`
predicate to match your authorization model.
"""

from typing import Any, Dict, List

from bedrock_agentcore.gateway.interceptor import InterceptorEvent, InterceptorResponse, interceptor


def is_authorized(tool_name: str, request_headers: Dict[str, str]) -> bool:
    """Return True if the caller is allowed to see this tool.

    Default implementation: allow everything. Replace with real logic
    (read groups from JWT, check feature flag, consult policy engine, etc.).
    """
    _ = (tool_name, request_headers)
    return True


@interceptor()
def handler(event: InterceptorEvent, context) -> InterceptorResponse:
    response = event.response
    if response is None:
        # Defensive: should not happen at RESPONSE point.
        return InterceptorResponse.pass_through(event)

    request_headers: Dict[str, str] = (event.request.headers if event.request else {}) or {}

    body = response.body or {}
    request_body = (event.request.body if event.request else {}) or {}
    method = body.get("method") or request_body.get("method")
    is_tools_list = method == "tools/list" or "tools" in (body.get("result") or {})

    if not is_tools_list:
        return InterceptorResponse.pass_through(event)

    result = body.get("result") or {}
    tools: List[Dict[str, Any]] = result.get("tools") or []
    filtered: List[Dict[str, Any]] = [t for t in tools if is_authorized(str(t.get("name", "")), request_headers)]

    new_body = dict(body)
    new_result = dict(result)
    new_result["tools"] = filtered
    new_body["result"] = new_result

    return InterceptorResponse.transform_response(response.status_code, response.headers, new_body)
