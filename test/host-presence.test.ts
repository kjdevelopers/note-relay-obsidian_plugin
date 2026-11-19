import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HostPresenceClient, MAX_ACCEPTED_LEASE_MS, RENEW_INTERVAL_MS, RETRY_MAX_MS,
  RETRY_START_MS, UNLINKED_AFTER_MS, WATCHDOG_MS, WATCHDOG_TICK_MS, presenceDelayMs }
  from '../src/host-presence';
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
  const failures: Array<{ reason: string; state: string }> = [];
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
    (reason, state) => { failures.push({ reason, state }); },
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
  assert.equal(h.failures[0].state, 'refused');
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
  assert.equal(h.failures[0].state, 'blocked');
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

test('a refusal that outlasts two minutes names the likely cause instead of looping', async () => {
  // A vault whose local identity no longer matches the account's row is refused forever. Retrying is
  // right; saying nothing is not — the owner needs to know to pair it again.
  const base = 1_760_000_000_000;
  const h = await harness([
    { status: 403, body: {} }, { status: 403, body: {} }, { status: 403, body: {} },
  ], base);
  h.client.start();
  await settle();
  assert.equal(h.failures.at(-1)!.state, 'refused');

  h.clock.now = base + UNLINKED_AFTER_MS + 1_000;
  h.timers.at(-1)!();
  await settle();
  assert.equal(h.failures.at(-1)!.state, 'unlinked', 'the second refusal escalates after the window');
  assert.equal(h.timers.length, 2, 'and it keeps retrying');
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

test('refresh renews even while the client believes its lease is healthy', async () => {
  // The lease can be live and still be unacceptable: the relay ties it to the account's entitlement
  // revision, which nothing local observes. A refused handshake calls refresh().
  const base = 1_760_000_000_000;
  const h = await harness([
    { status: 200, body: { expiresAtMs: base + 600_000, entitlementRevision: 1 } },
    { status: 200, body: { expiresAtMs: base + 600_000, entitlementRevision: 2 } },
  ], base);
  h.client.start();
  await settle();
  assert.ok(h.client.lease());
  assert.equal(h.client.lease()!.entitlementRevision, 1);

  await h.client.refresh();
  assert.equal(h.sent.length, 2, 'refresh does not wait for the interval');
  assert.equal(h.client.lease()!.entitlementRevision, 2);
});

test('a presence chain that stopped scheduling is restarted by the watchdog', async () => {
  // Measured on a live vault on 2026-11-19: renewals stopped, the status bar sat on "hosting on;
  // remote lease pending", and nothing resumed for eight minutes. The chain is a chain — one lost
  // link is permanent without a tick that does not depend on it.
  const base = 1_760_000_000_000;
  const h = await harness([
    { status: 200, body: { expiresAtMs: base + 60_000, entitlementRevision: 0 } },
    { status: 200, body: { expiresAtMs: base + 11 * 60_000, entitlementRevision: 0 } },
  ]);
  h.client.start();
  await settle();
  assert.equal(h.sent.length, 1, 'the first renewal went out');
  const watchdog = h.delays.indexOf(WATCHDOG_TICK_MS);
  assert.ok(watchdog >= 0, 'a watchdog tick is armed at start');

  // The renewal chain dies: no timer of its own is left, and the lease has lapsed.
  h.clock.now = base + 10 * 60_000;
  h.timers[watchdog]();
  await settle();
  assert.equal(h.sent.length, 2, 'the watchdog renews when the chain is gone');
});
