/**
 * AgentCore Gateway Interceptor — jwt-scope-authorizer (REQUEST point).
 *
 * Reads the JWT scope claim from the inbound `Authorization` header and either
 * allows the request through unchanged or denies it with a structured 403.
 *
 * The handler does NOT validate the JWT signature — the gateway's CUSTOM_JWT
 * authorizer already did that. We only read the `scope` claim and authorize
 * the business action.
 *
 * Edit `ALLOWED_SCOPES` below to match your scope vocabulary.
 */

const ALLOWED_SCOPES = new Set(['agentcore:invoke']);

const decodeJwtPayload = token => {
  const parts = token.split('.');
  if (parts.length < 2) return {};
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const json = Buffer.from(padded, 'base64').toString('utf-8');
    return JSON.parse(json);
  } catch {
    return {};
  }
};

const scopesFromPayload = payload => {
  const raw = payload.scope ?? payload.scp;
  if (typeof raw === 'string') return raw.split(/\s+/);
  if (Array.isArray(raw)) return raw.map(String);
  return [];
};

const deny = reason => ({
  interceptorOutputVersion: '1.0',
  mcp: {
    transformedGatewayResponse: {
      statusCode: 403,
      headers: { 'Content-Type': 'application/json' },
      body: { error: 'forbidden', reason },
    },
  },
});

export const handler = async event => {
  const request = event?.mcp?.gatewayRequest ?? {};
  const headers = Object.fromEntries(
    Object.entries(request.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])
  );
  const authz = headers.authorization ?? '';

  if (!authz.toLowerCase().startsWith('bearer ')) {
    return deny('missing-or-malformed-authorization-header');
  }

  const token = authz.slice('Bearer '.length).trim();
  const payload = decodeJwtPayload(token);
  const scopes = new Set(scopesFromPayload(payload));

  const intersect = [...scopes].some(s => ALLOWED_SCOPES.has(s));
  if (!intersect) {
    return deny('required-scope-missing');
  }

  return {
    interceptorOutputVersion: '1.0',
    mcp: {
      transformedGatewayRequest: {
        headers: request.headers ?? {},
        body: request.body ?? {},
      },
    },
  };
};
