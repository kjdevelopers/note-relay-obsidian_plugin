#!/usr/bin/env node
// Refuses a bundle that must not be published — wrong endpoint, missing capability, or a development
// marker. The plugin's origin and its protocol capabilities are compiled in, so a release build cannot
// be repaired afterwards by configuration: the only defence is to read the artifact before it ships.
//
// Run this on the *packaged* `main.js` (what the release workflow uploads), not on the source tree.
// A capability that exists in `src/` and not in the bundle is exactly the failure this exists for —
// release 0.2.26 shipped without protocol-2 signalling while the source tree looked fine.
//
// usage: node scripts/check-release-build.mjs [--allow-development] [bundle-path]
//
//   --allow-development  report the findings but exit 0 (a local http build during development)
//   bundle-path          check a fixture instead of ../main.js
//
// Exit code 0 = publishable, 1 = refuse.

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const allowDevelopment = args.includes('--allow-development');
const bundlePath = args.find(arg => !arg.startsWith('--'));
const bundle = readFileSync(bundlePath ?? new URL('../main.js', import.meta.url), 'utf8');

/** Hosts that appear as documentation links in bundled libraries, not as application endpoints. */
const DOCUMENTATION_HOSTS = new Set([
  'www.w3.org', 'en.wikibooks.org', 'github.com', 'mathiasbynens.be', 'tex.stackexchange.com',
  'developer.mozilla.org', 'katex.org', 'temml.org',
]);

/** The public site, which is fixed in `src/endpoints.ts` and expected next to the Worker origin. */
const SITE_HOST = 'noterelay.io';

/**
 * What a publishable artifact must contain, and why each one is checked here rather than trusted
 * from the source tree.
 *
 * `required` entries are capabilities the *service* refuses without. They are literal strings the
 * bundle carries, so the check reads the same bytes Obsidian will download.
 */
const REQUIRED = [
  { id: 'teardown capability', needle: 'teardown-ack-v1',
    why: 'the relay refuses a host that cannot attest a teardown (protocol 2)' },
  { id: 'teardown ack frame', needle: 'teardown-ack',
    why: 'the host answers a teardown request on the signalling socket' },
  { id: 'authority endpoint', needle: '/v1/authority',
    why: 'the host re-checks exclusive ownership at the request boundary' },
  { id: 'production grant key', needle: 'nr-grant-1',
    why: 'grants signed by the self-hosted service verify only against this key id' },
  { id: 'production grant key material', needle: 'pJBuseEXjjCniH07rx5I5ydtZiQRbZwKCYt-AId-pko',
    why: 'the pinned key id is useless without its coordinate; a stale key fails every grant' },
  { id: 'protocol 2 auth frame', pattern: /protocol:\s*2/,
    why: 'the room decides on `protocol`, and a host that omits it is refused' },
];

/** Strings a publishable bundle must never carry. Each names the build mode it belongs to. */
const FORBIDDEN = [
  { id: 'insecure build marker', needle: 'insecure-dev', why: 'a development build is identifiable and must never ship' },
  { id: 'development build header', needle: 'x-nr-build', why: 'only a development build sends this header' },
];

const hosts = new Set();
for (const match of bundle.matchAll(/\b(?:https?|wss?):\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) {
  const host = match[1].toLowerCase();
  if (!DOCUMENTATION_HOSTS.has(host)) hosts.add(host);
}

// A release bundle legitimately names two hosts: the Worker it talks to and the public site its update
// check reads. Counting both as application origins made a correct production build fail, which is how
// this check first blocked a release. The site is fixed in source, so subtracting it is safe; anything
// else still has to be the single Worker origin.
hosts.delete(SITE_HOST);

const isDevelopment = host => /^localhost$|^127\.0\.0\.1$|^\[::1\]$|(?:^|\.)test$|-dev\.|^dev\./i.test(host);

const problems = [];
if (hosts.size === 0) {
  problems.push('no Worker origin found in the bundle — the build did not define one');
} else if (hosts.size > 1) {
  problems.push(`expected one Worker origin, found ${hosts.size}: ${[...hosts].sort().join(', ')}`);
}

for (const host of hosts) {
  if (isDevelopment(host)) problems.push(`origin ${host} is a development endpoint`);
}

// Private-network http origins do not match the TLD-shaped host pattern above, which is deliberate:
// they are matched separately so the message can say what they are.
for (const match of bundle.matchAll(/https?:\/\/(127\.0\.0\.1|localhost|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2[0-9]|3[01])\.\d+\.\d+|[a-z0-9-]+\.local)(?::\d+)?/gi)) {
  problems.push(`private-network endpoint ${match[0]} in the bundle`);
}

for (const check of REQUIRED) {
  const found = check.needle !== undefined ? bundle.includes(check.needle) : check.pattern.test(bundle);
  if (!found) problems.push(`missing ${check.id} — ${check.why}`);
}

for (const check of FORBIDDEN) {
  if (bundle.includes(check.needle)) problems.push(`carries ${check.id} — ${check.why}`);
}

if (problems.length === 0) {
  console.log(`release build OK — origin ${[...hosts][0]}, ` +
    `${REQUIRED.length} capability checks, no development markers`);
  process.exit(0);
}

for (const problem of problems) console.error(`  ✗ ${problem}`);
if (allowDevelopment) {
  console.log('development build (--allow-development): the above are expected');
  process.exit(0);
}
console.error('This bundle must not be published. Rebuild with NR_WORKER_ORIGIN set to the release origin.');
process.exit(1);
