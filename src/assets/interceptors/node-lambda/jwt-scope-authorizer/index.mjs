/**
 * AgentCore Gateway Interceptor — jwt-scope-authorizer (REQUEST point).
 *
 * Reads the JWT scope claim from the inbound `Authorization` header and either
 * allows the request through or denies it with a structured 403.
 *
 * The handler does NOT validate the JWT signature — the gateway's CUSTOM_JWT
 * authorizer already did that. We only read the `scope` claim and authorize
 * the business action.
 *
 * `createInterceptor` owns the envelope (version + wire shape) and turns any
 * thrown error into a safe response. Edit `ALLOWED_SCOPES` to match your
 * scope vocabulary.
 */
import { createInterceptor, InterceptorResponse } from 'bedrock-agentcore/gateway';

const ALLOWED_SCOPES = new Set(['agentcore:invoke']);

const decodeJwtPayload = token => {
  const parts = token.split('.');
  if (parts.length < 2) return {};
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf-8'));
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

export const handler = createInterceptor(event => {
  const headers = Object.fromEntries(
    Object.entries(event.request?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])
  );
  const authz = String(headers.authorization ?? '');

  if (!authz.toLowerCase().startsWith('bearer ')) {
    return InterceptorResponse.deny(403, { error: 'forbidden', reason: 'missing-or-malformed-authorization-header' });
  }

  const payload = decodeJwtPayload(authz.slice('Bearer '.length).trim());
  const scopes = new Set(scopesFromPayload(payload));
  if (![...scopes].some(s => ALLOWED_SCOPES.has(s))) {
    return InterceptorResponse.deny(403, { error: 'forbidden', reason: 'required-scope-missing' });
  }

  return InterceptorResponse.passThrough(event);
});
