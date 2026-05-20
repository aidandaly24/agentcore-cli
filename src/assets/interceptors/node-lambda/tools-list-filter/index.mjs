/**
 * AgentCore Gateway Interceptor — tools-list-filter (RESPONSE point).
 *
 * When the gateway answers a `tools/list` MCP call, strip the response body of
 * any tools the calling principal isn't allowed to see. Other MCP method
 * responses pass through unchanged.
 *
 * Replace the placeholder `isAuthorized()` with your real logic.
 */

const isAuthorized = (toolName, requestHeaders) => {
  // Default: allow everything. Replace with real logic (read JWT, check
  // groups, consult policy engine, etc.).
  void toolName;
  void requestHeaders;
  return true;
};

export const handler = async event => {
  const response = event?.mcp?.gatewayResponse;
  if (!response) {
    return { interceptorOutputVersion: '1.0', mcp: {} };
  }

  const requestHeaders = event?.mcp?.gatewayRequest?.headers ?? {};
  const body = response.body ?? {};
  const requestMethod = event?.mcp?.gatewayRequest?.body?.method;
  const isToolsList = requestMethod === 'tools/list' || (body?.result && Array.isArray(body.result.tools));

  if (!isToolsList) {
    return { interceptorOutputVersion: '1.0', mcp: { transformedGatewayResponse: response } };
  }

  const result = body.result ?? {};
  const tools = Array.isArray(result.tools) ? result.tools : [];
  const filtered = tools.filter(t => isAuthorized(String(t?.name ?? ''), requestHeaders));

  return {
    interceptorOutputVersion: '1.0',
    mcp: {
      transformedGatewayResponse: {
        statusCode: response.statusCode ?? 200,
        headers: response.headers ?? {},
        body: { ...body, result: { ...result, tools: filtered } },
      },
    },
  };
};
