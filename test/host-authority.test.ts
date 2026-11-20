import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthorityCache, AuthorityEpoch, AUTHORITY_TTL_MS } from '../src/host-authority';
import { signTeardownAck, teardownBytes, type TeardownAck } from '../src/host-teardown-proof';
import type { StoredHostKey } from '../src/pairing-key-store';

/**
 * The host's side of exclusive ownership.
 *
 * Two claims are tested here and they are the ones that matter: a reader cannot stay authorised after
 * this host learns of a newer epoch, and authority expires rather than being assumed.
 */

const vaultId = '8f14e45f-ceea-467a-9d0c-9a1e2f3b4c5d';
const session = 'a'.repeat(48);

function ack(overrides: Partial<TeardownAck> = {}): TeardownAck {
  return {
    v: 2, vault_id: vaultId, epoch: 3, prev_epoch: 2,
    nonce: 'Zm9vYmFyYmF6cXV1eDEyMzQ1Ng',
    host_session_id: session,
    reader_key: 'reader-key-0000000000A',
    proof: 'closed',
    observed: { channel_state: 'closed', peer_state: 'closed', ms_since_close: 7 },
    ...overrides,
  };
}

// The relay builds these bytes independently (`teardownBytes` in deploy/signal/src/server.mjs).
// Pinning the exact string is what stops the two drifting: if either side changes the layout, one of
// the two tests fails instead of every takeover failing in production with a silent bad signature.
test('teardown bytes are the relay-agreed layout', () => {
  const bytes = new TextDecoder().decode(teardownBytes(ack()));
  assert.equal(bytes, [
    'noterelay:host-teardown:v1',
    vaultId,
    '3',
    'Zm9vYmFyYmF6cXV1eDEyMzQ1Ng',
    session,
    'reader-key-0000000000A',
    '2',
    'closed',
  ].join('\n'));
});

test('teardown bytes normalise the vault id and treat a null reader as empty', () => {
  const bytes = new TextDecoder().decode(teardownBytes(ack({ vault_id: vaultId.toUpperCase(), reader_key: null })));
  assert.ok(bytes.includes(`\n${vaultId}\n`));
  assert.ok(bytes.endsWith(`${session}\n\n2\nclosed`));
});

test('a signed ack verifies with the host public key and is not transferable to another epoch', async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const publicJwk = { kty: 'EC' as const, crv: 'P-256' as const, x: jwk.x!, y: jwk.y! };
  const key: StoredHostKey = { vaultId, privateKey: pair.privateKey, publicJwk };

  const signed = await signTeardownAck(key, ack());
  assert.equal(typeof signed.signature, 'string');
  const raw = Buffer.from(signed.signature!, 'base64url');
  assert.equal(raw.length, 64);

  const verifier = await crypto.subtle.importKey('jwk',
    { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  assert.equal(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, verifier, raw,
    teardownBytes(signed)), true);
  // The same signature over a different epoch must not verify: that is the replay the relay refuses.
  assert.equal(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, verifier, raw,
    teardownBytes({ ...signed, epoch: 4 })), false);
});

test('adopting a newer epoch ends the previous reader’s authority', () => {
  const epoch = new AuthorityEpoch();
  assert.equal(epoch.allows(1), false, 'nothing is authorised before a ready names an epoch');
  epoch.adopt(1);
  assert.equal(epoch.allows(1), true);

  // The relay asks for a teardown and the host attests it; the new round is now the only one served.
  epoch.adopt(2);
  assert.equal(epoch.allows(1), false, 'the superseded reader cannot remain authorised');
  assert.equal(epoch.allows(2), true);
});

test('an older epoch can never restore authority, and a malformed one is ignored', () => {
  const epoch = new AuthorityEpoch();
  epoch.adopt(5);
  assert.equal(epoch.adopt(4), false);
  assert.equal(epoch.current(), 5);
  assert.equal(epoch.adopt(-1), false);
  assert.equal(epoch.adopt(Number.NaN), false);
  assert.equal(epoch.current(), 5);
  epoch.clear();
  assert.equal(epoch.allows(5), false, 'closing the socket authorises nothing');
});

test('authority is reused inside the window and refreshed after it', async () => {
  let clock = 1_000;
  let calls = 0;
  const cache = new AuthorityCache(async () => { calls += 1; return { epoch: calls, state: 'held', holder: 'r' }; },
    () => clock);

  assert.deepEqual(await cache.ensure(), { epoch: 1, state: 'held', holder: 'r' });
  clock += AUTHORITY_TTL_MS - 1;
  await cache.ensure();
  assert.equal(calls, 1, 'a second request inside the window must not re-verify');

  clock += 2;
  assert.deepEqual(await cache.ensure(), { epoch: 2, state: 'held', holder: 'r' });
  assert.equal(calls, 2, 'past the window the answer is re-verified');
  assert.equal(cache.stale(clock), false);
});

test('a database outage after the window fails closed instead of reusing the last answer', async () => {
  let clock = 0;
  let healthy = true;
  const cache = new AuthorityCache(async () => {
    if (!healthy) throw new Error('connect ECONNREFUSED');
    return { epoch: 7, state: 'held', holder: 'r' };
  }, () => clock);

  await cache.ensure();
  clock += AUTHORITY_TTL_MS + 1;
  healthy = false;
  await assert.rejects(() => cache.ensure(), /ECONNREFUSED/);
  assert.equal(cache.stale(clock), true, 'the host is on borrowed time and must say so');
});

test('a verified answer that is not an epoch is refused rather than trusted', async () => {
  const cache = new AuthorityCache(async () => ({ epoch: Number.NaN, state: 'held', holder: null }));
  await assert.rejects(() => cache.ensure(), /AUTHORITY_UNVERIFIABLE/);
});
