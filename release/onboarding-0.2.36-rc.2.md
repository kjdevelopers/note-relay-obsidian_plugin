# Onboarding gate — 0.2.36-rc.2 (run 2026-11-28)

Vault: `~/.local/share/note-relay/test-vaults/clean-install-2026-11-28` (throwaway, created for this run).
Identity: disposable E2E account `0facdac0-3ec1-4e1b-b587-adc3deacb65c`. Artefact: `main.js` `3d9b342a…`.

| step | result | observation |
| --- | --- | --- |
| 1. clean install, default posture | **PASS** | present but not enabled; Restricted Mode had to be lifted (`app.plugins.setEnable(true)`); after `enablePluginAndSave('note-relay')` the status bar read `Note Relay: off` and `data.json` held no `vaultId` |
| 2. settings before identity | **PASS** | hosting toggled on first, then `pairingVaultId()` **minted** and merged: store became `{hostingEnabled, vaultId}`. This is the defect fixed in 5b1c576 — before it, this step threw |
| 3. malformed identity refused | **PASS** | `{"vaultId":"not-a-uuid"}` → `Invalid Note Relay vault identity`, plugin still loaded, nothing overwritten |
| 4. first pairing writes the binding | **PASS** | begin → review (`hostKeyId mqXFIuv…`) → approve **200 `{approved:true,takeover:false}`** → confirm **true** → `accountBinding()` returned account, email, hostKeyId, `pairedAt 2026-11-28T01:07:38.134Z` |
| 5. binding and identity survive a reload | **PASS** | `app:reload` → still enabled and loaded, same `vaultId 56c4ee4f…`, same `account`, hosting off |
| 6. upgrade over a previously paired vault | **PARTIAL** | rc.2 installed into `genuine-test-vault`, whose store is `{vaultId ceb2a006…, hostingEnabled:false}` with no `account` — a valid identity that is reused, not re-minted. The live post-upgrade read is **BLOCKED**, see below |
| 7. application restart | **BLOCKED** | Cmd-Q was delivered as a real key event and the debug surface closed (observed), but the relaunched app does not re-expose the debug port while this machine's display is asleep, so post-restart state could not be read. Reload (step 5) exercises the same load path |

## BLOCKED steps and why

- **Step 6 live read.** After the restart attempt the app has no debug port, so the upgraded vault's runtime state
  cannot be read. The store on disk is intact and shows the identity preserved; the code path (`planVaultIdentity` →
  `reuse` for a valid uuid) is what step 2 and its tests pin. Re-run step 6 with a working display before tagging.
- **Step 7.** Environment, not product: the display is asleep and Obsidian does not open the debugging port in that
  state. `app:reload` covers the persistence claim; a true restart remains unverified.

Owner decision required before a tag: either re-run steps 6 and 7 on an awake machine, or accept the reload as the
persistence proof and record that decision here.
