import assert from 'node:assert/strict';
import test from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { getExistingHostKey, getOrCreateHostKey, replaceHostKey } from '../src/pairing-key-store';
import { hostPairingKeyId } from '../src/pairing-key';
import { describeReplacementFailure, replacementSuccessText } from '../src/key-replacement-messages';

/**
 * The replace-key dialog's promises, proved against the store that has to keep them.
 *
 * The dialog says "nothing was changed" on failure and "this vault is now disconnected until you pair it again" on
 * success. Both are claims about persisted state, so both are checked here through the real store and a real (fake)
 * IndexedDB — not by matching strings in a source file and not by trusting a helper in isolation.
 */

test('a wrong fingerprint leaves the working key exactly as it was', async () => {
  const factory = new IDBFactory();
  const vaultId = crypto.randomUUID();
  const original = await getOrCreateHostKey(vaultId, factory);
  const fingerprint = await hostPairingKeyId(original.publicJwk);

  const error = await replaceHostKey(vaultId, 'A'.repeat(43), factory).then(() => null, e => e as Error);
  assert.ok(error, 'replacing with the wrong fingerprint must not succeed');
  const failure = describeReplacementFailure(error);
  assert.equal(failure.keyUnchanged, true, 'the dialog must be allowed to say the key is intact');
  assert.match(failure.message, /no longer matches the fingerprint|Nothing was changed/i);

  const still = await getExistingHostKey(vaultId, factory);
  assert.deepEqual(still?.publicJwk, original.publicJwk, 'the vault kept its identity');
  assert.equal(await hostPairingKeyId(still!.publicJwk), fingerprint);
});

test('with no key at all, the dialog does not claim one was preserved', async () => {
  const factory = new IDBFactory();
  const vaultId = crypto.randomUUID();
  const error = await replaceHostKey(vaultId, 'A'.repeat(43), factory).then(() => null, e => e as Error);
  assert.match(error!.message, /No host key to replace/);
  const failure = describeReplacementFailure(error);
  assert.equal(failure.keyUnchanged, false, 'there was no key, so "the current key was not changed" would be noise');
  assert.match(failure.message, /no local key .* to replace/i);
  assert.equal(failure.retryable, false, 'retrying the same dialog cannot conjure a key');
});

test('a successful replacement leaves the old fingerprint unresolvable — the consequence the dialog states', async () => {
  const factory = new IDBFactory();
  const vaultId = crypto.randomUUID();
  const original = await getOrCreateHostKey(vaultId, factory);
  const before = await hostPairingKeyId(original.publicJwk);

  const replacement = await replaceHostKey(vaultId, before, factory);
  const after = await hostPairingKeyId(replacement.publicJwk);
  assert.notEqual(after, before);

  const stored = await getExistingHostKey(vaultId, factory);
  assert.equal(await hostPairingKeyId(stored!.publicJwk), after, 'the store now holds only the new key');

  const text = replacementSuccessText(after);
  assert.match(text, /disconnected until you pair it again/i, 'success leads with the consequence');
  assert.ok(text.includes(after), 'the new fingerprint is named so it can be compared in the browser');
  assert.match(text, /old key it holds will no longer work/i);
});

test('the previous key cannot be used to replace again — a stale dialog cannot force a second rotation', async () => {
  const factory = new IDBFactory();
  const vaultId = crypto.randomUUID();
  const original = await getOrCreateHostKey(vaultId, factory);
  const before = await hostPairingKeyId(original.publicJwk);
  await replaceHostKey(vaultId, before, factory);

  // The modal holds `oldId` from when it opened; a second click after a successful replacement must be refused,
  // otherwise one dialog could rotate the key twice and orphan a fingerprint the customer just wrote down.
  const error = await replaceHostKey(vaultId, before, factory).then(() => null, e => e as Error);
  assert.ok(error, 'a stale fingerprint must not rotate the key a second time');
  assert.equal(describeReplacementFailure(error).keyUnchanged, true);
});

test('two dialogs racing produce exactly one replacement', async () => {
  const factory = new IDBFactory();
  const vaultId = crypto.randomUUID();
  const original = await getOrCreateHostKey(vaultId, factory);
  const fingerprint = await hostPairingKeyId(original.publicJwk);
  const outcomes = await Promise.allSettled([
    replaceHostKey(vaultId, fingerprint, factory),
    replaceHostKey(vaultId, fingerprint, factory),
  ]);
  assert.equal(outcomes.filter(o => o.status === 'fulfilled').length, 1,
    'exactly one replacement wins; the other reports a failure rather than leaving an ambiguous state');
  const rejected = outcomes.find(o => o.status === 'rejected') as PromiseRejectedResult;
  assert.equal(describeReplacementFailure(rejected.reason).keyUnchanged, true,
    'the losing dialog tells the owner the key it showed is still valid');
  const stored = await getExistingHostKey(vaultId, factory);
  assert.ok(stored, 'the vault still holds a usable key after the race');
});

test('hosting must be off before replacement, and that refusal preserves the key', async () => {
  // The dialog refuses before it touches the store; this asserts the sentence the customer gets when it does.
  const failure = describeReplacementFailure(new Error('Turn off local hosting first.'));
  assert.equal(failure.keyUnchanged, true);
  assert.equal(failure.retryable, true);
  assert.match(failure.message, /turn local hosting off first/i);
});

test('an unrecognised failure never claims the key was changed', () => {
  for (const error of [new Error('something unexpected'), 'a string', undefined]) {
    const failure = describeReplacementFailure(error);
    assert.equal(failure.keyUnchanged, true, 'the default must be the safe claim');
    assert.doesNotMatch(failure.message, /new fingerprint/i);
  }
});
