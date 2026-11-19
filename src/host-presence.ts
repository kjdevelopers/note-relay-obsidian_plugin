import { requestUrl } from 'obsidian';
import type { StoredHostKey } from './pairing-key-store';
import type { AuthorizationLease } from './authenticated-read-session';
import { signPresence, type PresenceProof } from './host-presence-proof';
import { WORKER_ORIGIN } from './endpoints';
import { pluginHeaders } from './client-version';
import { clearTimer, setTimer } from './timers';

// The paired key signs presence. This endpoint never receives vault content.
const ORIGIN = WORKER_ORIGIN;
type Reply = { expiresAtMs?: unknown; entitlementRevision?: unknown; stopped?: unknown };
type Send = (proof: PresenceProof) => Promise<{ status: number; body: Reply }>;
type Schedule = (handler: () => void, ms: number) => unknown;
/** Why presence is not working, in the terms the status bar shows. */
export type PresenceFailure = 'refused' | 'unlinked' | 'blocked';
type Cancel = (handle: unknown) => void;

/**
 * The longest lease this client will believe.
 *
 * The relay decides how long a presence lease lasts; this side must not re-derive that number. It did,
 * and the two drifted: when the lease went from 60 s to 600 s, every *successful* renewal failed a
 * `<= now + 65 s` check, so the host held no local lease. The signal client gates every socket on that
 * lease, so the vault quietly stopped joining the room while the site still listed it as online —
 * unreachable and "online" at the same time, with nothing in the status bar to say so. Accept anything
 * plausible instead: a lease is a fact reported by the server, not a constant to verify.
 */
export const MAX_ACCEPTED_LEASE_MS = 15 * 60_000;

/** How often a held lease is renewed. Each renewal is one billed Durable Object request. */
export const RENEW_INTERVAL_MS = 300_000;

/** Renew this long before the lease lapses, so a slow request cannot outlive it. */
export const RENEW_LEAD_MS = 60_000;

/** How soon to look again once the lease has lapsed and nothing is held. */
export const WATCHDOG_MS = 15_000;

/** How often the presence loop checks that its own chain is still alive. */
export const WATCHDOG_TICK_MS = 20_000;

/** A refused renewal backs off, but never stops: one refusal must not end hosting for the night. */
export const RETRY_START_MS = 5_000;
export const RETRY_MAX_MS = 300_000;
/** Doublings before the ceiling is reached. */
const RETRY_STEPS = 7;
/**
 * How long a vault may keep being refused before the plugin says the likely cause out loud.
 *
 * A 403 outlives a transient — a clock jump, a row read at the wrong instant — within seconds, so a
 * refusal still going two minutes later is almost always the vault's own link: its local identity is
 * no longer the one the account holds (a reinstalled plugin folder, a copied vault). Retrying is still
 * right, but the owner needs the instruction, not a spinner.
 */
export const UNLINKED_AFTER_MS = 120_000;

export async function sendPresence(proof: PresenceProof): Promise<{ status: number; body: Reply }> {
  const response = await requestUrl({
    url: `${ORIGIN}/v1/host/presence`, method: 'POST',
    contentType: 'application/json', headers: pluginHeaders(), body: JSON.stringify(proof), throw: false,
  });
  if (response.text.length > 1024) throw new Error('Presence response too large');
  let body: Reply;
  try { body = JSON.parse(response.text) as Reply; }
  catch { throw new Error('Presence unavailable'); }
  return { status: response.status, body };
}

/**
 * The wait before the next renewal attempt.
 *
 * Pure so the schedule can be asserted without waiting for it: a held lease renews on a long interval,
 * a lapsed one is retried on a short watchdog, and a refusal backs off to a ceiling instead of giving
 * up or spinning.
 */
export function presenceDelayMs(input: {
  renewing: boolean; attempt: number; leaseExpiresAtMs: number | null; nowMs: number;
}): number {
  if (!input.renewing) {
    const untilExpiry = input.leaseExpiresAtMs === null ? 0 : input.leaseExpiresAtMs - input.nowMs;
    if (input.leaseExpiresAtMs !== null && untilExpiry > RENEW_LEAD_MS) {
      return Math.max(WATCHDOG_MS, Math.min(RENEW_INTERVAL_MS, untilExpiry - RENEW_LEAD_MS));
    }
    return WATCHDOG_MS;
  }
  const step = Math.min(Math.max(input.attempt, 1), RETRY_STEPS);
  return Math.min(RETRY_MAX_MS, RETRY_START_MS * 2 ** (step - 1));
}

// A failed renewal never extends the local authorization lease. A stop waits
// for a pending renewal so that a delayed response cannot restore presence.
export class HostPresenceClient {
  private active = false;
  private timer: unknown = null;
  private current: Promise<void> = Promise.resolve();
  private lastIssuedAtMs = 0;
  private authorization: AuthorizationLease | null = null;
  private failure: ((reason: string, state: PresenceFailure) => void) | null;
  private onLease: ((lease: AuthorizationLease) => void) | null;
  private attempt = 0;
  private failing = false;
  private refusedSinceMs: number | null = null;
  private saidUnlinked = false;
  /** The relay refused this build outright; renewing into that refusal is the cost the gate exists to stop. */
  private blocked = false;
  private inFlight = false;
  private watchdog: unknown = null;

  constructor(private vaultId: string, private sessionId: string,
    private key: StoredHostKey, private send: Send = sendPresence,
    private now: () => number = Date.now,
    onFailure: ((reason: string, state: PresenceFailure) => void) | null = null,
    onLease: ((lease: AuthorizationLease) => void) | null = null,
    private schedule: Schedule = setTimer,
    private cancel: Cancel = clearTimer) {
    this.failure = onFailure; this.onLease = onLease;
  }

  lease(): AuthorizationLease | null {
    return this.active && this.authorization && this.authorization.expiresAtMs > this.now()
      ? this.authorization : null;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.blocked = false;
    this.attempt = 0;
    this.current = this.renew();
  }

  /**
   * The tick that notices a renewal nobody is coming back for.
   *
   * The renew chain is a chain: each successful renewal schedules the next one. If one link is lost —
   * a timer that fired into an in-flight request, a window that was hidden exactly then, a thrown
   * error outside the try — the vault keeps saying "hosting on; remote lease pending" forever and the
   * only remedy is turning hosting off and on. Measured on a live vault on 2026-11-19: renewals
   * stopped, the status bar stayed on that line, and nothing resumed for eight minutes. This tick
   * costs a local timer and sends nothing while a healthy lease is held.
   */
  private startWatchdog(): void {
    if (this.watchdog) this.cancel(this.watchdog);
    const handle = this.schedule(() => this.watch(), WATCHDOG_TICK_MS);
    (handle as { unref?: () => void }).unref?.();
    this.watchdog = handle;
  }

  private watch(): void {
    this.watchdog = null;
    if (!this.active) return;
    this.startWatchdog();
    if (this.blocked || this.inFlight) return;
    const lease = this.lease();
    if (lease && lease.expiresAtMs - this.now() > RENEW_LEAD_MS) return;
    this.note('watchdog: renewing');
    if (this.timer) { this.cancel(this.timer); this.timer = null; }
    this.current = this.renew();
  }

  /**
   * Renew now if the lease has lapsed.
   *
   * A sleeping laptop runs no timers, so the first renewal after a wake can be hours late with the
   * lease already gone. The vault window has no OS wake event to hook, so the wake is observed where
   * it reaches this client: a focus or visibility change. Nothing is sent while a healthy lease is
   * held, so an ordinary window switch costs nothing.
   */
  kick(): void {
    if (!this.active || this.blocked || this.inFlight) return;
    const lease = this.lease();
    if (lease && lease.expiresAtMs - this.now() > RENEW_LEAD_MS) return;
    if (this.timer) { this.cancel(this.timer); this.timer = null; }
    this.attempt = 0;
    this.current = this.renew();
  }

  /**
   * Renew now, whatever this client currently holds, and report when the attempt has been answered.
   *
   * The relay ties a presence lease to the account's entitlement revision, and a revision change makes
   * every lease written before it unacceptable to the room — while this client still believes its own
   * lease is fine, because its expiry has not run out. Nothing here can see that change coming; the
   * host discovers it when a socket handshake is refused, so that refusal has to be able to force a
   * renewal instead of waiting out the five-minute interval.
   */
  async refresh(): Promise<void> {
    if (!this.active || this.blocked) return;
    if (this.timer) { this.cancel(this.timer); this.timer = null; }
    this.attempt = 0;
    this.current = this.renew();
    await this.current.catch(() => {});
  }

  /** Why presence last did something, for the diagnostics panel. Bounded, and never a secret. */
  private readonly events: string[] = [];
  debugTail(count = 40): string[] { return this.events.slice(-count); }
  private note(event: string): void {
    this.events.push(`${new Date().toISOString().slice(11, 23)} ${event}`);
    if (this.events.length > 200) this.events.splice(0, this.events.length - 200);
  }

  private issuedAt(): number {
    this.lastIssuedAtMs = Math.max(this.now(), this.lastIssuedAtMs + 1);
    return this.lastIssuedAtMs;
  }

  /** Report once per failing streak, so a retry loop cannot fill the corner with notices. */
  private report(reason: string, state: PresenceFailure): void {
    if (this.failing) return;
    this.failing = true;
    this.failure?.(reason, state);
  }

  /** A lease the server reported, or null when the reply is not something this client can trust. */
  private acceptLease(body: Reply): AuthorizationLease | null {
    const expiresAtMs = body.expiresAtMs;
    const entitlementRevision = body.entitlementRevision;
    if (!Number.isSafeInteger(expiresAtMs) || !Number.isSafeInteger(entitlementRevision)) return null;
    if ((expiresAtMs as number) <= this.now()) return null;
    if ((expiresAtMs as number) > this.now() + MAX_ACCEPTED_LEASE_MS) return null;
    if ((entitlementRevision as number) < 0) return null;
    return { expiresAtMs: expiresAtMs as number, entitlementRevision: entitlementRevision as number };
  }

  private async renew(): Promise<void> {
    if (!this.active || this.inFlight) return;
    this.inFlight = true;
    let retrying = false;
    try {
      const proof = await signPresence('renew', this.vaultId,
        this.sessionId, this.key.privateKey, this.issuedAt());
      if (!this.active) return;
      const result = await this.send(proof);
      if (!this.active) return;
      if (result.status === 426) {
        // The relay has been told to refuse this build. Stop renewing rather than retrying into the
        // same refusal: a blocked build that keeps asking is the exact cost the gate exists to stop.
        this.authorization = null;
        this.blocked = true;
        if (this.timer) { this.cancel(this.timer); this.timer = null; }
        this.report('This Note Relay plugin version is no longer supported. Update the plugin, then turn hosting off and on.', 'blocked');
        return;
      }
      const lease = result.status === 200 ? this.acceptLease(result.body) : null;
      if (lease) {
        this.authorization = lease;
        this.attempt = 0;
        this.failing = false;
        this.refusedSinceMs = null;
        this.saidUnlinked = false;
        this.onLease?.(lease);
        // Nothing to watch until a lease exists: before that the renew chain itself is the only
        // scheduler, and a watchdog here would only duplicate its work.
        this.startWatchdog();
      } else {
        retrying = true;
        // 403 and 404 are the relay's refusals of this vault (unlinked, revoked, or a proof it did not
        // accept). They used to end presence permanently, which turned one bad renewal — a clock jump
        // after a sleep, a database read at the wrong moment — into a vault that stayed dark until the
        // owner toggled hosting. Retry, and say so once.
        const refused = result.status === 403 || result.status === 404;
        const nowMs = this.now();
        if (refused && this.refusedSinceMs === null) this.refusedSinceMs = nowMs;
        if (refused && !this.saidUnlinked && nowMs - (this.refusedSinceMs ?? nowMs) >= UNLINKED_AFTER_MS) {
          this.saidUnlinked = true;
          // The streak is long enough to name the probable cause; keep retrying so a re-pair on the
          // site is picked up without a reload.
          this.failing = false;
          this.report('This vault is no longer linked to your Note Relay account. Pair it again on noterelay.io — Note Relay keeps retrying until then.', 'unlinked');
        } else {
          this.report(refused
            ? 'Note Relay is retrying: the relay refused this vault.'
            : 'Note Relay could not renew remote presence; retrying.', 'refused');
        }
      }
    } catch {
      retrying = true;
      this.report('Note Relay could not reach the relay; retrying.', 'refused');
    } finally {
      this.inFlight = false;
    }
    if (!this.active || this.blocked) return;
    const leaseNow = this.lease();
    const delay = retrying
      ? presenceDelayMs({ renewing: true, attempt: ++this.attempt, leaseExpiresAtMs: null, nowMs: this.now() })
      : presenceDelayMs({ renewing: false, attempt: 0,
        leaseExpiresAtMs: leaseNow?.expiresAtMs ?? null, nowMs: this.now() });
    // Clear the handle as the timer fires. A fired timer left in this field is indistinguishable
    // from a pending one, and the loop then looked armed while nothing was scheduled at all.
    this.timer = this.schedule(() => {
      this.timer = null;
      this.current = this.renew();
    }, delay);
  }

  async stop(): Promise<void> {
    if (!this.active) return;
    this.active = false;
    this.authorization = null;
    this.blocked = false;
    if (this.timer) { this.cancel(this.timer); this.timer = null; }
    if (this.watchdog) { this.cancel(this.watchdog); this.watchdog = null; }
    await this.current.catch(() => {});
    try {
      const proof = await signPresence('stop', this.vaultId,
        this.sessionId, this.key.privateKey, this.issuedAt());
      await this.send(proof);
    } catch { /* The server's own lease expires without a stop arriving. */ }
  }
}
