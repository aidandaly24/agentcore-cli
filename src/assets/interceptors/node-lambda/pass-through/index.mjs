/**
 * AgentCore Gateway Interceptor — pass-through (REQUEST or RESPONSE point).
 *
 * Inputs (REQUEST point):
 *   event.interceptorInputVersion === "1.0"
 *   event.mcp.gatewayRequest === { path, httpMethod, headers, body }
 *
 * Inputs (RESPONSE point):
 *   event.mcp.gatewayResponse === { statusCode, headers, body }
 *
 * Outputs (always):
 *   { interceptorOutputVersion: "1.0", mcp: {...} }
 *
 * Foot-guns avoided by this template:
 *   - interceptorOutputVersion is always set (missing → silent rejection).
 *   - Errors are returned as structured response envelopes, never thrown
 *     (throwing triggers gateway retries — fires the interceptor twice).
 *
 * Streaming guard (RESPONSE only — uncomment if your gateway streams):
 *   // const invocationIndex = event?.mcp?.invocationIndex ?? 0;
 *   // if (invocationIndex > 0) {
 *   //   // Subsequent invocations: do not mutate headers/statusCode.
 *   // }
 *
 * Idempotency (uncomment if your handler has external side effects):
 *   // const key = event?.mcp?.invocationId;
 *   // if (key && seen(key)) return cachedResponse(key);
 */
export const handler = async event => {
  const request = event?.mcp?.gatewayRequest;
  const response = event?.mcp?.gatewayResponse;

  const outputMcp = {};
  if (request) {
    outputMcp.transformedGatewayRequest = {
      headers: request.headers ?? {},
      body: request.body ?? {},
    };
  }
  if (response) {
    outputMcp.transformedGatewayResponse = {
      statusCode: response.statusCode ?? 200,
      headers: response.headers ?? {},
      body: response.body ?? {},
    };
  }

  return {
    interceptorOutputVersion: '1.0',
    mcp: outputMcp,
  };
};
