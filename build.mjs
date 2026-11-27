import { build } from 'esbuild';

/**
 * The Worker origin is compiled in, not read at runtime.
 *
 * `NR_WORKER_ORIGIN` overrides it; unset, the build compiles the **production** origin. That default
 * is deliberate and is the safer direction: a clean checkout, and the community directory's own build
 * verifier, must be able to run `pnpm run build` with no environment at all — and if someone does
 * forget to set a variable, an accidentally-published bundle then points at production rather than at
 * a development Worker. A development build sets the variable explicitly.
 * `scripts/check-release-build.mjs` still refuses a bundle that names a development endpoint.
 */
const PRODUCTION_ORIGIN = 'https://api.noterelay.io';
const origin = (process.env.NR_WORKER_ORIGIN ?? '').trim().replace(/\/+$/, '') || PRODUCTION_ORIGIN;
if (!/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}(?::\d{2,5})?$/i.test(origin)) {
  throw new Error(`NR_WORKER_ORIGIN must be an https origin, got: ${origin}`);
}
if (origin !== PRODUCTION_ORIGIN) {
  console.log(`Note Relay: building against ${origin} (NR_WORKER_ORIGIN override)`);
}

// Development trust is an explicit opt-in and cannot be reached by setting a key set alone. A bundle built
// with it carries a banner that `scripts/check-release-build.mjs` refuses, and its runtime gate is this
// compiled boolean, so a release build ignores an injected set even if one were present.
const devTrust = process.env.NR_DEV_TRUST === '1';
let devGrantJwks = null;
if (devTrust) {
  const raw = (process.env.NR_GRANT_PUBLIC_JWKS ?? '').trim();
  if (raw) {
    try {
      devGrantJwks = JSON.parse(raw);
    } catch {
      throw new Error('NR_GRANT_PUBLIC_JWKS is set but is not valid JSON');
    }
  }
  console.log('Note Relay: DEVELOPMENT TRUST — synthetic grant roots compiled in; this bundle must not be published');
}
if (devTrust && origin === PRODUCTION_ORIGIN) {
  throw new Error('NR_DEV_TRUST=1 with the production origin: a development build must name its own relay');
}

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'main.js',
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  // `node:os` is reached for the machine label; it is a runtime Electron/Node module, never bundled.
  external: ['obsidian', 'electron', 'node:os'],
  sourcemap: false,
  minify: false,
  logLevel: 'info',
  define: {
    __NR_WORKER_ORIGIN__: JSON.stringify(origin),
    __NR_DEV_TRUST__: JSON.stringify(devTrust),
    __NR_GRANT_PUBLIC_JWKS__: JSON.stringify(devTrust ? devGrantJwks : null),
  },
  // The literal below exists in a development bundle and nowhere else, which is what lets the release gate
  // refuse it without having to guess from behaviour.
  banner: devTrust ? { js: '/* NR-DEV-TRUST: synthetic grant roots compiled in; not for publication */' } : undefined,
});
