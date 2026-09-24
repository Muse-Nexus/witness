/**
 * Muse Nexus Witness core Worker: HTTP (REST, MCP, pages), inbound email and
 * the cron that delivers the rhythm.
 */
import { runScheduled } from './cron.js';
import type { AppEnv } from './env.js';
import { createApp } from './http/app.js';
import { handleInboundEmail } from './inbound-email.js';

const app = createApp();

export default {
  fetch: app.fetch,

  async email(message, env, _ctx) {
    try {
      const result = await handleInboundEmail(message, env);
      const detail =
        result.outcome === 'captured'
          ? { status: result.result.status }
          : result.outcome === 'confirmation'
            ? { provider: result.provider }
            : { reason: result.reason };
      console.log(JSON.stringify({ event: 'inbound', outcome: result.outcome, ...detail }));
    } catch (error) {
      // Never bounce allowed mail on our own failure: a bounce can make Gmail turn forwarding off.
      console.error(JSON.stringify({ event: 'inbound.error', error: error instanceof Error ? error.name : 'unknown' }));
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runScheduled(env, controller.scheduledTime));
  },
} satisfies ExportedHandler<AppEnv>;
