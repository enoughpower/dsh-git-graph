# CHANGELOG

## 0.1.8 (2026-10-14)

- **New: discover and switch nested git repositories.** The Git panel scans child/grandchild directories
  of the session's working directory (depth defaults to 2, clamped to 1-4), lists the repositories it
  finds in a new top-bar "repository" dropdown, groups linked worktrees, filters submodule ghost entries,
  and caps the scan (<=50 repos, <=5000 directory entries, <=10s). When the session root is not a
  repository the first child repository is entered automatically. Options are labelled name-first with
  location disambiguation and mark detached HEADs and prunable worktrees, plus a truncation notice. Adds
  the host `listRepos` op.
- Unified top-bar pill structure: the repository and branch capsules share one style, and the repository
  icon is now inline SVG (no longer depending on a primitives icon export, so a dsh rename cannot crash
  the view). Fixed native `<select>` popup readability under the transparent overlay (white-on-white
  options, blank optgroup labels).
- Tests: fixed the 8.3 short-name case skip logic on macOS (`/var` -> `/private/var` is a symlink, not a
  short name); it now skips unless the path contains a `~<digit>` segment. 80 pass / 0 fail / 1 skip
  locally.

## 0.1.7 (2026-09-22)

- **The commit graph no longer shows stash nodes.** `graphLog` runs `git log --all`, and a stash also
  lives under `refs/` (`refs/stash`), so the stash commit and its index commit appeared as orphan nodes
  beside the branches. `--exclude=refs/stash` is now placed before `--all`, leaving only commits reachable
  from branches, remote-tracking branches and tags.
- Added an integration test that builds a throwaway repository with a stash and asserts `graphLog` keeps the
  branch commit while omitting the stash commit.
- Note: this is a host-half change, so it takes effect after restarting `dsh web` (or installing 0.1.7); a
  page refresh alone does not reload host plugins.

## 0.1.6 (2026-09-22)

- **Fix: the Git tab crashed entirely on dsh 0.1.7-alpha.1 (the real reason it "could not read the
  directory").** That release renamed the branch icon export from `IconBranchOutline16` to
  `IconBranchOutlineRegular` / `IconBranchOutlineMedium`. The plugin rendered the removed
  `primitives.IconBranchOutline16`, so React received an undefined element type and threw #130,
  replacing the whole `conversation.view` with the error boundary (a blank panel). The bundle now resolves
  whichever export exists at runtime (`IconBranchOutline16 → Regular → Medium → empty component`) and
  renders on both old and new dsh.
- Added regression test `test/primitives-compat.test.js`: it asserts icon resolution against the
  0.1.6 / 0.1.7 / no-such-export primitives shapes and scans the built bundle so a removed primitive is
  never used directly as a JSX type.
- Note: the 0.1.5 session-`cwd` fix (`props.sessionId`) is still valid; the crash masked it.

## 0.1.5 (2026-09-18)

- **Fix: the Git panel could not read the current directory on dsh 0.1.6-alpha.2.** That release removed
  the `current` field from the sessions list store (`useSessions` / `SessionListState`), while the plugin
  resolved the active session's `cwd` from `s.current`; the value was always empty, so the panel never
  found the repository. It now prefers the `sessionId` the `conversation.view` slot passes
  (`s.byId[sessionId]?.cwd`) and keeps `s.current` only as a fallback for older runtimes; the shared
  selector in both the Git and Files views was corrected.
- Added regression test `test/client-cwd.test.js`, which extracts the selector from the built bundle and
  asserts cwd resolution against both the 0.1.6-alpha.2 and legacy store shapes.

## 0.1.4 (2026-09-14)

- **New: one dropdown for branches and tags**: the Git panel's branch capsule is now a single native
  `<select>` that groups local branches, remote branches and tags with `<optgroup>`. Option values carry a
  `branch:` / `tag:` prefix (a branch and a tag may share a name), which routes the pick to `switchBranch` or
  to the new `switchTag` (`git switch --detach refs/tags/<name>`, a detached-HEAD checkout).
- The `tags` op now also returns `current` (the checked-out tag, non-empty only on a detached HEAD), so the
  capsule reflects the current ref — the tag name instead of `HEAD (no branch)` while on a tag.
- **Self-hosting guard**: `status` now reports `self` (whether the target directory is the plugin's own source
  tree). When the panel points at the plugin's repository, picking a tag asks for confirmation first (it
  replaces the running frontend code) — checking out `v0.1.1` used to downgrade the live plugin, which showed
  up as the old in-page branch menu. Branch picks are not gated, so getting back onto a branch stays one click.

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
