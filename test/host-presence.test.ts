import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HostPresenceClient, MAX_ACCEPTED_LEASE_MS, RENEW_INTERVAL_MS, RETRY_MAX_MS,
  RETRY_START_MS, WATCHDOG_MS, presenceDelayMs } from '../src/host-presence';
import { generateHostPairingKey } from '../src/pairing-key';
import type { StoredHostKey } from '../src/pairing-key-store';
import type { PresenceProof } from '../src/host-presence-proof';

const VAULT_ID = 'b1a0f81c-208b-4ecf-b49e-9bb95aa94382';
const SESSION = 'a'.repeat(48);

type Reply = { expiresAtMs?: unknown; entitlementRevision?: unknown; stopped?: unknown };

/**
 * A client wired to nothing: the transport is a queue of scripted replies, the clock is a variable,
 * and the scheduler records the delay instead of waiting for it. That is enough to assert the two
 * properties a real relay cost an owner days to discover — that a long lease is accepted, and that a
 * refusal is retried instead of ending presence.
 */
async function harness(replies: Array<{ status: number; body: Reply } | Error>, nowMs = 1_760_000_000_000) {
  const generated = await generateHostPairingKey();
  const key: StoredHostKey = { vaultId: VAULT_ID, privateKey: generated.privateKey,
    publicJwk: generated.publicJwk };
  const sent: PresenceProof[] = [];
  const delays: number[] = [];
  const failures: Array<{ reason: string; terminal: boolean }> = [];
  const leases: number[] = [];
  const timers: Array<() => void> = [];
  const clock = { now: nowMs };
  const client = new HostPresenceClient(VAULT_ID, SESSION, key,
    async proof => {
      sent.push(proof);
      const next = replies.shift();
      if (!next) throw new Error('no scripted reply');
      if (next instanceof Error) throw next;
      return { status: next.status, body: next.body };
    },
    () => clock.now,
    (reason, terminal) => { failures.push({ reason, terminal }); },
    lease => { leases.push(lease.expiresAtMs); },
    (handler, ms) => { delays.push(ms); timers.push(handler); return handler; },
    () => {});
  return { client, sent, delays, failures, leases, timers, clock };
}

/** Let the signing promise and the injected transport settle; crypto.subtle resolves on a task. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise<void>(resolve => { setTimeout(resolve, 0); });
}

test('accepts the ten-minute lease the relay actually issues', async () => {
  // The regression: the client checked `expiresAt <= now + 65 s`, so a 600 s lease was discarded as
  // "implausible" and the host held no local lease at all. Every socket is gated on that lease.
  const base = 1_760_000_000_000;
  const h = await harness([{ status: 200, body: { expiresAtMs: base + 600_000, entitlementRevision: 3 } }], base);
  h.client.start();
  await settle();
  assert.ok(h.client.lease(), 'a 600 s lease must be held');
  assert.equal(h.leases.length, 1);
});

test('still refuses a lease that is already expired or absurdly long', async () => {
  const expired = await harness([{ status: 200, body: { expiresAtMs: 1_759_999_000_000, entitlementRevision: 1 } }]);
  expired.client.start(); await settle();
  assert.equal(expired.client.lease(), null);

  const absurd = await harness([{ status: 200, body: {
    expiresAtMs: 1_760_000_000_000 + MAX_ACCEPTED_LEASE_MS + 60_000, entitlementRevision: 1 } }]);
  absurd.client.start(); await settle();
  assert.equal(absurd.client.lease(), null);
});

test('a refused renewal is retried, not treated as the end of hosting', async () => {
  // The observed failure: one 403 on a renewal stopped the loop for good, and the vault stayed dark
  // until the owner toggled hosting off and on. Presence must survive it.
  const base = 1_760_000_000_000;
  const h = await harness([
    { status: 403, body: {} },
    { status: 200, body: { expiresAtMs: base + 600_000, entitlementRevision: 2 } },
  ], base);
  h.client.start();
  await settle();
  assert.equal(h.failures.length, 1, 'the refusal is reported once');
  assert.equal(h.failures[0].terminal, false);
  assert.equal(h.delays.at(-1), RETRY_START_MS, 'the retry is scheduled, not dropped');
  assert.equal(h.timers.length, 1);

  h.timers[0]();
  await settle();
  assert.equal(h.sent.length, 2, 'the retry really sent a second proof');
  assert.ok(h.client.lease(), 'the retry recovered a working lease');
});

test('a blocked build stops instead of retrying into the refusal', async () => {
  const h = await harness([{ status: 426, body: {} }]);
  h.client.start();
  await settle();
  assert.equal(h.failures.length, 1);
  assert.equal(h.failures[0].terminal, true);
  assert.equal(h.timers.length, 0, 'no timer is scheduled after a terminal refusal');
  assert.equal(h.client.lease(), null);
});

test('a network failure backs off to a ceiling rather than spinning', async () => {
  const h = await harness([new Error('offline'), new Error('offline'), new Error('offline'),
    new Error('offline'), new Error('offline'), new Error('offline'), new Error('offline')]);
  h.client.start();
  await settle();
  for (let i = 0; i < 6; i += 1) { h.timers.at(-1)!(); await settle(); }
  assert.deepEqual(h.delays, [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, RETRY_MAX_MS]);
});

test('the watchdog renews as soon as the lease has lapsed, and only then', async () => {
  const base = 1_760_000_000_000;
  const h = await harness([
    { status: 200, body: { expiresAtMs: base + 600_000, entitlementRevision: 1 } },
    { status: 200, body: { expiresAtMs: base + 1_200_000, entitlementRevision: 1 } },
  ], base);
  h.client.start();
  await settle();
  assert.equal(h.sent.length, 1);

  h.client.kick();
  await settle();
  assert.equal(h.sent.length, 1, 'a healthy lease makes kick a no-op');

  // Woke from a long sleep: the lease expired while the timer was parked.
  h.clock.now = base + 700_000;
  assert.equal(h.client.lease(), null);
  h.client.kick();
  await settle();
  assert.equal(h.sent.length, 2, 'kick renews immediately after a wake');
  assert.ok(h.client.lease());
});

test('the schedule is a long renewal while a lease is held and a short watchdog when it is not', () => {
  const nowMs = 1_760_000_000_000;
  assert.equal(presenceDelayMs({ renewing: false, attempt: 0, leaseExpiresAtMs: nowMs + 600_000, nowMs }),
    RENEW_INTERVAL_MS);
  assert.equal(presenceDelayMs({ renewing: false, attempt: 0, leaseExpiresAtMs: nowMs + 30_000, nowMs }),
    WATCHDOG_MS);
  assert.equal(presenceDelayMs({ renewing: false, attempt: 0, leaseExpiresAtMs: null, nowMs }), WATCHDOG_MS);
  assert.equal(presenceDelayMs({ renewing: true, attempt: 1, leaseExpiresAtMs: null, nowMs }), RETRY_START_MS);
  assert.equal(presenceDelayMs({ renewing: true, attempt: 99, leaseExpiresAtMs: null, nowMs }), RETRY_MAX_MS);
});
