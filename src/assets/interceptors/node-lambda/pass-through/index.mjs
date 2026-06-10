/**
 * AgentCore Gateway Interceptor — pass-through (REQUEST or RESPONSE point).
 *
 * `createInterceptor` owns the envelope: it parses the input, stamps the
 * required `interceptorOutputVersion`, and converts any thrown error into a
 * safe response (so the gateway does not retry and double-invoke). You return
 * an `InterceptorResponse`; you never build the wire shape by hand.
 *
 * Replace the pass-through logic below with your own.
 */
import { createInterceptor, InterceptorResponse } from 'bedrock-agentcore/gateway';

export const handler = createInterceptor(event => {
  // REQUEST point: forward the request unchanged.
  // RESPONSE point: forward the response unchanged.
  return InterceptorResponse.passThrough(event);
});
