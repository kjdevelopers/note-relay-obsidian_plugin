# Onboarding gate — required before any tag

A plugin release that installs but cannot be paired is not a release. On 2026-11-28 that happened: every unit test
passed, `0.2.35` shipped green, and a brand-new vault could not pair at all because its store held a setting and no
identity. The defect was invisible to the suite and obvious in four minutes of a clean install. This gate exists so the
four minutes happen before the tag, every time.

Run it against a **throwaway vault**, never a customer's. Record the results in the release evidence; a release without
them is not accepted.

## 1. Clean install, default posture

```bash
V=~/…/scratch/onboarding-gate-vault
mkdir -p "$V/.obsidian/plugins/note-relay"
cp main.js manifest.json styles.css "$V/.obsidian/plugins/note-relay/"
```

Open the vault. Obsidian starts in **Restricted Mode**: turn community plugins on, then enable Note Relay.
**Expected:** the plugin is *present but not enabled* before you do this; after enabling, the status bar reads
`Note Relay: off`, `data.json` holds no `vaultId`, and nothing is listening.

## 2. Settings before identity — the 2026-11-28 regression

Toggle hosting on **before pairing** (the order a customer takes), then ask the plugin for an identity:

- **Expected:** an identity is minted and merged into the store; the store afterwards holds `hostingEnabled` **and**
  `vaultId`.
- **Must not happen:** `Invalid Note Relay vault identity` on a store that never held one.

## 3. Malformed identity is refused, not replaced

Write `{"vaultId":"not-a-uuid"}` into `data.json`, reload.
**Expected:** pairing refuses with `Invalid Note Relay vault identity`; the plugin still loads; nothing is overwritten.

## 4. First pairing writes the binding

With a real code (or the documented test identity), complete pairing.
**Expected:** approve answers `{approved:true,…}`, confirm returns true, `accountBinding()` returns account, email,
hostKeyId and pairedAt, and the store gains `account`. Status bar then reports `remote presence active` when hosting is
on.

## 5. Binding and identity survive a reload

Reload the app (`app:reload`). **Expected:** plugin still enabled and loaded, same `vaultId`, same `account`, hosting
back to off unless it was on.

## 6. Upgrade from a previously paired vault

Install the new build over an existing paired vault. **Expected:** the stored `vaultId` is unchanged (no new host row),
hosting and pairing still work, and the status bar never tells the owner to re-pair.

## What the automated gates cover, and what they cannot

`pnpm test` pins `planVaultIdentity` (reuse / mint / refuse), the merge-only data contract, the binding shape and the
release ancestry list. None of that can observe Obsidian's Restricted Mode, a real pairing round trip, or a reload.
Those are manual, and they are the steps that found every real defect in this area.

## Blocker rule

Any step that cannot be run is recorded as **BLOCKED** with the reason — never as passed. A release with a blocked
gate needs an explicit owner decision, quoted in the evidence.
