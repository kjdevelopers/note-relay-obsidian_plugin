import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { hostingIntent } from '../src/status-text';

/**
 * Producer → consumer joins.
 *
 * The pattern this project kept hitting: a tested helper whose caller discarded its output. Each test here reads the
 * consumer's source and asserts it still routes through the helper, so "the module has tests" cannot stand in for "the
 * customer sees it". These are structural on purpose — a behavioural test of `main.ts` would need Obsidian, and a
 * behavioural test of a stub that calls the helper proves nothing about the real file.
 */

const read = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');

test('the settings switch sets the state it reports instead of flipping it', () => {
  const settings = read('settings-tab.ts');
  assert.match(settings, /\.onChange\(value => \{ this\.plugin\.setHosting\(value\)/,
    'the switch must pass the requested value on, not call a blind toggle');
  assert.doesNotMatch(settings, /onChange\(\(\) => \{ this\.plugin\.toggleHosting\(\)/,
    'a toggle that ignores its own value inverts whenever the pane\'s render is stale');
});

test('the status line is produced by one function, not assembled in the consumer', () => {
  const main = read('main.ts');
  assert.match(main, /return describeStatus\(\{/);
  // If any status sentence reappears as a literal in main.ts, the tested function is no longer the only source.
  for (const fragment of ['remote presence active', 'remote lease pending', 'relay refused, retrying',
    'vault not linked', 'plugin update required', 'remote unavailable']) {
    assert.equal(main.includes(`'${fragment}`), false, `main.ts builds the "${fragment}" sentence itself`);
    assert.equal(main.includes(`\`${fragment}`), false, `main.ts builds the "${fragment}" sentence itself`);
  }
});

test('the pairing modal shows the flow\'s message rather than replacing it', () => {
  const main = read('main.ts');
  assert.match(main, /messageOfThrown\(error, 'Confirming failed/);
  assert.match(main, /messageOfThrown\(error, 'Pairing code unavailable/);
  // The generic sentence may only exist as a fallback argument, never as a hard-coded result.
  assert.doesNotMatch(main, /setText\('Pairing unavailable or expired/);
});

test('the diagnostics copy and the status bar are the same text', () => {
  const main = read('main.ts');
  assert.match(main, /hostingStatus\(\): string \{ return this\.statusText\(\); \}/,
    'the settings pane must not report a different state from the status bar');
});

// Behaviour of the decision itself, which the consumer above delegates to.

test('a switch asking for the state it is already in does nothing', () => {
  assert.equal(hostingIntent(true, true), 'noop');
  assert.equal(hostingIntent(false, false), 'noop');
});

test('a switch asking for the other state starts or stops exactly once', () => {
  assert.equal(hostingIntent(false, true), 'start');
  assert.equal(hostingIntent(true, false), 'stop');
});

test('the decision is total: no combination returns undefined', () => {
  for (const current of [true, false]) {
    for (const requested of [true, false]) {
      assert.ok(['start', 'stop', 'noop'].includes(hostingIntent(current, requested)));
    }
  }
});

test('the replace-key dialog routes every outcome through the tested vocabulary', () => {
  const main = read('main.ts');
  assert.match(main, /describeReplacementFailure\(error\)/, 'a failure must name its cause');
  assert.match(main, /replacementSuccessText\(/, 'success must state the consequence, not just the new fingerprint');
  // The old one-size sentence and the bare reassurance are gone: both hid which thing happened.
  assert.doesNotMatch(main, /Key replacement failed\. The current key was not changed\./);
  assert.doesNotMatch(main, /New fingerprint: \$\{/);
  // A non-retryable failure must not leave a button that invites the same failure again.
  assert.match(main, /button\.disabled = !failure\.retryable/);
});
