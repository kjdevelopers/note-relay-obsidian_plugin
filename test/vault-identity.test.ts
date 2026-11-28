/**
 * The vault-identity decision, pinned by the journey that broke it.
 *
 * A fresh install has no `vaultId`. Toggling hosting writes `hostingEnabled` first, so by the time pairing asks for an
 * identity the store is a non-empty object without one. The old rule called that corruption, so pairing threw and the
 * vault could never be paired — measured on a clean-install vault on 2026-11-28.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { planVaultIdentity } from '../src/vault-identity';

const ID = 'ceb2a006-83f2-40c4-9ef8-632dcbfcd1cc';

test('a fresh vault mints an identity', () => {
  assert.deepEqual(planVaultIdentity(null), { action: 'mint' });
  assert.deepEqual(planVaultIdentity(undefined), { action: 'mint' });
});

test('a vault with settings but no identity still mints — the clean-install defect', () => {
  // This exact shape was on disk when pairing threw "Invalid Note Relay vault identity".
  assert.deepEqual(planVaultIdentity({ hostingEnabled: false }), { action: 'mint' });
  assert.deepEqual(planVaultIdentity({ hostingEnabled: true, appearance: {} }), { action: 'mint' });
});

test('a stored identity is reused unchanged', () => {
  assert.deepEqual(planVaultIdentity({ vaultId: ID, hostingEnabled: true }), { action: 'reuse', vaultId: ID });
});

test('a malformed identity is refused rather than replaced', () => {
  for (const bad of ['', 'not-a-uuid', 'ceb2a006-83f2-40c4-9ef8', 42, {}, []]) {
    assert.deepEqual(planVaultIdentity({ vaultId: bad }), { action: 'refuse' }, `accepted ${JSON.stringify(bad)}`);
  }
});

test('a null identity is treated as absent, not as corruption', () => {
  // `vaultId: null` is what a JSON round-trip can leave behind; it names no row, so nothing is orphaned.
  assert.deepEqual(planVaultIdentity({ vaultId: null }), { action: 'mint' });
});

test('a non-object store cannot be read as an identity', () => {
  for (const odd of ['string', 7, true, []]) assert.deepEqual(planVaultIdentity(odd), { action: 'mint' });
});
