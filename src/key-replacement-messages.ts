/**
 * What the replace-key dialog says, and what it must never imply.
 *
 * Replacing the host key is the one plugin operation that leaves a vault *worse* if it half-succeeds, so three properties
 * matter more than the wording:
 *
 *   1. a failure never claims the key changed — the store swaps atomically, and the message must match that;
 *   2. a failure names which failure it was, because "replacement failed" for five different causes sends the customer to
 *      support with nothing to say;
 *   3. **success is not the end of the job.** A new key invalidates every grant the old one signed: the vault is
 *      disconnected until it is paired again, and a dialog that says "new fingerprint, pair again" in a reassuring tone
 *      leaves the owner with a browser that will not connect and no idea why.
 */

export type ReplacementFailure = {
  /** Shown in the dialog. Plain prose — the modal does not render markdown. */
  message: string;
  /** False when retrying the same action cannot help without changing something else first. */
  retryable: boolean;
  /** True only when the store guarantees the previous key is still in place. */
  keyUnchanged: boolean;
};

export function describeReplacementFailure(error: unknown): ReplacementFailure {
  const text = error instanceof Error ? error.message : '';

  if (/turn off local hosting/i.test(text)) {
    return { retryable: true, keyUnchanged: true,
      message: 'Turn local hosting off first. The current key is unchanged, and hosting must be stopped before a key can be replaced.' };
  }
  if (/no host key to replace/i.test(text)) {
    return { retryable: false, keyUnchanged: false,
      message: 'There is no local key on this machine to replace. Close this dialog and pair the vault instead.' };
  }
  if (/host key changed during replacement/i.test(text)) {
    return { retryable: true, keyUnchanged: true,
      message: 'Another Note Relay window or this vault\'s own data changed the key while it was being replaced. '
        + 'Nothing was changed. Reopen this dialog, check the fingerprint, and try again.' };
  }
  if (/host key changed/i.test(text)) {
    return { retryable: true, keyUnchanged: true,
      message: 'The stored key no longer matches the fingerprint this dialog showed. Nothing was changed. '
        + 'Reopen the dialog so you are confirming the key that is actually in use.' };
  }
  if (/invalid key replacement|invalid stored host key/i.test(text)) {
    return { retryable: false, keyUnchanged: false,
      message: 'This vault\'s stored key is not in a shape Note Relay can replace. Do not delete anything: copy diagnostics '
        + 'from Settings and send them to support.' };
  }
  return { retryable: true, keyUnchanged: true,
    message: 'Key replacement did not complete, and the previous key is still in place. Try again; if it keeps failing, '
      + 'copy diagnostics from Settings.' };
}

/** Shown on success. Leads with the consequence, not the fingerprint. */
export function replacementSuccessText(fingerprint: string): string {
  return `Key replaced — this vault is now disconnected until you pair it again. `
    + `Pair with a new code from the browser and approve the new fingerprint ${fingerprint} there. `
    + `If the browser still lists this vault, disconnect it there first: the old key it holds will no longer work.`;
}
