#!/usr/bin/env bun
// Local development setup for Muse Nexus Witness (docs/SELF_HOSTING.md, "Local development").
//
//   bun run setup:dev          writes apps/core/.dev.vars (if missing) and applies the local D1 migrations
//   bun scripts/setup-dev.mjs --check   exits non-zero with a pointer here when .dev.vars is not ready
//
// .dev.vars is git-ignored. The master key it writes is random and only for your machine.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const CORE = join(ROOT, 'apps/core');
const DEV_VARS = join(CORE, '.dev.vars');

function masterKeyProblem() {
  if (!existsSync(DEV_VARS)) return 'apps/core/.dev.vars does not exist yet.';
  const line = readFileSync(DEV_VARS, 'utf8')
    .split('\n')
    .find((l) => l.startsWith('WITNESS_MASTER_KEY='));
  if (!line) return 'apps/core/.dev.vars has no WITNESS_MASTER_KEY.';
  const value = line.slice('WITNESS_MASTER_KEY='.length).trim();
  try {
    if (Buffer.from(value, 'base64').length !== 32) return 'WITNESS_MASTER_KEY in apps/core/.dev.vars is not 32 bytes of base64.';
  } catch {
    return 'WITNESS_MASTER_KEY in apps/core/.dev.vars is not base64.';
  }
  return null;
}

if (process.argv.includes('--check')) {
  const problem = masterKeyProblem();
  if (problem) {
    console.error(`${problem}\nRun this once first:  bun run setup:dev`);
    process.exit(1);
  }
  process.exit(0);
}

if (existsSync(DEV_VARS)) {
  console.log('apps/core/.dev.vars already exists; leaving it as it is.');
} else {
  writeFileSync(
    DEV_VARS,
    [
      '# Local development only (written by bun run setup:dev). Never commit this file.',
      `WITNESS_MASTER_KEY=${randomBytes(32).toString('base64')}`,
      '# Mail is printed to the terminal and kept at http://localhost:8787/api/v1/dev/outbox.',
      'MAILER=log',
      'APP_URL=http://localhost:8787',
      '# Anyone can sign up locally (the deployed default is invite-only).',
      'SIGNUPS=open',
      '',
    ].join('\n'),
  );
  console.log('Wrote apps/core/.dev.vars with a random local master key, MAILER=log and SIGNUPS=open.');
}

const problem = masterKeyProblem();
if (problem) {
  console.error(problem);
  process.exit(1);
}

const migrate = spawnSync('bun', ['run', 'db:migrate:local'], { cwd: CORE, stdio: 'inherit' });
if (migrate.status !== 0) process.exit(migrate.status ?? 1);
console.log('Ready. Start it with:  bun run dev   (then open http://localhost:8787)');
