# Onboarding gate — 0.2.36 (run 2026-11-28)

Vault: `~/Documents/NoteRelay/genuine-test-vault` (previously paired with the disposable E2E account
`0facdac0-3ec1-4e1b-b587-adc3deacb65c`; this run is the **upgrade over a paired vault**).
Artefact under test: `main.js` sha256 `fa13d7f399f6cd9626854053ab65f1381dd1ffb997e4dd183148b34a75689b4b`
(914,700 bytes), `manifest.json` `de16099e…` version 0.2.36, `styles.css` `cf3aa726…`, built with
`NR_WORKER_ORIGIN=https://api.noterelay.io` and passing `check-release-build.mjs` (6 capability checks).

| step | result | observation |
| --- | --- | --- |
| 1. clean install, default posture | **PASS** (measured 2026-11-28 on `3d9b342a…`, rc.2) | present but not enabled; after enabling, status read `Note Relay: off` and `data.json` held no `vaultId` |
| 2. settings before identity | **PASS** (measured 2026-11-28 on `3d9b342a…`) | hosting toggled on first, then `pairingVaultId()` minted and merged into `{hostingEnabled, vaultId}` |
| 3. malformed identity refused | **PASS** (measured 2026-11-28 on `3d9b342a…`) | `{"vaultId":"not-a-uuid"}` → `Invalid Note Relay vault identity`, plugin still loaded, nothing overwritten |
| 4. first pairing writes the binding | **PASS** (measured 2026-11-28 on `3d9b342a…`) | begin → review → approve **200** → confirm **true** → `accountBinding()` returned account, email, hostKeyId, `pairedAt` |
| 5. binding and identity survive a reload | **PASS** (measured 2026-11-28 on `3d9b342a…`) | after `app:reload`: still enabled and loaded, same `vaultId`, hosting off |
| 6. upgrade over a previously paired vault | **PASS** (measured this run on `fa13d7f3…`) | 0.2.36 files installed into the vault's plugin folder and the plugin reloaded: `setHosting` present, vault id on disk unchanged (`ceb2a006-83f2-40c4-9ef8-632dcbfcd1cc`), hosting default **off**, status `off` |
| 7. hosting controls and status accuracy | **PASS** (measured this run on `fa13d7f3…`) | `setHosting(false)` while already off → stays `off`, nothing starts (the settings-pane fix); `setHosting(true)` → **`remote presence active`** with relay `connected` at 3 s and 6 s; `setHosting(false)` → `off`; `setHosting(false)` again → `off` (idempotent) |

## What steps 1–5 were measured against, stated plainly

Those five steps were run earlier today against `main.js 3d9b342a…` (rc.2). Between that artifact and
`fa13d7f3…` the pairing code changed in exactly two places — the text thrown when `present()` or
`confirm()` fails — and in no place the handshake, the signatures, the endpoints or the stored shape:
`pairing-api.ts`, `device-api.ts`, `protocol.ts` and `peer-grant.ts` are unchanged since the 0.2.35 tag.
The steps are recorded as PASS on that basis, with the artifact difference named rather than hidden.

Step 4 was not re-run on `fa13d7f3…` because a fresh pairing needs a live code from a signed-in browser and
would have consumed the E2E account's pairing budget mid-release; the failure paths that did change are pinned
by eight assertions in `test/pairing-messages.test.ts`, including that the flow surfaces the status it received.

## Compatibility, measured rather than inferred

Step 7 reached **`remote presence active`** with relay `connected` against the **deployed** cloud baseline
`7c44583` — the presence lease, the signal socket and the authority handshake all succeeded with this artifact,
so plugin 0.2.36 is compatible with production as it stands today, before any cloud maintenance deploy.

Residual, stated rather than hidden: Obsidian caches the plugin manifest object until the application restarts,
so the plugin reported `0.2.36-rc.2` while running the 0.2.36 bundle (the known behaviour recorded on
2026-11-22). The signed-in viewer and owner-editing journeys are not part of this gate.
