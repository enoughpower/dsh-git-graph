import { readFileSync, writeFileSync } from "node:fs";
const file = new URL("../lib/client.js", import.meta.url).pathname;
let s = readFileSync(file, "utf8");

// Patch 1: guard oversized / pathological-line text files so the editor's
// syntax highlighter is never fed a monster document that freezes the page.
const oldOpen = `const openFile = async (path) => {
        setSelected(path);
        const r = await fsCall("read", { root: cwd, path });
        if (r.ok) { setContent(r.value); setEdit(false); setDraft(r.value.type === "text" ? r.value.text : ""); setError(null); }
        else setError(r.error?.message || "read failed");
      };`;

const newOpen = `const openFile = async (path) => {
        setSelected(path);
        const r = await fsCall("read", { root: cwd, path });
        if (r.ok) {
          const v = r.value;
          const tooBig = v && v.type === "text" && (v.text.length > 700000 || v.text.split("\\n").reduce((m, l) => l.length > m ? l.length : m, 0) > 50000);
          setContent(tooBig ? { type: "binary", size: v.text.length } : v);
          setEdit(false);
          setDraft(tooBig ? "" : v.type === "text" ? v.text : "");
          setError(null);
        }
        else setError(r.error?.message || "read failed");
      };`;

const c1 = s.split(oldOpen).length - 1;
if (c1 !== 1) throw new Error(`expected openFile block to appear once, found ${c1}`);
s = s.split(oldOpen).join(newOpen);

// Patch 2: make the "cannot preview" pane wording cover oversized text too.
const oldBin = `"二进制文件"`;
const newBin = `"文件过大或二进制"`;
const c2 = s.split(oldBin).length - 1;
if (c2 !== 1) throw new Error(`expected binary wording to appear once, found ${c2}`);
s = s.split(oldBin).join(newBin);

// Patch 3: dsh 0.1.2-alpha.5 changed the client module system to a batched
// boot manifest (`window.__DSH_BOOT__.batches`). Under that runtime the
// CodeMirror MutationObserver deadlocks on scroll (infinite mutation loop).
// Detect it and fall back to the built-in highlightHtml/pre/textarea renderer
// (no MutationObserver); rc.2 keeps the full CodeMirror editor.
const oldDshCm = `let dshCm = (window.DshCodeMirror && typeof window.DshCodeMirror.create === "function") ? window.DshCodeMirror : null;`;
const newDshCm = `let dshCm = (window.__DSH_BOOT__ && Array.isArray(window.__DSH_BOOT__.batches)) ? null : (window.DshCodeMirror && typeof window.DshCodeMirror.create === "function") ? window.DshCodeMirror : null;`;
const c3 = s.split(oldDshCm).length - 1;
if (c3 !== 1) throw new Error(`expected dshCm definition to appear once, found ${c3}`);
s = s.split(oldDshCm).join(newDshCm);

// Patch 4: git-only mode — drop the "文件" conversation.view tab (the file
// editor is disabled for now; keep the Git tab).
const filesAnchor = s.indexOf('id: "files"');
if (filesAnchor === -1) throw new Error("expected files tab registration to appear once");
const regStart = s.lastIndexOf('ctx.slots.inject("conversation.view", () =>', filesAnchor);
const filesIdx = s.indexOf("FilesView,", regStart);
const regEnd = s.indexOf(");", filesIdx) + 2;
s = s.slice(0, regStart) + '      // "文件" page tab disabled for now (Git only).' + s.slice(regEnd);

// Patch 5: dsh 0.1.2-alpha.5's conversation root renders resizable pane
// width handles (data-width-handle) that show as vertical bars over the
// full-screen Git view. The handles are SIBLINGS of the scroll body (inside
// .body), so select via the general sibling combinator.
const anchorRule = `"[data-slot=\\"conversation.session\\"]:has([data-git-view]) > div{flex:1 1 0% !important;min-height:0 !important}",`;
const c5 = s.split(anchorRule).length - 1;
if (c5 !== 1) throw new Error(`expected git-view css anchor to appear once, found ${c5}`);
s = s.split(anchorRule).join(
  anchorRule + `\n      "[data-conversation-scroll]:has([data-git-view]) ~ [data-width-handle]{display:none !important}",`
);

// Patch 6: mobile adaptation — register the Git tab on phones too (dsh-pocket
// no longer hides it) and add responsive media queries: stack the panel,
// compact the chrome, enlarge touch targets.
const oldGate = `const pocketPhone = (typeof location !== "undefined") &&
        new URLSearchParams(location.search).has("dsh-desktop-mode");
      if (pocketPhone) return;`;
const c6 = s.split(oldGate).length - 1;
if (c6 !== 1) throw new Error(`expected mobile gate to appear once, found ${c6}`);
s = s.split(oldGate).join(
  `// Mobile (dsh-pocket) gets the Git tab too: the view is in-flow and
      // responsive below (see the @media rules), so it adapts to narrow
      // screens instead of being hidden.`
);
const mediaAnchor = `"[data-conversation-scroll]:has([data-git-view]) ~ [data-width-handle]{display:none !important}",`;
const c7 = s.split(mediaAnchor).length - 1;
if (c7 !== 1) throw new Error(`expected css anchor to appear once, found ${c7}`);
s = s.split(mediaAnchor).join(mediaAnchor + `
      // ── mobile (narrow screens / dsh-pocket drawer): stack the panel,
      //    compact the chrome and enlarge touch targets ──
      "@media (max-width: 768px){",
      ".dshGitRoot{overflow-y:auto;gap:8px}",
      ".dshGitTop{flex-wrap:wrap;height:auto;padding:8px 10px;gap:6px}",
      ".dshGitTopTitle{font-size:15px}",
      ".dshGitBranchMenu{position:fixed;width:calc(100% - 24px);left:12px;right:12px}",
      ".dshGitBody{gap:6px}",
      ".dshGitHistoryBand{height:auto !important;max-height:38vh;min-height:140px}",
      ".dshGitResizeHandle{display:none}",
      ".dshGitLowerSplit{flex-direction:column;overflow-y:auto}",
      ".dshGitLowerSplit > .dshGitCol{width:100% !important;flex:0 0 auto !important;max-height:44vh;border-right:none;border-bottom:1px solid var(--dsw-alias-border-l2)}",
      ".dshGitLowerSplit > .dshGitCol > .dshGitSection{min-height:0}",
      ".dshGitDiff{overflow-x:auto}",
      ".dshGitDiffLine{font-size:11px}",
      ".dshGitLn{width:32px}",
      ".dshGitIconBtn{width:36px;height:36px}",
      ".dshGitInput{width:120px}",
      ".dshGitSection{padding:8px 10px}",
      ".dshGitCommitBar{flex-wrap:wrap}",
      "}",`);

// Patch 7: dsh-pocket injects "copy file content" buttons (data-mobile-nav=
// "copy-file") next to path-like text on mobile; hide them inside the Git view.
const pocketAnchor = `"[data-conversation-scroll]:has([data-git-view]) ~ [data-width-handle]{display:none !important}",`;
const c8 = s.split(pocketAnchor).length - 1;
if (c8 !== 1) throw new Error(`expected css anchor to appear once, found ${c8}`);
s = s.split(pocketAnchor).join(pocketAnchor + `
      // dsh-pocket injects "copy file content" buttons next to path-like text
      // on mobile; hide them inside the Git view.
      "[data-git-view] [data-mobile-nav=\\"copy-file\\"]{display:none !important}",`);

// Patch 8: dsh-pocket's mobile file guard intercepts ANY `<button>/<a>` whose
// text looks like a file path (toast + swallows the click). Our file rows are
// path-text buttons, so switch them to `<div role="button">` — the guard only
// matches button/a. (Both rows get keyboard support.)
const rowPk = `jsx("button", { type: "button", title: f.path + (f.original ? " \\u2190 " + f.original : ""), onClick: () => showCommitFile(selectedCommit, f.path), children: f.path })`;
const rowPk2 = `jsx("button", { type: "button", title: f.path + (f.original ? " ← " + f.original : ""), onClick: () => showDiff(f.path, isStaged), children: f.path })`;
for (const [o, n] of [
  [rowPk, `jsx("div", { role: "button", tabIndex: 0, title: f.path + (f.original ? " \\u2190 " + f.original : ""), onClick: () => showCommitFile(selectedCommit, f.path), onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); showCommitFile(selectedCommit, f.path); } }, children: f.path })`],
  [rowPk2, `jsx("div", { role: "button", tabIndex: 0, title: f.path + (f.original ? " ← " + f.original : ""), onClick: () => showDiff(f.path, isStaged), onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); showDiff(f.path, isStaged); } }, children: f.path })`],
]) {
  const c = s.split(o).length - 1;
  if (c !== 1) throw new Error(`expected file-row button to appear once, found ${c}`);
  s = s.split(o).join(n);
}

writeFileSync(file, s);
console.log("patched client bundle: openFile guard + wording + alpha.5 cm fallback + git-only tabs + width handles + mobile responsive");
