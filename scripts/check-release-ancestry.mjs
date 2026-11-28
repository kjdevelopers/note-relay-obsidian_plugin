#!/usr/bin/env node
// Release ancestry gate.
//
// A fix that is not on the line customers install is not a fix. That happened here: the account-binding correction
// lived on a 0.2.4-era branch, sixteen releases behind `main`, while every release from 0.2.20 to 0.2.35 shipped
// without it. Nothing in the release procedure asked the question, so nothing answered it.
//
// The check is behavioural rather than by commit id, on purpose. Porting a fix across sixteen releases creates a new
// SHA, so `git merge-base --is-ancestor <fix> HEAD` fails on a correct port and can pass on a stale branch that merely
// shares history. What must survive is the behaviour, and a file plus a pattern is the cheapest honest proof of it.
//
//   node scripts/check-release-ancestry.mjs            # verify the working tree
//   node scripts/check-release-ancestry.mjs --at <ref> # verify a ref (what a tag would ship)
//
// Exit codes: 0 all required fixes present · 1 one or more missing · 2 the manifest itself is unusable.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = join(ROOT, 'release', 'required-fixes.json');

function readAt(ref, path) {
  if (!ref) {
    try { return readFileSync(join(ROOT, path), 'utf8'); } catch { return null; }
  }
  try {
    return execFileSync('git', ['show', `${ref}:${path}`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return null; }
}

function main() {
  const atIndex = process.argv.indexOf('--at');
  const ref = atIndex > -1 ? process.argv[atIndex + 1] : null;

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  } catch (error) {
    console.error(`release-ancestry: cannot read release/required-fixes.json — ${error.message}`);
    process.exit(2);
  }
  const required = Array.isArray(manifest.required) ? manifest.required : [];
  if (required.length === 0) {
    // An empty manifest would make every release pass, which is the failure mode this gate exists to prevent.
    console.error('release-ancestry: the manifest lists no required fixes; refusing to certify a release against nothing');
    process.exit(2);
  }

  const missing = [];
  for (const entry of required) {
    const content = readAt(ref, entry.file);
    if (content === null) { missing.push(`${entry.id}: ${entry.file} is absent`); continue; }
    if (!content.includes(entry.pattern)) {
      missing.push(`${entry.id}: ${entry.file} no longer contains "${entry.pattern}"`);
    }
  }

  if (missing.length > 0) {
    console.error(`release-ancestry: ${missing.length} required fix(es) are not in ${ref ?? 'the working tree'}:`);
    for (const line of missing) console.error(`  - ${line}`);
    for (const entry of required) {
      const hit = missing.some(m => m.startsWith(`${entry.id}:`));
      if (hit) console.error(`    why it matters: ${entry.why}`);
    }
    process.exit(1);
  }

  console.log(`release-ancestry OK — ${required.length} required fixes present in ${ref ?? 'the working tree'}`);
}

main();
