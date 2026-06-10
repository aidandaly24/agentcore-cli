/**
 * AgentCore Gateway Interceptor — tools-list-filter (RESPONSE point).
 *
 * When the gateway answers a `tools/list` MCP call, strip the response body of
 * any tools the calling principal isn't allowed to see. Other MCP method
 * responses pass through unchanged.
 *
 * `createInterceptor` owns the envelope (version + wire shape) and turns any
 * thrown error into a safe response. Replace the placeholder `isAuthorized()`
 * with your real logic.
 */
import { createInterceptor, InterceptorResponse } from 'bedrock-agentcore/gateway';

const isAuthorized = (toolName, requestHeaders) => {
  // Default: allow everything. Replace with real logic (read JWT, check
  // groups, consult policy engine, etc.).
  void toolName;
  void requestHeaders;
  return true;
};

export const handler = createInterceptor(event => {
  const response = event.response;
  if (!response) {
    return InterceptorResponse.passThrough(event);
  }

  const requestHeaders = event.request?.headers ?? {};
  const body = response.body ?? {};
  const requestMethod = event.request?.body?.method;
  const isToolsList = requestMethod === 'tools/list' || (body?.result && Array.isArray(body.result.tools));

  if (!isToolsList) {
    return InterceptorResponse.passThrough(event);
  }

  const result = body.result ?? {};
  const tools = Array.isArray(result.tools) ? result.tools : [];
  const filtered = tools.filter(t => isAuthorized(String(t?.name ?? ''), requestHeaders));

  return InterceptorResponse.transformResponse(response.statusCode ?? 200, response.headers ?? {}, {
    ...body,
    result: { ...result, tools: filtered },
  });
});
