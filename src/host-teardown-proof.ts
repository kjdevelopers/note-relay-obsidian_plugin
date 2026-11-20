import type { StoredHostKey } from './pairing-key-store';

/**
 * The host's answer to a teardown request: a signed statement about its own peer.
 *
 * The bytes are the contract, and they are duplicated in exactly one other place — `teardownBytes` in
 * `deploy/signal/src/server.mjs`. Both sides are pinned by the same test vector in
 * `test/host-authority.test.ts`, so a change on one side cannot silently stop the other from
 * verifying: the test fails instead of the takeover.
 *
 * Field order matters and is not alphabetical on purpose: it follows the lifecycle of the statement
 * (what, which round, which request, which session, which reader, which previous round, verdict).
 */
export type TeardownProof = 'closed' | 'absent' | 'timeout';

export type TeardownAck = {
  v: 2;
  vault_id: string;
  epoch: number;
  prev_epoch: number;
  nonce: string;
  host_session_id: string;
  reader_key: string | null;
  proof: TeardownProof;
  observed: { channel_state: string; peer_state: string; ms_since_close: number | null };
  signature?: string;
};

function encode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function teardownBytes(ack: TeardownAck): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode([
    'noterelay:host-teardown:v1',
    String(ack.vault_id).toLowerCase(),
    String(ack.epoch),
    String(ack.nonce),
    String(ack.host_session_id),
    String(ack.reader_key ?? ''),
    String(ack.prev_epoch ?? ''),
    String(ack.proof),
  ].join('\n'));
}

export async function signTeardownAck(key: StoredHostKey, ack: TeardownAck): Promise<TeardownAck> {
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' },
    key.privateKey, teardownBytes(ack));
  return { ...ack, signature: encode(new Uint8Array(signature)) };
}
