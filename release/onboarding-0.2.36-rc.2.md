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
| 6. upgrade over a previously paired vault | **PASS (measured 2026-11-28)** | rc.2 installed into `genuine-test-vault` (`{vaultId ceb2a006…, hostingEnabled:false}`, no `account`). Live read after launch: plugin `0.2.36-rc.2` enabled and loaded, `binding:null`, hosting default **off**, vaultId on disk unchanged — a valid identity reused, not re-minted. Hosting toggled on → **"Note Relay: remote presence active"** at 9 s and 18 s, then off |
| 7. application restart | **PARTIAL (measured 2026-11-28)** | Cmd-Q closed the vault windows and left the app process with **zero debug targets**; re-opening the vault restored a window where the plugin reported `0.2.36-rc.2`, enabled, loaded, `binding:null`, hosting **off**, and the same on-disk identity. A full process restart was not observed — the app process stayed alive between the two windows — so this is a window/load-path restart, not a cold start |

## BLOCKED steps and why

- **Step 7.** Not product: the app process survived the quit, so what was measured is a window re-open plus plugin load,
  not a cold start. A cold-start check needs the app fully terminated, which this surface's process-kill control refuses.

Owner decision required before a tag: either accept this window-reopen evidence as the restart proof, or run one cold
start on a machine where terminating Obsidian is permitted. Steps 1–6 are PASS.
