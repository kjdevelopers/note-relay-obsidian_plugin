/**
 * Authority, as the host sees it: one epoch that permits requests, and a cache that expires.
 *
 * Two rules, and both exist because of a specific failure:
 *
 * 1. **A newer epoch ends the old reader's authority immediately.** The host is the last line of
 *    defence: even if the signaling service were rewritten to admit two readers, the host serves one
 *    epoch, and the moment it learns a newer one exists every frame from the older reader is refused.
 * 2. **Authority is verified, then trusted for at most 60 seconds.** Re-checking on every note read
 *    would be a database round trip per keystroke on a machine that already holds the vault; trusting
 *    it indefinitely would make a revocation advisory. Sixty seconds is the documented bound, and when
 *    the check cannot be made the answer is *no*, not "probably fine".
 */

export const AUTHORITY_TTL_MS = 60_000;

export type AuthorityState = { epoch: number; state: string; holder: string | null };

export class AuthorityEpoch {
  private epoch: number | null = null;

  /** Adopt an epoch. A newer epoch always wins; an older one never restores authority. */
  adopt(epoch: number): boolean {
    if (!Number.isSafeInteger(epoch) || epoch < 0) return false;
    if (this.epoch !== null && epoch < this.epoch) return false;
    this.epoch = epoch;
    return true;
  }

  /** A frame is allowed only if it carries the epoch this host is serving. */
  allows(epoch: unknown): boolean {
    return this.epoch !== null && Number(epoch) === this.epoch;
  }

  current(): number | null { return this.epoch; }

  /** The session is over: nothing is authorised until a `ready` names a new epoch. */
  clear(): void { this.epoch = null; }
}

export class AuthorityCache {
  private verifiedAt = 0;
  private state: AuthorityState | null = null;

  constructor(
    private readonly verify: () => Promise<AuthorityState>,
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = AUTHORITY_TTL_MS,
  ) {}

  /** The last answer, whether or not it is still inside the window. Diagnostics only. */
  last(): AuthorityState | null { return this.state; }

  invalidate(): void { this.verifiedAt = 0; }

  /**
   * Returns the current authority, refreshing if the window has elapsed.
   *
   * Throws when the authority cannot be verified — the caller must refuse the request. A cache that
   * fell back to its last answer on error would make a database outage an indefinite authorisation.
   */
  async ensure(now = this.now()): Promise<AuthorityState> {
    if (this.state && now - this.verifiedAt < this.ttlMs) return this.state;
    const state = await this.verify();
    if (!state || !Number.isSafeInteger(state.epoch)) throw new Error('AUTHORITY_UNVERIFIABLE');
    this.state = state;
    this.verifiedAt = now;
    return state;
  }

  /** True once the window has elapsed — the host is serving on borrowed time. */
  stale(now = this.now()): boolean {
    return !this.state || now - this.verifiedAt >= this.ttlMs;
  }
}
