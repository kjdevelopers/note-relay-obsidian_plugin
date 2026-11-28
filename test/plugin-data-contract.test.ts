/**
 * The plugin's data store is one object, and every writer must merge it.
 *
 * This is a structural test, not a unit test, because the defect it guards against is structural: a direct
 * `saveData({…})` call silently replaces the whole store. On 2026-11-28 that is exactly how a fresh vault ended up
 * with `{hostingEnabled:false}` and no identity, which made pairing throw forever. A future writer that saves one
 * setting directly would reintroduce it, and no behavioural test would notice until someone tried a clean install.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const main = readFileSync('src/main.ts', 'utf8');

test('every plugin-data write goes through the merge helper', () => {
  // `this.saveData(` is the replacing call; the merge helper is the only place allowed to use it.
  const direct = [...main.matchAll(/this\.saveData\s*\(/g)].length;
  const inMergeHelper = /private async savePluginData[\s\S]{0,300}?this\.saveData\(\s*\{\s*\.\.\.current/.test(main);
  assert.equal(direct, 1, `main.ts calls this.saveData ${direct} times; every write must merge through savePluginData`);
  assert.ok(inMergeHelper, 'savePluginData must spread the current store — otherwise it is a rename, not a merge');
});

test('the identity decision is delegated, not re-implemented', () => {
  assert.match(main, /planVaultIdentity\s*\(/, 'loadPairingVaultId must use planVaultIdentity');
  assert.equal((main.match(/Invalid Note Relay vault identity/g) ?? []).length, 1,
    'the refusal must exist in exactly one place, reached only for a present-and-malformed identity');
});

test('hosting is off unless the store says otherwise', () => {
  // A store with no hosting flag must read as off: the default posture is the one the clean-install gate checks.
  assert.match(main, /hostingEnabled/, 'the hosting preference must be read from the store, not assumed on');
  const parsed = JSON.parse('{"vaultId":"ceb2a006-83f2-40c4-9ef8-632dcbfcd1cc"}');
  assert.equal(parsed.hostingEnabled ?? false, false, 'an absent flag means off');
});
