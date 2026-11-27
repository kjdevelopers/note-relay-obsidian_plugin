// Which grant-signing keys this build trusts.
//
// A release build trusts exactly the keys written here, and there is no path by which anything else becomes
// trusted: the injected set below is compiled in only when the build itself is marked as development, and the
// gate is the build's own flag rather than the presence of a value. "The variable was set" is not a trust
// decision — a bundle that somehow carried an injected set but was built as a release ignores it.
//
// Why development trust exists at all: Track 6 acceptance needs a relay that signs with its own throwaway key,
// because a staging environment must never hold the production signing key and must never be able to mint a
// grant the published plugin would accept. A synthetic root lets a real Obsidian vault and a real browser meet
// at a staging relay without either of them trusting it in production.
//
// The separation is enforced twice, deliberately:
//   - at runtime, by the compiled `__NR_DEV_TRUST__` flag: a release bundle compiles `false` and the injected
//     set is never consulted, whatever it contains;
//   - at build time, by a banner that `scripts/check-release-build.mjs` refuses, so a development bundle cannot
//     be published as a release even by accident.
declare const __NR_DEV_TRUST__: boolean | undefined;
declare const __NR_GRANT_PUBLIC_JWKS__: Record<string, GrantJwk> | null | undefined;

export type GrantJwk = { kty: string; crv: string; x: string; y: string };

/** The production signer. One key, one kid, and a release build accepts nothing else. */
export const pinnedGrantPublicJwks = {
  'nr-grant-1': {
    kty: 'EC', crv: 'P-256',
    x: 'pJBuseEXjjCniH07rx5I5ydtZiQRbZwKCYt-AId-pko',
    y: '5DyIILdnwqoHfYhGy9DMRoeJXRo-3v_9XgbGjm06AY0',
  },
} as const satisfies Record<string, GrantJwk>;

const COORDINATE = /^[A-Za-z0-9_-]{43}$/;

function validJwk(value: unknown): value is GrantJwk {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const key = value as Record<string, unknown>;
  return key.kty === 'EC' && key.crv === 'P-256' &&
    typeof key.x === 'string' && COORDINATE.test(key.x) &&
    typeof key.y === 'string' && COORDINATE.test(key.y);
}

/**
 * The trust set for one build. Pure, so a test can hand it the two inputs a build produces and assert what a
 * release build would do — including that it refuses a development key even when one is present.
 */
export function resolveGrantJwks(devTrust: unknown, injected: unknown): Record<string, GrantJwk> {
  if (devTrust !== true) return { ...pinnedGrantPublicJwks };
  if (!injected || typeof injected !== 'object' || Array.isArray(injected)) return { ...pinnedGrantPublicJwks };
  const entries = Object.entries(injected as Record<string, unknown>)
    .filter(([kid, jwk]) => /^[A-Za-z0-9._-]{1,64}$/.test(kid) && validJwk(jwk));
  // A development build with nothing usable injected is still a development build; it simply trusts only the
  // pinned key, which is the safe direction.
  return entries.length ? Object.fromEntries(entries) as Record<string, GrantJwk> : { ...pinnedGrantPublicJwks };
}

// Absent defines (a test run outside the bundler, or a build that forgets them) resolve to release trust,
// because the failure that matters is trusting something extra, not refusing something expected.
const buildDevTrust = typeof __NR_DEV_TRUST__ === 'boolean' ? __NR_DEV_TRUST__ : false;
const buildInjected = typeof __NR_GRANT_PUBLIC_JWKS__ === 'object' ? __NR_GRANT_PUBLIC_JWKS__ : null;

/** The set this build actually trusts: the pinned key unless the build is a development build. */
export const activeGrantPublicJwks: Record<string, GrantJwk> = resolveGrantJwks(buildDevTrust, buildInjected);

export async function importPinnedGrantKeys(
  jwks: Record<string, GrantJwk> = activeGrantPublicJwks,
): Promise<ReadonlyMap<string, CryptoKey>> {
  const keys = new Map<string, CryptoKey>();
  for (const [id, jwk] of Object.entries(jwks)) {
    keys.set(id, await crypto.subtle.importKey('jwk', jwk,
      { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']));
  }
  return keys;
}
