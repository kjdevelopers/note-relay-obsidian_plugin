# Note Relay plugin — disposable acceptance candidate

**This is not a release and must not be published to the community directory or installed in a vault whose
notes matter.** It is the status-menu build, packaged so one person can install it into a disposable vault
and confirm the menu behaves.

| | |
| --- | --- |
| source | `kjdevelopers/note-relay-obsidian_plugin`, branch `feat/status-menu-diagnostics` |
| commit (code) | `6ad1004` |
| commit (docs) | `b86ad91` |
| base | tag `0.2.35` |
| bundle | `main.js`, 912,534 bytes, sha256 `d1ec40b97274da39d2bc508344f53fe7a51c05a2abd45716282f1ea79f27dd99` |
| manifest | `manifest.json`, sha256 `f48dfc010f22a98c70e6c0187b1aeb7195ac3d2d1e69ad5a5d418f2ab97b767b` (version `0.2.35`) |
| styles | `styles.css`, sha256 `cf3aa7268e2114c3c3c5ad20358c90783b981c351eddb72273d5ee2d0ac87dd7` (unchanged) |
| build gates | `tsc --noEmit` clean · 263 tests pass · `pnpm lint` 0 errors / 5 known warnings · `check-release-build.mjs` OK |

The manifest version stays `0.2.35` on purpose: bumping it would imply a release, and Obsidian refuses a
manifest that disagrees with the folder's loaded build only on reload. Obsidian caches the manifest object,
so the status bar may still say `0.2.35` — that is the cached version, not an old bundle.

## Install into a disposable vault

1. Close nothing; Obsidian can stay open.
2. Find the vault's plugin folder: `<vault>/.obsidian/plugins/note-relay/`.
   It must contain a `data.json` already — that is the vault's own pairing identity. **Do not delete it**;
   deleting it makes the vault a stranger that must be re-paired.
3. Back up the three files you are about to replace:
   `cp main.js manifest.json styles.css ~/note-relay-plugin-backup-$(date +%Y%m%d)/`
4. Copy this folder's `main.js`, `manifest.json` and `styles.css` over the existing ones.
5. Reload the plugin: Command palette → **Reload app without saving** (a plugin reload also works, but the
   manifest version is only re-read on an app reload).
6. Confirm hosting is still on if it was on: a reload always turns the opt-in host off.

## What to check (human acceptance)

1. Click the **Note Relay** indicator in the status bar → a menu opens with, in order: a heading line
   ("Note Relay: hosting on · …"), **Start hosting**, **Stop hosting**, **Restart hosting**, **Copy
   diagnostic log**, **Open Note Relay settings**.
2. While hosting, Start is greyed out and Stop/Restart are available; the restart row reads
   "Restart hosting — readers connected now will be disconnected".
3. Press **Stop hosting** → the status line says hosting stopped and Stop/Restart become unavailable.
4. Press **Start hosting** → it returns to hosting, and exactly one presence/relay exists (the status line
   settles on "presence active" or on a relay refusal, never both).
5. Press **Restart hosting** → the line briefly says it is changing, then returns to hosting; a browser
   reader open at the time is disconnected and reconnects on its own.
6. **Copy diagnostic log** while hosting is stopped → a notice says the log was copied and the clipboard
   holds "Note Relay diagnostics …". Repeat after a failed connect, if one occurs.
7. **Open Note Relay settings** → the existing Note Relay settings pane opens (no second pane).
8. The diagnostic's `obsidian` line now reads `api <version>` when the app does not expose its own version,
   instead of `unknown`.

## Restoration (exact)

```
D=<vault>/.obsidian/plugins/note-relay
cp ~/note-relay-plugin-backup-<date>/main.js      "$D/main.js"
cp ~/note-relay-plugin-backup-<date>/manifest.json "$D/manifest.json"
cp ~/note-relay-plugin-backup-<date>/styles.css    "$D/styles.css"
```
Then Command palette → **Reload app without saving**, and turn hosting back on.

To remove the candidate entirely without touching the pairing identity: delete `main.js`,
`manifest.json`, `styles.css` and keep `data.json`, or disable the plugin in Settings → Community plugins.

## Known limits of this candidate

- The status menu is a native Obsidian `Menu`; nothing in this repository can photograph it, which is why
  this file exists.
- Nothing else in the plugin changed: protocol 3, pairing, presence, relay and grants are untouched, and
  the suite that covers them passes unchanged.
