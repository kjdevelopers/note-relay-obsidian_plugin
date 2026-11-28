/**
 * The release ancestry gate: a required fix that is not in the released tree is not a fix.
 *
 * These tests run the real script against real refs in this repository, because the failure this guards against was
 * not a logic error — it was nobody asking the question. A unit test over a mocked git would have passed happily
 * while 0.2.20 through 0.2.35 shipped without the binding correction.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const run = (args: string[]) => {
  try {
    const out = execFileSync('node', ['scripts/check-release-ancestry.mjs', ...args],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failure.status ?? 1, out: String(failure.stdout ?? '') + String(failure.stderr ?? '') };
  }
};

test('the working tree carries every required fix', () => {
  const { code, out } = run([]);
  assert.equal(code, 0, out);
  assert.match(out, /release-ancestry OK/);
});

test('a release that predates the binding correction is refused', () => {
  // 0.2.35 is the shipped build. The gate must say no to it, or it is not a gate.
  const { code, out } = run(['--at', '0.2.35']);
  assert.equal(code, 1, out);
  assert.match(out, /account-binding-one-constructor/);
  assert.match(out, /why it matters/);
});

test('an unusable manifest refuses rather than certifying nothing', () => {
  const manifest = join(ROOT, 'release/required-fixes.json');
  const original = readFileSync(manifest, 'utf8');
  try {
    writeFileSync(manifest, JSON.stringify({ required: [] }));
    const { code, out } = run([]);
    assert.equal(code, 2, out);
    assert.match(out, /refusing to certify a release against nothing/);
    writeFileSync(manifest, '{ not json');
    assert.equal(run([]).code, 2);
  } finally {
    writeFileSync(manifest, original);
  }
});

test('the manifest names why each fix matters', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'release/required-fixes.json'), 'utf8'));
  assert.ok(manifest.required.length >= 3);
  for (const entry of manifest.required) {
    assert.equal(typeof entry.why, 'string');
    assert.ok(entry.why.length > 40, `${entry.id} needs a reason a reviewer can judge`);
  }
});
