// The grant signing key the service actually signs with.
//
// Production moved from a Cloudflare Worker to the self-hosted Note Relay service on 2026-11-20, and
// that service signs grants with its own P-256 key (`nr-grant-1`), whose private half exists only in
// the deployment's secret store. The previous entry pinned a development Worker key that no longer
// signs anything: keeping it would have kept a retired signer trusted, and a strict verifier only
// accepts what it was told to accept.
export const pinnedGrantPublicJwks = {
  'nr-grant-1': {
    kty: 'EC', crv: 'P-256',
    x: 'pJBuseEXjjCniH07rx5I5ydtZiQRbZwKCYt-AId-pko',
    y: '5DyIILdnwqoHfYhGy9DMRoeJXRo-3v_9XgbGjm06AY0',
  },
} as const;

export async function importPinnedGrantKeys(): Promise<ReadonlyMap<string, CryptoKey>> {
  const keys = new Map<string, CryptoKey>();
  for (const [id, jwk] of Object.entries(pinnedGrantPublicJwks)) {
    keys.set(id, await crypto.subtle.importKey('jwk', jwk,
      { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']));
  }
  return keys;
}
