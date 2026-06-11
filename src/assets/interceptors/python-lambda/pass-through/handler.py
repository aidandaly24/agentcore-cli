"""
AgentCore Gateway Interceptor — pass-through (REQUEST or RESPONSE point).

The `@interceptor()` decorator owns the envelope: it parses the input into a
typed `InterceptorEvent`, stamps the required `interceptorOutputVersion`, and
turns any raised exception into a safe response (so the gateway does not retry
and double-invoke). You return an `InterceptorResponse`; you never build the
wire shape by hand.

Replace the pass-through logic below with your own.
"""

from bedrock_agentcore.gateway.interceptor import InterceptorEvent, InterceptorResponse, interceptor


@interceptor()
def lambda_handler(event: InterceptorEvent, context) -> InterceptorResponse:
    # REQUEST point: forward the request unchanged.
    # RESPONSE point: forward the response unchanged.
    return InterceptorResponse.pass_through(event)
