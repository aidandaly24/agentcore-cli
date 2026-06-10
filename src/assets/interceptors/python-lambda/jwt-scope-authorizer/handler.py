"""
AgentCore Gateway Interceptor — jwt-scope-authorizer (REQUEST point).

Reads the JWT scope claim from the inbound `Authorization` header and either
allows the request through or denies it with a structured 403.

This handler does NOT validate the JWT signature -- the gateway's CUSTOM_JWT
authorizer already did that. We only read the `scope` claim and authorize the
business action.

The `@interceptor()` decorator owns the envelope (version + wire shape) and
turns any raised exception into a safe response. Edit the ALLOWED_SCOPES set
below to match your scope vocabulary.
"""

import base64
import json
from typing import Any, Dict, Iterable

from bedrock_agentcore.gateway.interceptor import InterceptorEvent, InterceptorResponse, interceptor

ALLOWED_SCOPES: frozenset[str] = frozenset({"agentcore:invoke"})


def _decode_jwt_payload(token: str) -> Dict[str, Any]:
    parts = token.split(".")
    if len(parts) < 2:
        return {}
    payload = parts[1]
    # Pad base64url to a multiple of 4 chars before decoding.
    payload += "=" * (-len(payload) % 4)
    try:
        return json.loads(base64.urlsafe_b64decode(payload).decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return {}


def _scopes_from_payload(payload: Dict[str, Any]) -> Iterable[str]:
    raw = payload.get("scope") or payload.get("scp")
    if isinstance(raw, str):
        return raw.split()
    if isinstance(raw, list):
        return [str(s) for s in raw]
    return []


@interceptor()
def handler(event: InterceptorEvent, context) -> InterceptorResponse:
    headers = {k.lower(): v for k, v in (event.request.headers if event.request else {}).items()}
    authz = headers.get("authorization", "")

    if not authz.lower().startswith("bearer "):
        return InterceptorResponse.deny(403, {"error": "forbidden", "reason": "missing-or-malformed-authorization-header"})

    payload = _decode_jwt_payload(authz[len("Bearer ") :].strip())
    if not set(_scopes_from_payload(payload)) & ALLOWED_SCOPES:
        return InterceptorResponse.deny(403, {"error": "forbidden", "reason": "required-scope-missing"})

    return InterceptorResponse.pass_through(event)
