/**
 * Assistant (agent) and device tokens. The plaintext token is returned once,
 * with ready-to-paste configuration for common MCP clients (SPEC §9).
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { hashToken, newToken } from '../../crypto.js';
import { appLink, type Config } from '../../env.js';
import { AGENT_SCOPES, DEFAULT_AGENT_SCOPES, DEVICE_SCOPES, createToken, listTokens, revokeToken, tokenInfo, type Scope, type TokenKind } from '../../store/tokens.js';
import { requireSession } from '../auth.js';
import { requireUser, type HonoEnv } from '../context.js';
import { badRequest, notFound } from '../errors.js';
import { jsonBody } from '../middleware.js';

export const tokensApi = new Hono<HonoEnv>();

const MAX_TOKENS = 50;

const CreateToken = z
  .object({
    kind: z.enum(['agent', 'device']),
    label: z.string().trim().min(1).max(60),
    scopes: z.array(z.string()).min(1).max(10).optional(),
  })
  .strict();

/**
 * Ready-to-paste setup (SPEC §9), keyed the way the web app shows them. Assistant
 * tokens get the three MCP configs; device tokens only the capture address. Either
 * kind gets a curl check only when it has the `status` scope: the check reads counts
 * only (GET /api/v1/status), so trying it never adds made-up words to someone's
 * Witness, and a key without `status` would only get 403 from it.
 */
export interface TokenConfigs {
  claudeCode?: string;
  codex?: string;
  json?: string;
  /** Present when the token may read status (a capture-only or add-only key would get 403). */
  curl?: string;
  mcpUrl?: string;
  captureUrl: string;
}

/** Copy-paste setup for the token. Only the caller sees these; they contain the secret. */
export function tokenConfigs(cfg: Config, kind: TokenKind, token: string, scopes: readonly string[]): TokenConfigs {
  const mcpUrl = appLink(cfg, '/mcp');
  const captureUrl = appLink(cfg, '/api/v1/capture');
  const bearer = `Bearer ${token}`;
  const check = scopes.includes('status') ? { curl: `curl -s ${appLink(cfg, '/api/v1/status')} \\\n  -H "Authorization: ${bearer}"` } : {};
  if (kind === 'device') return { captureUrl, ...check };
  return {
    mcpUrl,
    captureUrl,
    claudeCode: `claude mcp add --transport http witness ${mcpUrl} --header "Authorization: ${bearer}"`,
    codex: [`[mcp_servers.witness]`, `url = "${mcpUrl}"`, `http_headers = { "Authorization" = "${bearer}" }`].join('\n'),
    json: JSON.stringify({ mcpServers: { witness: { type: 'http', url: mcpUrl, headers: { Authorization: bearer } } } }, null, 2),
    ...check,
  };
}

tokensApi.get('/', requireSession, async (c) => {
  const rows = await listTokens(c.env.DB, requireUser(c).userId);
  return c.json({ tokens: rows.map(tokenInfo) });
});

tokensApi.post('/', requireSession, async (c) => {
  const { userId } = requireUser(c);
  const body = await jsonBody(c, CreateToken);
  const allowed: readonly string[] = body.kind === 'agent' ? AGENT_SCOPES : DEVICE_SCOPES;
  const scopes = (body.scopes ?? (body.kind === 'agent' ? [...DEFAULT_AGENT_SCOPES] : [...DEVICE_SCOPES])) as Scope[];
  const unknown = scopes.filter((s) => !allowed.includes(s));
  if (unknown.length > 0) throw badRequest(`Unknown ${body.kind} scope: ${unknown.join(', ')}. Allowed: ${allowed.join(', ')}.`);
  if ((await listTokens(c.env.DB, userId)).length >= MAX_TOKENS) throw badRequest('You have many tokens already. Remove one you no longer use.', 'too_many_tokens');

  const secret = newToken(body.kind === 'agent' ? 'wit_agent_' : 'wit_dev_');
  const unique = [...new Set(scopes)];
  const row = await createToken(c.env.DB, {
    userId,
    kind: body.kind,
    label: body.label,
    tokenHash: await hashToken(secret),
    scopes: unique,
    now: c.get('now'),
  });
  // The token summary plus the plaintext token, once (SPEC §10.1 CreatedToken).
  return c.json({ ...tokenInfo(row), token: secret, configs: tokenConfigs(c.get('cfg'), body.kind, secret, unique) }, 201);
});

tokensApi.delete('/:id', requireSession, async (c) => {
  const revoked = await revokeToken(c.env.DB, requireUser(c).userId, c.req.param('id'), c.get('now'));
  if (!revoked) throw notFound('That token does not exist or was already removed.');
  return c.json({ ok: true });
});
