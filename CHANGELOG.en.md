# CHANGELOG

## 0.1.3 (2026-09-03)

- **Mobile adaptation (Git view)**: on narrow screens the panel auto-stacks to a single column; the history band is fixed to ~5 rows (178px); the bottom commit bar stacks instead of cramming the status card; the bottom safe area is reserved (fixes the doubled safe-area padding on both the root and the commit bar).
- **Native branch picker**: unified between desktop and mobile — tapping the branch capsule calls `showPicker()` to open a native `<select>` (an off-screen native select overlay instead of overlaid custom pills); fixes the white screen caused by `branchSelectRef` being declared in `DiffView`; long branch names render in full (no truncation).
- **Interaction & compatibility**: `patch-client.mjs` is the authoritative build artifact; file rows show a pointer cursor (not the text I-beam); dsh-pocket's copy-file buttons are hidden inside the Git view, and the dsh-pocket file guard no longer swallows Git file-row taps.
- **Release note**: `package.json` bumped to `0.1.3`; the `v0.1.3` tag was pushed and `dsh-git-graph@0.1.3` is published on npm (with provenance); **no GitHub Release was created for this tag** (only `v0.1.1` and `v0.1.2` have releases).

## 0.1.2 (2026-09-03)

- **Fix**: the dsh `0.1.2-alpha.5` conversation root renders resizable-pane width handles
  (`data-width-handle`) that showed as vertical bars over the full-screen Git view — now hidden while the
  Git view is active (`[data-conversation-scroll]:has([data-git-view]) ~ [data-width-handle]`; scoped to the
  Git tab only, chat/trajectory panes keep their handles).
- **Listing prep**: added `screenshots.json` (storefront screenshot declaration pointing at
  `docs/screenshots/git-panel.png`); added the `dsh-plugin` repo topic; `cordis.patch.yml` comments updated
  to the Git-only build.

## 0.1.1 (2026-09-03)

- **Git-only build**: removed the "Files" browse/edit tab and the `/fs` API (the bundled CodeMirror file
  editor deadlocks in a MutationObserver loop on dsh `0.1.2-alpha.5`; the host `/fs` handlers stay in the
  module for a later re-enable).
- **Compatibility**:
  - Detects the alpha.5 batched boot manifest (`window.__DSH_BOOT__.batches`) and degrades the file editor to
    the built-in fallback renderer (no MutationObserver) on that runtime; rc.2 keeps the full CodeMirror.
  - The host skips gracefully when `/git`/`/fs` are already registered by another plugin (no more layer crash).
- **npm ↔ GitHub + CI**: `package.json` gains `repository`/`homepage`/`bugs` pointing at the GitHub repo;
  `.github/workflows/ci.yml` (tests on push/PR, Node 20/22) and `release.yml` (`v*` tags auto-publish with
  `npm publish --provenance`; tag must match package.json version).
- **Docs**: READMEs (zh/en) trimmed to the Git-only build; Git panel screenshot added
  (`docs/screenshots/git-panel.png`, recovered from the desktop project's git history); publish metadata
  updated accordingly.
- **Tests**: switched to git-only assertions (`apply()` registers only `/git`; `/fs` returns `no-route`).

## 0.1.0 (2026-09-02)

- **Initial release** (unscoped `dsh-git-graph`): packaged "Git + file browsing" as an installable dsh bundle
  plugin.
  - Git: `/git` JSON API (status / branches / diff / stage / commit / push-pull / commit graph / blame …) plus
    a browser Git tab.
  - File browsing: `/fs` tree/read/write + file tree / preview / edit tab (removed in 0.1.1).
  - Hardening: size/long-line guard (`tooBig`), `/fs` escape guard (`invalid-path`), resilient host route
    registration.

---

## Notes

- Versions `0.1.0`/`0.1.1` were also published under the scoped name **`@enoughpower/dsh-git-graph`**; that
  package could not be unpublished (npm forbids it for 2FA-bypass tokens) and remains on the registry —
  **use the unscoped `dsh-git-graph`**.
- Release flow: `npm version patch && git push --tags` → GitHub Actions tests, publishes to npm (with
  provenance) and creates a matching GitHub Release.
