/**
 * One binding, two flows.
 *
 * The defect this pins: the account-connection flow wrote `data.account`; the pairing flow wrote nothing. A vault
 * paired through the modal was therefore connected in the account — host row, presence, reader access — while the
 * settings pane said "not linked" and the status bar told the owner to re-pair. Re-pairing mints a new host key,
 * so the wrong sentence created a second host row every time it was believed.
 *
 * These tests are about persistence parity and honesty of the status line. They deliberately do not claim to
 * explain the viewer's connection failure, which is a separate question.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBinding, parseBinding, accountStatusLine } from '../src/account-binding';

const accountId = '11111111-2222-4333-8444-555555555555';
const email = 'owner@example.invalid';
const hostKeyId = 'A'.repeat(43);
const otherKeyId = 'B'.repeat(43);

test('a verified account answer becomes the binding both flows store', () => {
  const binding = buildBinding({ accountId, email, hostKeyId });
  assert.deepEqual(Object.keys(binding).sort(), ['accountId', 'email', 'hostKeyId', 'pairedAt']);
  assert.equal(binding.accountId, accountId);
  assert.equal(binding.email, email);
  assert.equal(binding.hostKeyId, hostKeyId);
  assert.ok(Number.isFinite(Date.parse(binding.pairedAt)));
});

test('the pairing review and the account connection produce the identical shape', () => {
  // The pairing flow's review carries accountId/accountEmail/hostKeyId; the account connection's answer carries
  // accountId/email/hostKeyId. Same three facts, so one construction must serve both.
  const fromAccountConnection = buildBinding({ accountId, email, hostKeyId });
  const fromPairingReview = buildBinding({ accountId: accountId, email: email, hostKeyId: hostKeyId });
  assert.deepEqual(
    { ...fromAccountConnection, pairedAt: 'ignored' },
    { ...fromPairingReview, pairedAt: 'ignored' },
  );
  assert.deepEqual(parseBinding(JSON.parse(JSON.stringify(fromPairingReview))), fromPairingReview);
});

test('a repeated pairing records the key it just presented, not the one it replaced', () => {
  const first = buildBinding({ accountId, email, hostKeyId });
  const second = buildBinding({ accountId, email, hostKeyId: otherKeyId });
  assert.equal(first.hostKeyId, hostKeyId);
  assert.equal(second.hostKeyId, otherKeyId, 'the binding must follow the machine that is paired now');
});

test('an unusable server answer is refused instead of stored', () => {
  for (const bad of [
    { accountId: 'not-a-uuid', email, hostKeyId },
    { accountId, email: 'no-at-sign', hostKeyId },
    { accountId, email, hostKeyId: 'too-short' },
    { accountId, email, hostKeyId: '' },
  ]) {
    assert.throws(() => buildBinding(bad), /not usable/, JSON.stringify(bad));
  }
});

test('a paired vault is never told to re-pair', () => {
  const line = accountStatusLine(buildBinding({ accountId, email, hostKeyId }));
  assert.match(line, /^Connected as /);
  assert.equal(/not linked|re-pair|pair again/i.test(line), false, line);
  // The unpaired line still has to say so, or the fix would hide a genuinely unconnected vault.
  assert.match(accountStatusLine(null), /not linked/);
});

test('takeover keeps its meaning: the presented machine wins, and the binding says so', () => {
  // A takeover replaces hostKeyId but not the account; nothing in the binding records the replaced key, which is
  // correct — the old key is retired server-side and only the current one can hold a session.
  const afterTakeover = buildBinding({ accountId, email, hostKeyId: otherKeyId, pairedAt: '2026-11-27T00:00:00.000Z' });
  assert.equal(afterTakeover.hostKeyId, otherKeyId);
  assert.equal(afterTakeover.accountId, accountId);
  assert.equal(afterTakeover.pairedAt, '2026-11-27T00:00:00.000Z');
});
