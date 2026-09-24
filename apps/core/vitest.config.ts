import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          // Pinned so a developer's .dev.vars never changes what the tests see.
          bindings: {
            TEST_MIGRATIONS: migrations,
            // Test-only key (32 bytes of 0x01). Never a real secret.
            WITNESS_MASTER_KEY: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=',
            APP_URL: 'http://localhost:8787',
            INBOUND_DOMAIN: 'in.example.com',
            INBOUND_ADDRESS_STYLE: 'plus',
            INBOUND_PLUS_USER: 'witness',
            MAIL_FROM: 'Witness <witness@example.com>',
            MAILER: 'log',
            SIGNUPS: 'open',
            ALLOWED_EMAILS: '',
            WITNESS_JUDGE: 'none',
            WITNESS_MODEL: 'claude-haiku-4-5',
            RESEND_API_KEY: '',
            ANTHROPIC_API_KEY: '',
          },
        },
      }),
    ],
    test: {
      include: ['test/**/*.test.ts'],
      setupFiles: ['./test/setup.ts'],
    },
  };
});
