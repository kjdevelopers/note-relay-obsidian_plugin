/**
 * What the status bar says, in one pure function.
 *
 * The status line is the only operational feedback a plugin can give without a console, and it has already been
 * wrong twice in this project's history: it said `hosting on; remote unavailable` for two days while the vault was
 * dark, and it later reported a presence lease as though a lease were a connection. Both happened because the text was
 * assembled inline from whatever fields happened to be handy. Extracting it means the rules can be asserted rather than
 * read, and the invariant that matters can be stated once:
 *
 *   **A lease is not a connection.** `remote presence active` may only appear beside a relay that is actually open.
 *
 * Nothing here reads Obsidian state: the caller passes a plain snapshot, so a test can describe any combination without
 * an application object.
 */

export type RelayState = 'connected' | 'connecting' | 'closed' | 'off';

export type StatusSnapshot = {
  hostEnabled: boolean;
  /** The host is held on its own socket while a reader waits, which is a different state from hosting idly. */
  readerWaiting: boolean;
  /** The local presence lease, when one is held and unexpired. A lease outlives its socket; see the invariant above. */
  leaseActive: boolean;
  remoteStatus: 'unpaired' | 'blocked' | 'unlinked' | 'refused' | 'unavailable' | null;
  relay: RelayState | undefined;
};

// One definition of this string, in host-waiting.ts, so the indicator and the reader-wait monitor cannot disagree.
export { READER_WAIT_STATUS } from './host-waiting';

import { READER_WAIT_STATUS } from './host-waiting';

export function describeStatus(s: StatusSnapshot): string {
  if (!s.hostEnabled) return 'off';
  if (s.readerWaiting) return READER_WAIT_STATUS;

  // The relay suffix exists so the indicator cannot claim a connection the vault does not have.
  const reached = s.relay === 'connected' || s.relay === undefined || s.relay === 'off'
    ? '' : '; relay reconnecting';

  if (s.leaseActive) return `remote presence active${reached}`;
  if (s.remoteStatus === 'unpaired') return 'hosting on; vault not paired';
  if (s.remoteStatus === 'blocked') return 'hosting on; plugin update required';
  if (s.remoteStatus === 'unlinked') return 'hosting on; vault not linked, re-pair';
  if (s.remoteStatus === 'refused') return 'hosting on; relay refused, retrying';
  if (s.remoteStatus === 'unavailable') return 'hosting on; remote unavailable';
  return 'hosting on; remote lease pending';
}

/**
 * What a request to host or not host should actually do.
 *
 * A switch that reports a boolean and then calls a blind toggle is correct only while nothing else changes hosting
 * between the render and the click — and three other things do: the status bar, the ribbon and the command palette. The
 * observed failure is a pane rendered while hosting was on, another surface turning it off, and the owner clicking the
 * switch to turn it on: the blind toggle turns it off again and the control disagrees with the product.
 *
 * Idempotence is the property, so it is stated once, here, where it can be asserted.
 */
export type HostingIntent = 'start' | 'stop' | 'noop';

export function hostingIntent(current: boolean, requested: boolean): HostingIntent {
  if (current === requested) return 'noop';
  return requested ? 'start' : 'stop';
}
