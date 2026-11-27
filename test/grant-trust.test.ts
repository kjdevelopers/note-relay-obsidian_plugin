import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { verifyPeerGrant } from '../src/peer-grant';
import {
  resolveGrantJwks, importPinnedGrantKeys, pinnedGrantPublicJwks, activeGrantPublicJwks,
} from '../src/grant-keys';

// The trust boundary this pins, and why each half matters:
//
//   - a release build must refuse a grant signed by anything other than the pinned production key, and it
//     must refuse it *because of the build*, not because no key was supplied — so the release case injects a
//     development key set and asserts it is ignored;
//   - a development build is the only place a synthetic root may be trusted, because Track 6 acceptance needs
//     a staging relay that signs with its own throwaway key;
//   - even then, only the keys that were declared are accepted: an unapproved kid is still unknown.

const now = Date.now();
const expected = {
  accountId: 'owner_1', vaultId: 'vault_1', hostKeyId: 'host_1', hostSessionId: 'session_1',
  entitlementRevision: 7,
};

async function signer(kid: string) {
  const pair = await generateKeyPair('ES256', { extractable: true });
  const jwk = await exportJWK(pair.publicKey);
  const client = await generateKeyPair('ES256', { extractable: true });
  const clientJwk = await exportJWK(client.publicKey);
  const sign = async () => new SignJWT({
    account_id: expected.accountId, vault_id: expected.vaultId, host_key_id: expected.hostKeyId,
    host_session_id: expected.hostSessionId, protocol_version: 1, nonce: 'nonce_1',
    client_key: { kty: clientJwk.kty, crv: clientJwk.crv, x: clientJwk.x, y: clientJwk.y },
    scope: 'read', entitlement_revision: expected.entitlementRevision,
  }).setProtectedHeader({ alg: 'ES256', typ: 'NR-GRANT', kid })
    .setIssuer('noterelay-worker').setAudience('noterelay-host')
    .setJti('grant_1').setIssuedAt(Math.floor(now / 1000))
    .setExpirationTime(Math.floor(now / 1000) + 120).sign(pair.privateKey);
  return { kid, jwk: { kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y! }, sign };
}

test('a release build ignores an injected development key set and refuses its grants', async () => {
  const dev = await signer('nr-grant-dev-1');
  const injected = { 'nr-grant-dev-1': dev.jwk };
  // devTrust false is what a release bundle compiles.
  const resolved = resolveGrantJwks(false, injected);
  assert.deepEqual(Object.keys(resolved), ['nr-grant-1'], 'release trust is the pinned key and nothing else');
  assert.equal(resolved['nr-grant-dev-1'], undefined, 'the injected key is not present');

  const keys = await importPinnedGrantKeys(resolved);
  await assert.rejects(verifyPeerGrant(await dev.sign(), keys, expected, now),
    /Unknown grant key/, 'a development-signed grant is refused by a release build');
});

test('the pinned production root is a usable P-256 verification key', async () => {
  const keys = await importPinnedGrantKeys(resolveGrantJwks(false, null));
  assert.deepEqual([...keys.keys()], ['nr-grant-1']);
  const key = keys.get('nr-grant-1');
  assert.equal(key?.algorithm.name, 'ECDSA');
  assert.equal((key?.algorithm as EcKeyAlgorithm).namedCurve, 'P-256');
  assert.equal(key?.usages.includes('verify'), true);
});

test('a development build trusts the declared synthetic root and accepts its grants', async () => {
  const dev = await signer('nr-grant-dev-1');
  const resolved = resolveGrantJwks(true, { 'nr-grant-dev-1': dev.jwk });
  assert.deepEqual(Object.keys(resolved), ['nr-grant-dev-1']);
  const keys = await importPinnedGrantKeys(resolved);
  const grant = await verifyPeerGrant(await dev.sign(), keys, expected, now);
  assert.equal(grant.vaultId, expected.vaultId);
});

test('a development build still refuses an unapproved signing authority', async () => {
  const dev = await signer('nr-grant-dev-1');
  const unapproved = await signer('nr-grant-evil-9');
  const keys = await importPinnedGrantKeys(resolveGrantJwks(true, { 'nr-grant-dev-1': dev.jwk }));
  await assert.rejects(verifyPeerGrant(await unapproved.sign(), keys, expected, now),
    /Unknown grant key/, 'a key that was not declared is not trusted, even in a development build');
});

test('a development build with nothing usable falls back to the pinned root', async () => {
  for (const injected of [null, {}, { 'nr-grant-bad': { kty: 'RSA' } }]) {
    assert.deepEqual(Object.keys(resolveGrantJwks(true, injected)), ['nr-grant-1'],
      'no usable injection means release trust, which is the safe direction');
  }
});

test('this build trusts exactly the pinned root, because the test build is not a development build', () => {
  assert.deepEqual(Object.keys(activeGrantPublicJwks), Object.keys(pinnedGrantPublicJwks));
});
