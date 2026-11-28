/**
 * What to tell a person whose pairing attempt failed.
 *
 * The flow used to collapse every refusal into "Pairing unavailable", which is true of all of them and useful for none:
 * a wrong code, an expired code, a used code, a rate limit and a dead relay asked the customer for the same impossible
 * action — guess what went wrong. The status was already in hand; it was being discarded at the throw.
 *
 * Each message names what happened and the one thing the person can do about it. Nothing here is a promise about the
 * service: a 5xx says the relay is unavailable, not that it will be back in a minute.
 */

export type PairingFailure = {
  /** Shown in the pairing modal. Plain prose — the modal does not render markdown. */
  message: string;
  /** Whether the same code can be tried again, or a fresh code is required. Drives the modal's button state. */
  retryable: boolean;
};

export function describePairingFailure(status: number): PairingFailure {
  if (status === 400) {
    return { retryable: true,
      message: 'That pairing code was not accepted. Enter the code exactly as the browser shows it and try again.' };
  }
  if (status === 404 || status === 410) {
    return { retryable: true,
      message: 'That pairing code is unknown or has expired. Generate a new code in the browser, then pair again.' };
  }
  if (status === 409) {
    return { retryable: true,
      message: 'That pairing code has already been used. Generate a new code in the browser.' };
  }
  if (status === 413) {
    return { retryable: true,
      message: 'The vault label was too long to send. Shorten it and try again.' };
  }
  if (status === 429) {
    return { retryable: true,
      message: 'Too many pairing attempts from this connection. Wait a minute, then try again.' };
  }
  if (status === 401 || status === 403) {
    return { retryable: false,
      message: 'This account is not allowed to pair a vault. Sign in again in the browser, or ask the account owner for access.' };
  }
  if (status >= 500) {
    return { retryable: true,
      message: 'The Note Relay service is unavailable right now. Check this machine\'s internet connection and try again.' };
  }
  return { retryable: true,
    message: `Pairing failed (HTTP ${status}). Check the code and try again; if it keeps failing, copy the diagnostic log from the status bar.` };
}

/** A pairing request that expired locally, before it was ever confirmed. */
export const PAIRING_EXPIRED = 'That pairing request expired before it was confirmed. Start pairing again to get a fresh code.';

/** Chrome still believes it is mid-flow. Says how to get out rather than only that it cannot proceed. */
export const PAIRING_BUSY = 'A pairing attempt is still running. Wait for it to finish, or cancel it, then try again.';

/**
 * The flow's own sentence when it has one.
 *
 * A thrown value is either an Error this plugin authored (see above) or a transport failure whose text is noise
 * ("fetch failed", "Load failed"). Anything unrecognisable falls back, so a modal is never blank and never shows the
 * browser's wording for a network error to someone looking for a pairing code.
 */
export function messageOfThrown(error: unknown, fallback: string): string {
  const text = error instanceof Error ? error.message.trim() : '';
  const transportNoise = /fetch failed|networkerror|load failed|failed to fetch/i.test(text);
  return text.length >= 8 && !transportNoise ? text : fallback;
}
