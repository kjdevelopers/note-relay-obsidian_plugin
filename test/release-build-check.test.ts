import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// The release check is the last thing standing between a development bundle and a published plugin, so
// it has to be exercised as the release job runs it. It previously counted the public site as a second
// application origin and refused a correct production bundle, which would have blocked every release.
//
// Release 0.2.26 is the other half of the lesson: it shipped pointing at the right place and still could
// not reach the service, because it carried no protocol-2 capability. The check now reads the artifact
// for the capabilities the relay refuses without, and these fixtures are complete bundles so a passing
// case means "this is what a publishable artifact contains".
const script = fileURLToPath(new URL('../scripts/check-release-build.mjs', import.meta.url));

function runCheck(bundle: string, extraArgs: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'nr-release-check-'));
  const file = join(dir, 'main.js');
  writeFileSync(file, bundle);
  const result = spawnSync(process.execPath, [script, ...extraArgs, file], { encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/** A bundle shaped like the real release artifact: one origin, the site, and every required capability. */
const CAPABILITIES = `
  const auth = { protocol: 2, capabilities: ['teardown-ack-v1'] };
  const ack = { type: 'teardown-ack' };
  const authority = 'https://api.noterelay.io/v1/authority';
  const key = { 'nr-grant-1': { x: 'pJBuseEXjjCniH07rx5I5ydtZiQRbZwKCYt-AId-pko' } };
`;

const releaseBundle = `
  const worker = 'https://api.noterelay.io';
  const site = 'https://noterelay.io';
  const docs = 'https://developer.mozilla.org/en-US/docs/Web/API';
  ${CAPABILITIES}
`;

test('a release bundle is accepted with the Worker origin, the site and its capabilities', () => {
  const { status, output } = runCheck(releaseBundle);
  assert.equal(status, 0, output);
  assert.match(output, /api\.noterelay\.io/);
  assert.match(output, /capability checks/);
});

test('a development Worker origin is refused', () => {
  const { status, output } = runCheck(`const w = 'https://noterelay-auth-dev.example.workers.dev'; const s = 'https://noterelay.io'; ${CAPABILITIES}`);
  assert.equal(status, 1, output);
  assert.match(output, /development endpoint/);
});

test('two Worker origins are refused even when one of them looks like a release', () => {
  const { status, output } = runCheck(`const a = 'https://api.noterelay.io'; const b = 'https://api2.noterelay.io'; const s = 'https://noterelay.io'; ${CAPABILITIES}`);
  assert.equal(status, 1, output);
  assert.match(output, /expected one Worker origin/);
});

test('a bundle with no Worker origin is refused', () => {
  // The capability strings themselves name no host, so this fixture really has no origin to find.
  const { status, output } = runCheck(`const s = 'https://noterelay.io';
    const auth = { protocol: 2, capabilities: ['teardown-ack-v1'] }; const ack = 'teardown-ack';
    const authority = '/v1/authority'; const key = 'nr-grant-1 pJBuseEXjjCniH07rx5I5ydtZiQRbZwKCYt-AId-pko';`);
  assert.equal(status, 1, output);
  assert.match(output, /no Worker origin/);
});

test('--allow-development reports a development bundle without failing the build', () => {
  const { status } = runCheck("const w = 'http://localhost:8787'; const s = 'https://noterelay.io';", ['--allow-development']);
  assert.equal(status, 0);
});

// The regression that matters: 0.2.26 was a correct-looking release that the relay refused.
test('a bundle without the teardown capability is refused', () => {
  const bundle = `const w = 'https://api.noterelay.io'; const s = 'https://noterelay.io';
    const auth = { protocol: 2 }; const ack = 'teardown-ack';
    const authority = '/v1/authority'; const key = 'nr-grant-1 pJBuseEXjjCniH07rx5I5ydtZiQRbZwKCYt-AId-pko';`;
  const { status, output } = runCheck(bundle);
  assert.equal(status, 1, output);
  assert.match(output, /missing teardown capability/);
});

test('a bundle that authenticates without protocol 2 is refused', () => {
  const bundle = `const w = 'https://api.noterelay.io'; const s = 'https://noterelay.io';
    const auth = { capabilities: ['teardown-ack-v1'] }; const ack = 'teardown-ack';
    const authority = '/v1/authority'; const key = 'nr-grant-1 pJBuseEXjjCniH07rx5I5ydtZiQRbZwKCYt-AId-pko';`;
  const { status, output } = runCheck(bundle);
  assert.equal(status, 1, output);
  assert.match(output, /missing protocol 2 auth frame/);
});

test('a bundle pinned to a key it does not carry the material for is refused', () => {
  const bundle = `const w = 'https://api.noterelay.io'; const s = 'https://noterelay.io';
    const auth = { protocol: 2, capabilities: ['teardown-ack-v1'] }; const ack = 'teardown-ack';
    const authority = '/v1/authority'; const key = 'nr-grant-1';`;
  const { status, output } = runCheck(bundle);
  assert.equal(status, 1, output);
  assert.match(output, /missing production grant key material/);
});

test('a development marker inside an otherwise correct bundle is refused', () => {
  const { status, output } = runCheck(`${releaseBundle}\nconst channel = 'insecure-dev';`);
  assert.equal(status, 1, output);
  assert.match(output, /carries insecure build marker/);
});

test('a private-network endpoint is refused', () => {
  const { status, output } = runCheck(`${releaseBundle}\nconst dev = 'http://10.0.0.5:8080';`);
  assert.equal(status, 1, output);
  assert.match(output, /private-network endpoint/);
});
