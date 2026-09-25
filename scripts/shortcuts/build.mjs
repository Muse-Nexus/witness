#!/usr/bin/env bun
// Builds the ready-made "Send to Witness" and "Send image to Witness" shortcuts: writes
// each as an XML property list, lints it, converts it to binary, signs it with Apple's
// `shortcuts sign --mode anyone`, then opens the signed file again and checks that what
// Shortcuts will run still sends the right request and holds no key.
//
//   bun run shortcuts                                        for https://witness.musenexus.studio
//   bun run shortcuts --app-url https://witness.example.com  for your own Witness
//   bun run shortcuts --unsigned --out /tmp/witness-shortcuts
//                                   unsigned files and XML to read; nothing in the app changes
//   bun run shortcuts:verify        open the committed signed files and check them again
//                                   (CI runs this on macOS, so the downloads never go stale)
//
// Signing needs macOS 12 or later, signed in to iCloud. The signed files go to
// apps/web/public/shortcuts/ and apps/web/src/lib/shortcuts.json records the Witness they
// send to, so Setup only offers them there. Apple's signing certificate is short-lived
// (about a year); the script prints its end date. Rebuild before then.
import { spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { BUILDERS, DEFAULT_APP_URL, EXTRACTED_TEXT, KEY_VARIABLE, SHORTCUTS, captureUrl, describeRequest, toPlistXml } from './workflow.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PUBLIC_DIR = join(ROOT, 'apps/web/public/shortcuts');
const MANIFEST = join(ROOT, 'apps/web/src/lib/shortcuts.json');

const { values: args } = parseArgs({
  options: {
    'app-url': { type: 'string', default: DEFAULT_APP_URL },
    out: { type: 'string' },
    unsigned: { type: 'boolean', default: false },
    verify: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (args.help) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 16).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}

class BuildError extends Error {}
function fail(message) {
  throw new BuildError(message);
}

function run(cmd, cmdArgs) {
  const result = spawnSync(cmd, cmdArgs, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { ok: result.status === 0, status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error };
}

function must(cmd, cmdArgs) {
  const r = run(cmd, cmdArgs);
  if (!r.ok) fail(`${cmd} ${cmdArgs.join(' ')} failed (${r.status ?? r.error?.message}):\n${r.stdout}${r.stderr}`);
  return r;
}

/** Fill-ins for reading a request back. None of them looks like a real key. */
const PROBE = { [KEY_VARIABLE]: 'KEY', ExtensionInput: 'INPUT', 'Base64 Encoded': 'BASE64', [EXTRACTED_TEXT]: 'TEXT' };
const KEY_PATTERN = /wit_(dev|agent|sess|link)_[A-Za-z0-9_-]{8,}/;

/** A signed shortcut is an Apple Encrypted Archive (signed, not encrypted) around Shortcut.wflow. */
function openSigned(file, dir) {
  const bytes = readFileSync(file);
  if (bytes.subarray(0, 4).toString('latin1') !== 'AEA1') fail(`${file} is not a signed shortcut (no AEA1 header)`);
  const authSize = bytes.readUInt32LE(8);
  const auth = join(dir, 'auth.plist');
  writeFileSync(auth, bytes.subarray(12, 12 + authSize));
  const der = Buffer.from(must('plutil', ['-extract', 'SigningCertificateChain.0', 'raw', '-o', '-', auth]).stdout.trim(), 'base64');
  const cert = new X509Certificate(der);
  const pub = join(dir, 'signer.pem');
  writeFileSync(pub, cert.publicKey.export({ type: 'spki', format: 'pem' }));
  const archive = join(dir, 'payload.aar');
  must('aea', ['decrypt', '-i', file, '-o', archive, '-sign-pub', pub]);
  const extracted = join(dir, 'payload');
  mkdirSync(extracted, { recursive: true });
  must('aa', ['extract', '-i', archive, '-d', extracted]);
  const workflow = JSON.parse(must('plutil', ['-convert', 'json', '-o', '-', join(extracted, 'Shortcut.wflow')]).stdout);
  return { workflow, cert };
}

/** What Shortcuts itself wrote into the signed file must still do what we built. */
function check(name, built, signed) {
  const problems = [];
  const expected = describeRequest(built, PROBE);
  const actual = describeRequest(signed, PROBE);
  if (!isDeepStrictEqual(actual, expected)) problems.push(`request changed:\n${JSON.stringify(actual, null, 2)}`);
  if (actual.headers.Authorization !== `Bearer ${PROBE[KEY_VARIABLE]}`) problems.push('Authorization is not Bearer + the key variable');
  const [question] = signed.WFWorkflowImportQuestions ?? [];
  const asked = question && signed.WFWorkflowActions[question.ActionIndex];
  if (asked?.WFWorkflowActionIdentifier !== 'is.workflow.actions.gettext' || question.ParameterKey !== 'WFTextActionText') {
    problems.push('the import question does not point at the key Text action');
  } else if (asked.WFWorkflowActionParameters.WFTextActionText) {
    problems.push('the key Text action is not empty');
  }
  if (KEY_PATTERN.test(JSON.stringify(signed))) problems.push('something that looks like a key is inside');
  if (!signed.WFWorkflowTypes?.includes('ActionExtension')) problems.push('not in the share sheet');
  if (!isDeepStrictEqual(signed.WFWorkflowInputContentItemClasses, built.WFWorkflowInputContentItemClasses)) problems.push('input types changed');
  if (built.WFWorkflowNoInputBehavior && !isDeepStrictEqual(signed.WFWorkflowNoInputBehavior, built.WFWorkflowNoInputBehavior)) {
    problems.push(`no-input behavior changed: ${JSON.stringify(signed.WFWorkflowNoInputBehavior)}`);
  }
  const actionIds = (w) => w.WFWorkflowActions.map((x) => x.WFWorkflowActionIdentifier);
  if (!isDeepStrictEqual(actionIds(signed), actionIds(built))) problems.push(`actions changed: ${actionIds(signed).join(', ')}`);
  if (problems.length) fail(`${name}: the signed file does not match what was built:\n- ${problems.join('\n- ')}`);
}

/** The Witness to build for: exactly an origin (https, or localhost), never quietly trimmed. */
function originOf(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail(`--app-url is not a URL: ${raw}`);
  }
  if (url.pathname !== '/' || url.search || url.hash || /[/?#]$/.test(raw.replace(/^[a-z]+:\/\//i, ''))) {
    fail(`--app-url must be just the origin, like ${DEFAULT_APP_URL} (no path, query or trailing slash): ${raw}`);
  }
  captureUrl(url.origin); // https origins only (localhost aside)
  return url.origin;
}

if (process.platform !== 'darwin') {
  console.error('✗ This needs macOS: plutil, shortcuts, aea and aa are Apple tools.');
  process.exit(1);
}

/** Opens the committed signed files and checks them against what the builder makes today. */
function verifyPublished() {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const work = mkdtempSync(join(tmpdir(), 'witness-shortcuts-verify-'));
  try {
    for (const { id, name, file } of SHORTCUTS) {
      const listed = manifest.shortcuts.find((s) => s.id === id);
      if (listed?.href !== `/shortcuts/${file}`) fail(`${MANIFEST.replace(ROOT, '')} does not list ${name} at /shortcuts/${file}`);
      const opened = join(work, id);
      mkdirSync(opened);
      const { workflow: inside, cert } = openSigned(join(PUBLIC_DIR, file), opened);
      check(name, BUILDERS[id]({ appUrl: manifest.appUrl }), inside);
      const ends = new Date(cert.validTo);
      if (ends.getTime() - Date.now() < 30 * 24 * 60 * 60 * 1000) fail(`${name}: Apple's signing certificate ends ${ends.toISOString().slice(0, 10)}; rebuild with bun run shortcuts`);
      console.log(`ok   ${name}: the published file matches the builder (sends to ${manifest.appUrl}, certificate ends ${ends.toISOString().slice(0, 10)})`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (args.verify) {
  try {
    verifyPublished();
  } catch (error) {
    if (!(error instanceof BuildError)) throw error;
    console.error(`\n✗ ${error.message}`);
    process.exit(1);
  }
  process.exit(0);
}

let appUrl;
try {
  appUrl = originOf(args['app-url']);
} catch (error) {
  if (!(error instanceof BuildError)) throw error;
  console.error(`✗ ${error.message}`);
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), 'witness-shortcuts-'));
const out = resolve(args.out ?? (args.unsigned ? join(tmpdir(), 'witness-shortcuts-unsigned') : PUBLIC_DIR));
let certificateEnds = null;
try {
  mkdirSync(out, { recursive: true });
  for (const { id, name, file } of SHORTCUTS) {
    const workflow = BUILDERS[id]({ appUrl });
    const xml = join(work, `${id}.plist`);
    const unsigned = join(work, `${id}.unsigned.shortcut`);
    writeFileSync(xml, toPlistXml(workflow));
    must('plutil', ['-lint', xml]);
    must('plutil', ['-convert', 'binary1', '-o', unsigned, xml]);

    if (args.unsigned) {
      copyFileSync(xml, join(out, file.replace(/\.shortcut$/, '.plist')));
      copyFileSync(unsigned, join(out, file.replace(/\.shortcut$/, '.unsigned.shortcut')));
      console.log(`ok   ${name}: unsigned, not importable until signed`);
      continue;
    }

    const signedByService = join(work, `${id}.signed.shortcut`);
    const signing = run('shortcuts', ['sign', '--mode', 'anyone', '--input', unsigned, '--output', signedByService]);
    if (!signing.ok) {
      fail(
        `shortcuts sign failed for ${name} (exit ${signing.status ?? signing.error?.message}):\n${signing.stdout}${signing.stderr}\n` +
          'Signing needs macOS 12 or later, signed in to iCloud. `--unsigned --out <folder>` still writes the files to read.',
      );
    }
    // The signing service removes the file it wrote a minute or two later, so keep our own copy at once.
    const signed = join(work, file);
    copyFileSync(signedByService, signed);
    rmSync(signedByService, { force: true });

    const opened = join(work, `${id}-opened`);
    mkdirSync(opened);
    const { workflow: inside, cert } = openSigned(signed, opened);
    check(name, workflow, inside);
    certificateEnds = new Date(cert.validTo);
    copyFileSync(signed, join(out, file));
    chmodSync(join(out, file), 0o644);
    console.log(`ok   ${name}: signed, checked, ${readFileSync(signed).length} bytes → ${join(out, file).replace(ROOT, '')}`);
  }

  if (!args.unsigned && out === PUBLIC_DIR) {
    const manifest = { appUrl, shortcuts: SHORTCUTS.map(({ id, name, file }) => ({ id, name, href: `/shortcuts/${file}` })) };
    writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`ok   ${MANIFEST.replace(ROOT, '')}: offered on ${appUrl}`);
  }
  if (certificateEnds) console.log(`\nSigned for anyone. Apple's signing certificate ends ${certificateEnds.toISOString().slice(0, 10)}: rebuild before then.`);
  if (args.unsigned) console.log(`\nWrote ${out}`);
} catch (error) {
  if (!(error instanceof BuildError)) throw error;
  console.error(`\n✗ ${error.message}`);
  process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
