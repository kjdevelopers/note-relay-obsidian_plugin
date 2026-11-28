import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeStatus, type StatusSnapshot } from '../src/status-text';
import { READER_WAIT_STATUS } from '../src/host-waiting';

/**
 * The status bar is the plugin's only always-visible claim about the product's state, and it has been wrong in
 * production twice: `hosting on; remote unavailable` for two days while the vault was dark, and a presence lease
 * reported as though a lease were a connection. These tests exist so the third time is a failing assertion.
 */

const base: StatusSnapshot = {
  hostEnabled: true, readerWaiting: false, leaseActive: false, remoteStatus: null, relay: 'connected',
};
const status = (over: Partial<StatusSnapshot>) => describeStatus({ ...base, ...over });

test('hosting off is the only state that may say off', () => {
  assert.equal(status({ hostEnabled: false }), 'off');
  // Nothing else can produce 'off' — a vault that is hosting may be many things, but not this one.
  for (const over of [{ leaseActive: true }, { readerWaiting: true }, { relay: 'closed' as const },
    { remoteStatus: 'unpaired' as const }]) {
    assert.notEqual(status(over), 'off');
  }
});

test('a lease without a live socket is never presented as a connection', () => {
  // The invariant: a lease outlives its socket by up to five minutes, so "remote presence active" alone is a lie.
  for (const relay of ['connecting', 'closed'] as const) {
    const text = status({ leaseActive: true, relay });
    assert.match(text, /remote presence active/, 'the lease is real and should still be reported');
    assert.match(text, /relay reconnecting/, `relay '${relay}' must be named beside the lease`);
  }
});

test('a lease beside an open relay says so without noise', () => {
  assert.equal(status({ leaseActive: true, relay: 'connected' }), 'remote presence active');
  // An undefined relay means no signal client exists yet, which is not a fault worth a suffix.
  assert.equal(status({ leaseActive: true, relay: undefined }), 'remote presence active');
  assert.equal(status({ leaseActive: true, relay: 'off' }), 'remote presence active');
});

test('no lease and no reason is "lease pending", not a success', () => {
  assert.equal(status({ leaseActive: false, remoteStatus: null }), 'hosting on; remote lease pending');
});

test('each named refusal has its own sentence, and none of them claims success', () => {
  const cases: Array<[StatusSnapshot['remoteStatus'], RegExp]> = [
    ['unpaired', /vault not paired/],
    ['blocked', /plugin update required/],
    ['unlinked', /not linked, re-pair/],
    ['refused', /relay refused, retrying/],
    ['unavailable', /remote unavailable/],
  ];
  const seen = new Set<string>();
  for (const [remoteStatus, expected] of cases) {
    const text = status({ remoteStatus });
    assert.match(text, expected);
    assert.doesNotMatch(text, /presence active/, `${remoteStatus} must not read as a success`);
    assert.equal(seen.has(text), false, `${remoteStatus} duplicates another refusal's sentence`);
    seen.add(text);
  }
});

test('a waiting reader is reported as its own state, not as an idle host', () => {
  assert.equal(status({ readerWaiting: true, leaseActive: true }), READER_WAIT_STATUS);
  // The constant is shared with the reader-wait monitor, so the two cannot disagree about what waiting looks like.
  // Asserted as the shared value rather than a copy of its text: the point is that there is one definition.
  assert.match(READER_WAIT_STATUS, /waiting/i);
  // Waiting outranks every refusal detail: the vault is serving, and the reason it is held is the reader.
  assert.equal(status({ readerWaiting: true, remoteStatus: 'refused' }), READER_WAIT_STATUS);
});

test('a refusal during a relay outage keeps both facts', () => {
  assert.equal(status({ remoteStatus: 'refused', relay: 'closed' }), 'hosting on; relay refused, retrying');
  // Refusals without a lease do not carry the relay suffix: the refusal already says the relay is the problem.
  assert.doesNotMatch(status({ remoteStatus: 'unavailable', relay: 'closed' }), /relay reconnecting/);
});

test('the status line never contains a path, a token or an email', () => {
  const shapes = [/\.md\b/, /\//, /@/, /eyJ/, /bearer/i, /\b[0-9a-f]{32,}\b/];
  const texts = [
    status({}), status({ hostEnabled: false }), status({ leaseActive: true }),
    status({ leaseActive: true, relay: 'closed' }), status({ readerWaiting: true }),
    ...(['unpaired', 'blocked', 'unlinked', 'refused', 'unavailable'] as const).map(remoteStatus => status({ remoteStatus })),
  ];
  for (const text of texts) {
    for (const shape of shapes) assert.doesNotMatch(text, shape, `"${text}" matches ${shape}`);
  }
});
