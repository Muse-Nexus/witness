/**
 * Routes (SPEC §8). Everything under /api/v1, /auth, /d and /mcp is handled
 * here; every other path is the web app, served from static assets.
 */
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { ConfigError } from '../env.js';
import { handleMcpRequest } from '../mcp.js';
import { AGENT_SCOPES, type AgentScope } from '../store/tokens.js';
import { authenticate } from './auth.js';
import { initRequest, type HonoEnv } from './context.js';
import { ApiError, errorBody, forbidden, unauthorized } from './errors.js';
import { securityHeaders } from './middleware.js';
import { accountApi } from './routes/account.js';
import { addressesApi, inboundApi } from './routes/addresses.js';
import { authApi, authPages } from './routes/auth.js';
import { CAPTURE_BODY_LIMIT, captureApi, tooLarge } from './routes/capture.js';
import { deliveryPages } from './routes/delivery.js';
import { itemsApi } from './routes/items.js';
import { meApi } from './routes/me.js';
import { rhythmApi } from './routes/rhythm.js';
import { sendersApi } from './routes/senders.js';
import { tokensApi } from './routes/tokens.js';

const JSON_BODY_LIMIT = 64 * 1024;

function isLargeUpload(path: string, method: string): boolean {
  return method === 'POST' && (path === '/api/v1/capture' || path === '/api/v1/items' || path === '/api/v1/items/');
}

export function createApp(): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();

  for (const path of ['/api/*', '/auth/*', '/d', '/d/*', '/mcp']) app.use(path, securityHeaders);
  app.use('*', async (c, next) => {
    initRequest(c);
    await next();
  });

  // Small JSON bodies everywhere except the two routes that accept images.
  const smallBodies = bodyLimit({ maxSize: JSON_BODY_LIMIT, onError: tooLarge });
  const largeBodies = bodyLimit({ maxSize: CAPTURE_BODY_LIMIT, onError: tooLarge });
  app.use('/api/*', (c, next) => (isLargeUpload(c.req.path, c.req.method) ? largeBodies(c, next) : smallBodies(c, next)));
  app.use('/auth/*', smallBodies);
  app.use('/d', smallBodies);
  app.use('/d/*', smallBodies);
  app.use('/mcp', bodyLimit({ maxSize: 1024 * 1024, onError: tooLarge }));

  app.use('/api/v1/*', authenticate);
  app.route('/api/v1/auth', authApi);
  app.route('/api/v1', meApi);
  app.route('/api/v1/items', itemsApi);
  app.route('/api/v1/capture', captureApi);
  app.route('/api/v1/rhythm', rhythmApi);
  app.route('/api/v1/tokens', tokensApi);
  app.route('/api/v1/addresses', addressesApi);
  app.route('/api/v1/inbound', inboundApi);
  app.route('/api/v1/blocked-senders', sendersApi);
  app.route('/api/v1', accountApi);
  app.all('/api/*', (c) => c.json(errorBody('not_found', 'No such endpoint.'), 404));

  app.route('/auth', authPages);
  app.route('/d', deliveryPages);

  app.post('/mcp', authenticate, async (c) => {
    const auth = c.get('auth');
    if (!auth) throw unauthorized('Connect with an assistant token from Witness settings.');
    if (auth.kind !== 'token' || auth.tokenKind !== 'agent') throw forbidden('MCP needs an assistant token (wit_agent_…).');
    return handleMcpRequest(c.req.raw, {
      env: c.env,
      cfg: c.get('cfg'),
      keyring: c.get('keyring'),
      now: c.get('now'),
      userId: auth.userId,
      tokenId: auth.tokenId,
      tokenLabel: auth.label,
      scopes: auth.scopes.filter((s): s is AgentScope => (AGENT_SCOPES as readonly string[]).includes(s)),
    });
  });
  app.all('/mcp', (c) => {
    c.header('Allow', 'POST');
    return c.json(errorBody('method_not_allowed', 'This MCP server is stateless: send JSON-RPC with POST.'), 405);
  });

  // Anything else is the web app (single-page app fallback lives in the assets config).
  app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

  app.onError((error, c) => {
    if (error instanceof ApiError) {
      for (const [name, value] of Object.entries(error.headers)) c.header(name, value);
      return c.json(errorBody(error.code, error.message), error.status);
    }
    // Log the kind of failure, never request content.
    // The route pattern, never the path or query: links carry signed tokens.
    console.error(JSON.stringify({ event: 'http.error', route: c.req.routePath, error: error.name, config: error instanceof ConfigError ? error.message : undefined }));
    return c.json(errorBody('internal', 'Something went wrong on our side. Try again in a moment.'), 500);
  });

  return app;
}
