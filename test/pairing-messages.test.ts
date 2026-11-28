import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describePairingFailure, PAIRING_BUSY, PAIRING_EXPIRED } from '../src/pairing-messages';
import { PairingFlow } from '../src/pairing-flow';
import { generateHostPairingKey } from '../src/pairing-key';

/**
 * A refused pairing attempt must tell the customer which refusal it was.
 *
 * Every branch of this used to be "Pairing unavailable" — accurate for all of them and actionable for none. The test
 * therefore asserts distinctness as well as presence: two statuses that need different actions must not produce the same
 * sentence, or the message is decoration.
 */

test('each distinct customer action gets its own sentence', () => {
  // Distinctness is asserted across ACTIONS, not across status codes: 404 and 410 are both "get a fresh code", and every
  // 5xx is "the service is down, check your connection". Collapsing those would be right; collapsing a rate limit into a
  // wrong code would be the defect this file exists to prevent.
  const groups: Array<{ statuses: number[]; expect: RegExp }> = [
    { statuses: [400], expect: /Enter the code exactly/i },
    { statuses: [404, 410], expect: /Generate a new code in the browser/i },
    { statuses: [409], expect: /already been used/i },
    { statuses: [413], expect: /too long to send/i },
    { statuses: [429], expect: /Wait a minute/i },
    { statuses: [401, 403], expect: /Sign in again|ask the account owner/i },
    { statuses: [500, 502, 503, 504], expect: /service is unavailable/i },
  ];
  const sentences = new Map<string, number>();
  for (const group of groups) {
    const first = describePairingFailure(group.statuses[0]).message;
    for (const status of group.statuses) {
      const { message } = describePairingFailure(status);
      assert.equal(message, first, `${status} should share the sentence of its action group`);
      assert.match(message, group.expect, `${status} does not say what the person must do`);
      assert.ok(message.length > 40, `${status} produced a stub: ${message}`);
    }
    const already = sentences.get(first);
    assert.equal(already, undefined,
      `${group.statuses[0]} and ${already} produce the same sentence but need different actions`);
    sentences.set(first, group.statuses[0]);
  }
});

test('an expired or unknown code sends the person to the one place that fixes it', () => {
  for (const status of [404, 410, 409]) {
    assert.match(describePairingFailure(status).message, /Generate a new code in the browser/i);
  }
});

test('a rate limit is retryable and says to wait, rather than to re-enter the code', () => {
  const limited = describePairingFailure(429);
  assert.equal(limited.retryable, true);
  assert.match(limited.message, /Wait a minute/i);
  assert.doesNotMatch(limited.message, /Enter the code/i);
});

test('a permission refusal is the one case that is not worth retrying', () => {
  for (const status of [401, 403]) {
    assert.equal(describePairingFailure(status).retryable, false);
    assert.match(describePairingFailure(status).message, /Sign in again|ask the account owner/i);
  }
});

test('a server fault is never reported as the customer\'s mistake', () => {
  for (const status of [500, 502, 503, 504]) {
    const { message } = describePairingFailure(status);
    assert.match(message, /service is unavailable/i);
    assert.doesNotMatch(message, /code was not accepted|expired/i);
  }
});

test('an unknown status still says what to do next', () => {
  const { message } = describePairingFailure(418);
  assert.match(message, /HTTP 418/);
  assert.match(message, /diagnostic log/i);
});

test('the flow surfaces the status it already had, instead of discarding it at the throw', async () => {
  const accountId = crypto.randomUUID();
  const pairingId = crypto.randomUUID();
  const challenge = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
  const api = {
    async lookup() {
      return { accountId, pairingId, challenge, accountEmail: 'owner@example.invalid',
        expiresAt: new Date(Date.now() + 120_000).toISOString() };
    },
    async present() { return { ok: false, status: 429 }; },
    async confirm() { return true; },
  };
  const flow = new PairingFlow(api as never, async () => (await generateHostPairingKey()) as never);
  await assert.rejects(() => flow.review('ABCDE-FGHIJ', crypto.randomUUID(), 'My vault'), (error: Error) => {
    assert.match(error.message, /Wait a minute/i, `got: ${error.message}`);
    assert.doesNotMatch(error.message, /Pairing unavailable/);
    return true;
  });
});

test('confirming with nothing pending says how to start, not that pairing is unavailable', async () => {
  const api = { async lookup() { return {}; }, async present() { return { ok: true, status: 200 }; }, async confirm() { return true; } };
  const flow = new PairingFlow(api as never, async () => ({} as never));
  await assert.rejects(() => flow.confirm(), /no pairing waiting/i);
  assert.match(PAIRING_EXPIRED, /Start pairing again/i);
  assert.match(PAIRING_BUSY, /cancel/i);
});
