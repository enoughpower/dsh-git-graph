import { readFileSync, writeFileSync } from "node:fs";
const file = new URL("../lib/client.js", import.meta.url).pathname;
let s = readFileSync(file, "utf8");

// Patch 0: plugin id rename — the raw artifact was built for the scoped
// "@deepseek-ai/dsh-git-graph"; the published package is unscoped
// "dsh-git-graph". Applied LAST (after all patches) so the other anchors can
// keep referring to the raw text.
const idOld = "@deepseek-ai/dsh-git-graph";

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
const newDshCm = `let dshCm = (window.__DSH_BOOT__ && Array.isArray(window.__DSH_BOOT__.batches)) ? null : (window.DshCodeMirror && typeof window.DshCodeMirror.create === "function") ? window.DshCodeMirror : null;
    console.info("[dsh-git-graph] bundle marker: 20260912-b (self-hosting guard)");`;
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
s = s.slice(0, regStart) + '// 文件 page tab disabled for now (Git only): the CodeMirror file\n      // editor deadlocks on dsh 0.1.2-alpha.5. Restore later if needed.' + s.slice(regEnd);

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
      ".dshGitBranchMenu{position:fixed;top:50%;transform:translateY(-50%);left:12px;right:12px;width:auto;max-height:64vh;overflow:auto}",
      ".dshGitBody{gap:6px}",
      ".dshGitHistoryBand{height:178px !important}",
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
      ".dshGitCommitBar{flex-wrap:wrap;padding-bottom:calc(8px + env(safe-area-inset-bottom, 0px))}",
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
  [rowPk, `jsx("div", { role: "button", tabIndex: 0, style: { cursor: "pointer" }, title: f.path + (f.original ? " \\u2190 " + f.original : ""), onClick: () => showCommitFile(selectedCommit, f.path), onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); showCommitFile(selectedCommit, f.path); } }, children: f.path })`],
  [rowPk2, `jsx("div", { role: "button", tabIndex: 0, style: { cursor: "pointer" }, title: f.path + (f.original ? " ← " + f.original : ""), onClick: () => showDiff(f.path, isStaged), onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); showDiff(f.path, isStaged); } }, children: f.path })`],
]) {
  const c = s.split(o).length - 1;
  if (c !== 1) throw new Error(`expected file-row button to appear once, found ${c}`);
  s = s.split(o).join(n);
}

// Patch 9: unified NATIVE <select> branch picker. The capsule stays visible;
// an invisible-but-CLICKABLE <select> overlays it (absolute inset:0,
// opacity:0 — no pointer-events:none), so a real user click lands on the
// select itself and the browser opens the native picker (desktop dropdown /
// mobile wheel). The span's onClick is kept as a showPicker() fallback for
// areas the select does not cover, and the select's own onClick stops
// propagation so the two never double-fire. The custom branch menu is
// disabled globally.
const refA = "const msgRef = react.useRef(null);";
if (s.split(refA).length !== 2) throw new Error("msgRef anchor not found");
s = s.split(refA).join(refA + `
      const branchSelectRef = react.useRef(null);`);
const capOn = `onClick: () => setBranchMenu(branchMenu === "top" ? null : "top"), title: "分支切换"`;
if (s.split(capOn).length !== 2) throw new Error("capsule onClick anchor not found");
s = s.split(capOn).join(`onClick: () => { const el = branchSelectRef.current; if (el) { try { el.showPicker ? el.showPicker() : el.click(); } catch { try { el.click(); } catch {} } } }, title: "分支切换"`);
const caretAnchor = `jsx("span", { className: "dshGitBranchCaret", children: "\\u25BE" }),`;
if (s.split(caretAnchor).length !== 2) throw new Error("caret anchor not found");
const selectJsx = `jsx("select", { ref: branchSelectRef, className: "dshGitBranchSelect", value: branch || "", onClick: (e) => { e.stopPropagation(); }, onChange: (e) => { const v = e.target.value; if (v) runMutation("switchBranch", { name: v }); }, children: branches.map((b) => jsx("option", { key: b.name, value: b.name, children: (b.remote ? "远程 · " : "") + b.name + (b.current ? "（当前）" : "") })) }),`;
s = s.split(caretAnchor).join(caretAnchor + `
                ` + selectJsx);
// GLOBAL css (NOT inside @media): anchor on the top-level caret rule so the
// clickable overlay select applies on desktop too (mobile-only caused the
// visible "master (当前)" box on the web).
const selCssAnchor = `".dshGitBranchCaret{font-size:10px;opacity:.7}",`;
if (s.split(selCssAnchor).length !== 2) throw new Error("css global anchor not found");
s = s.split(selCssAnchor).join(selCssAnchor + `
      ".dshGitBranch{position:relative}",
      ".dshGitBranchSelect{position:absolute;inset:0;width:100%;height:100%;opacity:0;border:none;background:transparent;color:transparent;appearance:none;-webkit-appearance:none;font-size:16px}",
      // 原生弹层条目颜色继承 select：透明叠加写法使弹层文字透明，option 需显式主题令牌配色。
      ".dshGitBranchSelect option{color:var(--dsw-alias-label-primary);background-color:var(--dsw-alias-bg-base)}",
      // optgroup 分组标签（本地分支/远程分支/标签）同样继承 select 的透明色，需一并显式
      // 配色（弱化三级色 + 正常字形），否则弹层每个分组开头出现一行「空白」。
      ".dshGitBranchSelect optgroup{color:var(--dsw-alias-label-tertiary);background-color:var(--dsw-alias-bg-base);font-style:normal;font-weight:600}",
      ".dshGitBranchMenu{display:none !important}",`);

// Patch 10: always refresh the injected <style> tag. The old guard
// (create-only-if-absent) left STALE CSS after an HMR bundle reload, which is
// why layout fixes sometimes did not appear.
const oldCssInject = `    const cssTagId = "@deepseek-ai/dsh-git-graph/styles.css";
    if (typeof document !== "undefined" && document.querySelector('style[data-plugin-css="' + cssTagId + '"]') === null) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "@deepseek-ai/dsh-git-graph";
      tag.dataset.pluginCss = cssTagId;
      tag.textContent = css;
      document.head.appendChild(tag);
    }`;
const newCssInject = `    const cssTagId = "@deepseek-ai/dsh-git-graph/styles.css";
    if (typeof document !== "undefined") {
      let tag = document.querySelector('style[data-plugin-css="' + cssTagId + '"]');
      if (tag === null) {
        tag = document.createElement("style");
        tag.dataset.plugin = "@deepseek-ai/dsh-git-graph";
        tag.dataset.pluginCss = cssTagId;
        document.head.appendChild(tag);
      }
      tag.textContent = css;
    }`;
const c10 = s.split(oldCssInject).length - 1;
if (c10 !== 1) throw new Error(`expected css injection block to appear once, found ${c10}`);
s = s.split(oldCssInject).join(newCssInject);

// Patch 11 (LAST): plugin id rename so the bundle self-identifies as the
// unscoped package (registered under /plugins/dsh-git-graph).
const c11 = s.split(idOld).length - 1;
if (c11 !== 3) throw new Error(`expected plugin id to appear 3 times, found ${c11}`);
s = s.split(idOld).join("dsh-git-graph");

// Patch 12: long branch names. The capsule had max-width:220px, which clipped
// names like "feature/dsh-web-protocol-adaptation"; and since the branch text
// is a raw flex item, text-overflow:ellipsis cannot apply — it just cuts.
// Wrap the name in its own ellipsizing span, raise the cap, and show the full
// name in a hover tooltip.
const capOld = `max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",`;
if (s.split(capOld).length !== 2) throw new Error("branch capsule max-width anchor not found");
// No fixed cap: as a flex item it can take all the free space of the top bar
// (shrinkable, min-width:0), so long names show in full when the bar has room
// and ellipsize only when something else genuinely needs the width.
s = s.split(capOld).join(`flex:0 1 auto;min-width:0;overflow:hidden;white-space:nowrap}",
      ".dshGitBranchName{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",`);
const nameOld = `                jsx(primitives.IconBranchOutline16, { size: 14 }),
                branch,
                jsx("span", { className: "dshGitBranchCaret", children: "\\u25BE" }),`;
if (s.split(nameOld).length !== 2) throw new Error("branch name jsx anchor not found");
s = s.split(nameOld).join(`                jsx(primitives.IconBranchOutline16, { size: 14 }),
                jsx("span", { className: "dshGitBranchName", children: branch }),
                jsx("span", { className: "dshGitBranchCaret", children: "\\u25BE" }),`);
const tipOld = `title: "分支切换"`;
if (s.split(tipOld).length !== 2) throw new Error("branch tooltip anchor not found");
s = s.split(tipOld).join(`title: "分支切换：" + branch`);

// Patch 13: mobile bottom commit bar. On a narrow screen the desktop rules
// keep the status/output card at max-width:40%, so "Your branch is up to
// date…" wraps into a cramped tall strip and the textarea/buttons fight for
// one row. In the @media block (Patched by #6, which runs before this), stack
// the bar: message textarea on its own line, then a wrapping button row, then
// a FULL-WIDTH, shorter status card.
const mbarOld = `.dshGitCommitBar{flex-wrap:wrap;padding-bottom:calc(8px + env(safe-area-inset-bottom, 0px))}",`;
if (s.split(mbarOld).length !== 2) throw new Error("mobile commit-bar anchor not found");
s = s.split(mbarOld).join(mbarOld + `
      ".dshGitCommitBar .dshGitMsgInput{flex:1 1 100%;width:100%;min-height:40px}",
      ".dshGitCommitBar .dshGitIconBtn{flex:none}",
      ".dshGitCommitBar .dshGitCommitMsg{flex:1 1 100%;max-width:none;max-height:72px}",
      ".dshGitCommitBar .dshGitOut,.dshGitCommitBar .dshGitErr{max-height:60px;font-size:11px}",
      ".dshGitCommitBar{gap:6px}",`);


// Patch 14: ONE dropdown for branches AND tags. The panel could LIST tags (op
// `tags`) but never check one out, and the branch capsule only knew branches.
// The single capsule's native <select> now groups 本地分支 / 远程分支 / 标签;
// option values carry a `branch:` / `tag:` prefix because a branch and a tag
// may share a name, and the prefix picks `switchBranch` or `switchTag`. The
// host `tags` op also reports the tag HEAD sits on exactly, so the capsule
// shows the checked-out ref (branch or tag) instead of "HEAD (no branch)".
const tagStateAnchor = `const [branches, setBranches] = react.useState([]);`;
if (s.split(tagStateAnchor).length !== 2) throw new Error("branches state anchor not found");
s = s.split(tagStateAnchor).join(tagStateAnchor + `
      const [tags, setTags] = react.useState([]);
      const [currentTag, setCurrentTag] = react.useState("");`);

const tagRefreshOld = `        const [st, br, gr, cf] = await Promise.all([
          gitCall("status", { path: p }),
          gitCall("branches", { path: p }),
          gitCall("graphLog", { path: p, n: 500 }),
          gitCall("conflicts", { path: p }),
        ]);`;
const tagRefreshNew = `        const [st, br, gr, cf, tg] = await Promise.all([
          gitCall("status", { path: p }),
          gitCall("branches", { path: p }),
          gitCall("graphLog", { path: p, n: 500 }),
          gitCall("conflicts", { path: p }),
          gitCall("tags", { path: p }),
        ]);`;
if (s.split(tagRefreshOld).length !== 2) throw new Error("refresh Promise.all anchor not found");
s = s.split(tagRefreshOld).join(tagRefreshNew);

const tagConflictsAnchor = `        if (cf.ok) setConflicts(cf.value.files);`;
if (s.split(tagConflictsAnchor).length !== 2) throw new Error("conflicts anchor not found");
s = s.split(tagConflictsAnchor).join(tagConflictsAnchor + `
        if (tg.ok) { setTags(tg.value.tags); setCurrentTag(tg.value.current || ""); }`);

const tagCssAnchor = `".dshGitBranch{position:relative}",`;
if (s.split(tagCssAnchor).length !== 2) throw new Error("tag chip css anchor not found");
s = s.split(tagCssAnchor).join(tagCssAnchor + `
      ".dshGitTagActive{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}",`);

const refPickerOld = `          branch
            ? jsx("span", { className: "dshGitBranch dshGitBranchBtn" + (branchMenu === "top" ? " dshGitBranchActive" : ""), onClick: () => { const el = branchSelectRef.current; if (el) { try { el.showPicker ? el.showPicker() : el.click(); } catch { try { el.click(); } catch {} } } }, title: "分支切换：" + branch, children: [
                jsx(primitives.IconBranchOutline16, { size: 14 }),
                jsx("span", { className: "dshGitBranchName", children: branch }),
                jsx("span", { className: "dshGitBranchCaret", children: "\\u25BE" }),
                jsx("select", { ref: branchSelectRef, className: "dshGitBranchSelect", value: branch || "", onClick: (e) => { e.stopPropagation(); }, onChange: (e) => { const v = e.target.value; if (v) runMutation("switchBranch", { name: v }); }, children: branches.map((b) => jsx("option", { key: b.name, value: b.name, children: (b.remote ? "远程 · " : "") + b.name + (b.current ? "（当前）" : "") })) }),
              ] })
            : null,`;
const refPickerNew = `          branch || currentTag
            ? jsx("span", { className: "dshGitBranch dshGitBranchBtn" + (branchMenu === "top" ? " dshGitBranchActive" : "") + (currentTag ? " dshGitTagActive" : ""), onClick: () => { const el = branchSelectRef.current; if (el) { try { el.showPicker ? el.showPicker() : el.click(); } catch { try { el.click(); } catch {} } } }, title: currentTag ? "切换分支/标签（当前标签：" + currentTag + "）" : "切换分支/标签：" + branch, children: [
                jsx(primitives.IconBranchOutline16, { size: 14 }),
                jsx("span", { className: "dshGitBranchName", children: currentTag || branch }),
                jsx("span", { className: "dshGitBranchCaret", children: "\\u25BE" }),
                jsx("select", { ref: branchSelectRef, className: "dshGitBranchSelect", value: currentTag ? "tag:" + currentTag : "branch:" + branch, onClick: (e) => { e.stopPropagation(); }, onChange: (e) => { const v = e.target.value; if (v.indexOf("tag:") === 0) runMutation("switchTag", { name: v.slice(4) }); else if (v.indexOf("branch:") === 0) runMutation("switchBranch", { name: v.slice(7) }); }, children: [
                  branch && !currentTag && !branches.some((b) => b.name === branch) ? jsx("option", { key: "cur", value: "branch:" + branch, children: branch }) : null,
                  branches.filter((b) => !b.remote).length > 0 ? jsx("optgroup", { key: "local", label: "本地分支", children: branches.filter((b) => !b.remote).map((b) => jsx("option", { key: "b:" + b.name, value: "branch:" + b.name, children: b.name + (b.name === branch && !currentTag ? "（当前）" : "") })) }) : null,
                  branches.filter((b) => b.remote).length > 0 ? jsx("optgroup", { key: "remote", label: "远程分支", children: branches.filter((b) => b.remote).map((b) => jsx("option", { key: "b:" + b.name, value: "branch:" + b.name, children: b.name + (b.name === branch && !currentTag ? "（当前）" : "") })) }) : null,
                  tags.length > 0 ? jsx("optgroup", { key: "tags", label: "标签", children: tags.map((t) => jsx("option", { key: "t:" + t.name, value: "tag:" + t.name, children: t.name + (t.name === currentTag ? "（当前）" : "") })) }) : null,
                ] }),
              ] })
            : null,`;
if (s.split(refPickerOld).length !== 2) throw new Error("branch capsule anchor not found");
s = s.split(refPickerOld).join(refPickerNew);


// Patch 15: self-hosting guard. The panel's working directory can be the very
// repository that SHIPS this plugin (the profile installs it as a symlink to the
// dev checkout), so switching a tag there rewrites the plugin's own files and
// the running frontend reverts to that release's bundle — which is how the old
// branch menu reappeared. The host now reports `self` on `status`; when it is
// true a TAG pick asks for confirmation first. Branch picks stay ungated so the
// way back onto a branch is still one click.
const selfStateAnchor = `      const [currentTag, setCurrentTag] = react.useState("");`;
if (s.split(selfStateAnchor).length !== 2) throw new Error("currentTag state anchor not found");
s = s.split(selfStateAnchor).join(selfStateAnchor + `
      const [selfRepo, setSelfRepo] = react.useState(false);`);

const selfRefreshAnchor = `        if (tg.ok) { setTags(tg.value.tags); setCurrentTag(tg.value.current || ""); }`;
if (s.split(selfRefreshAnchor).length !== 2) throw new Error("tags refresh anchor not found");
s = s.split(selfRefreshAnchor).join(selfRefreshAnchor + `
        if (st.ok) setSelfRepo(st.value.self === true);`);

const tagPickOld = `onChange: (e) => { const v = e.target.value; if (v.indexOf("tag:") === 0) runMutation("switchTag", { name: v.slice(4) }); else if (v.indexOf("branch:") === 0) runMutation("switchBranch", { name: v.slice(7) }); }`;
const tagPickNew = `onChange: (e) => { const v = e.target.value; if (v.indexOf("tag:") === 0) { const name = v.slice(4); const go = () => runMutation("switchTag", { name }); if (selfRepo) setModal({ title: "切换到标签 " + name + "？", body: "当前仓库就是 dsh-git-graph 插件自身的源码目录。检出这个标签会把工作区变成该版本的代码，正在运行的插件前端也会随之切换（可能失去较新的功能）。确定继续？", action: go, onCancel: () => { const el = branchSelectRef.current; if (el) el.value = currentTag ? "tag:" + currentTag : "branch:" + branch; } }); else go(); } else if (v.indexOf("branch:") === 0) runMutation("switchBranch", { name: v.slice(7) }); }`;
if (s.split(tagPickOld).length !== 2) throw new Error("tag pick onChange anchor not found");
s = s.split(tagPickOld).join(tagPickNew);

const modalCloseOld = `modal ? jsx(Modal, { title: modal.title, onClose: () => setModal(null), children: jsxs(Fragment, { children: [`;
if (s.split(modalCloseOld).length !== 2) throw new Error("modal onClose anchor not found");
s = s.split(modalCloseOld).join(`modal ? jsx(Modal, { title: modal.title, onClose: () => { if (modal.onCancel) modal.onCancel(); setModal(null); }, children: jsxs(Fragment, { children: [`);

const modalCancelOld = `jsx(primitives.Button, { variant: "outline", size: "sm", onClick: () => setModal(null), children: "取消" }),`;
if (s.split(modalCancelOld).length !== 2) throw new Error("modal cancel anchor not found");
s = s.split(modalCancelOld).join(`jsx(primitives.Button, { variant: "outline", size: "sm", onClick: () => { if (modal.onCancel) modal.onCancel(); setModal(null); }, children: "取消" }),`);

// Patch 16: dsh 0.1.6-alpha.2 removed `current` from the sessions list store
// (`useSessions` SessionListState), so Git/Files resolved an empty working
// directory and the panel could not find the repository. The
// 'conversation.view' slot now passes the active `sessionId` as a framework
// prop: prefer it and keep `current` as a fallback for older runtimes.
const cwdOld = `      const sessionCwd = props.useSessions((s) => {
        const cur = s.current;
        if (!cur) return "";
        const entry = s.byId ? s.byId[cur] : undefined;
        return entry && typeof entry.cwd === "string" ? entry.cwd : "";
      });`;
const cwdNew = `      const sessionCwd = props.useSessions((s) => {
        // dsh 0.1.6-alpha.2 dropped the 'current' field from the sessions list
        // store; the conversation.view slot now passes the active Session id to
        // the view. Prefer it, with 'current' as a fallback for older runtimes.
        const cur = props.sessionId || s.current;
        if (!cur) return "";
        const entry = s.byId ? s.byId[cur] : undefined;
        return entry && typeof entry.cwd === "string" ? entry.cwd : "";
      });`;
const c16 = s.split(cwdOld).length - 1;
if (c16 !== 2) throw new Error(`expected the session-cwd selector to appear twice (Git + Files), found ${c16}`);
s = s.split(cwdOld).join(cwdNew);

// Patch 17: dsh 0.1.7-alpha.1 renamed the branch icon export
// (IconBranchOutline16 -> IconBranchOutlineRegular/IconBranchOutlineMedium).
// The removed name became an undefined JSX type, so React threw #130 and the
// whole Git view rendered the slot error boundary (blank panel) instead of the
// repository. Resolve whichever export exists at runtime; the fallback keeps
// the name from ever reaching React as `undefined`.
const primAnchor = `    let primitives = require("@deepseek-ai/dsh-client-ui-primitives");`;
if (s.split(primAnchor).length !== 2) throw new Error("primitives require anchor not found");
s = s.split(primAnchor).join(primAnchor + `
    // dsh 0.1.7-alpha.1 renamed the branch icon (IconBranchOutline16 ->
    // IconBranchOutlineRegular/IconBranchOutlineMedium). Resolve whichever
    // export exists at runtime: an unknown name would be an undefined JSX
    // type and throw React #130, crashing the whole view (GitTab blank).
    const BranchIcon = primitives.IconBranchOutline16
      || primitives.IconBranchOutlineRegular
      || primitives.IconBranchOutlineMedium
      || (() => null);`);
const iconUse = "primitives.IconBranchOutline16,";
const branchIconUses = s.split(iconUse).length - 1;
if (branchIconUses !== 3) throw new Error(`expected 3 branch-icon usages, found ${branchIconUses}`);
s = s.split(iconUse).join("BranchIcon,");

// Patch 18: multi-repo switcher. The panel used to be bound to the single session
// working directory; the host now exposes `listRepos` (depth-2 scan + worktree
// grouping), so the top bar gains a repository capsule between the Git title and
// the branch capsule, and the state flow picks the active repository. Exactly two
// effects: [sessionCwd] fires listRepos, [sessionCwd, repos] decides the selection
// — one effect holding both would re-enter on every repos reference change and
// storm the host with requests. The response stores the sessionCwd it was
// requested with as a freshness tag, so a previous session's repositories can
// never hijack the cwd before the new response lands (a realpath-normalised root
// cannot be compared instead: the two forms coexist on Windows). listRepos
// failures clear the list and fall back to the current UI. New code keeps Chinese
// comments (project convention). Anchors are taken from the post-Patch-17 text.
const repoStateAnchor = `      const [selfRepo, setSelfRepo] = react.useState(false);`;
if (s.split(repoStateAnchor).length !== 2) throw new Error("repo state anchor not found");
s = s.split(repoStateAnchor).join(repoStateAnchor + `
      // 多子仓切换器状态：repos 为宿主 listRepos 返回的仓库列表（按 relPath 排序、
      // 根仓库条目最前），rootIsRepo 标记会话根自身是否就是仓库，reposTruncated
      // 保存截断原因（非空即需在 UI 提示），reposTag 记录该批响应所对应的
      // sessionCwd，供选仓 effect 做新鲜度守卫（防上一会话脏数据劫持 cwd）。
      const [repos, setRepos] = react.useState([]);
      const [rootIsRepo, setRootIsRepo] = react.useState(false);
      const [reposTruncated, setReposTruncated] = react.useState("");
      const [reposTag, setReposTag] = react.useState("");
      // 「用户已手动选择子仓」标记：作用域 = 当前 sessionCwd，会话根变化时复位；
      // 跨会话不复位会错误抑制新会话的「自动进入首个子仓」，cwd 停在非仓库根报错。
      const repoPickedRef = react.useRef(false);`);

const repoSelectRefAnchor = `      const branchSelectRef = react.useRef(null);`;
if (s.split(repoSelectRefAnchor).length !== 2) throw new Error("repo select ref anchor not found");
s = s.split(repoSelectRefAnchor).join(repoSelectRefAnchor + `
      // 仓库胶囊的原生 select 引用：胶囊主体的点击兜底走 showPicker()。
      const repoSelectRef = react.useRef(null);`);

const repoResetAnchor = `      const [showAllFiles, setShowAllFiles] = react.useState(false);`;
if (s.split(repoResetAnchor).length !== 2) throw new Error("repo resetView anchor not found");
s = s.split(repoResetAnchor).join(repoResetAnchor + `

      // 切换仓库时清空右栏与选择残留（共 19 项）。message 与 textarea 内联高度必须
      // 一并重置：提交说明草稿不清会被误提交到新仓库；而受控 textarea 的高度只在
      // onChange 时重算，setMessage("") 的受控值变化不触发 onChange，不清内联高度
      // 会残留一个高的空输入框。
      // 有意保留：newBranchName / mergeTarget / confirmDelete / modal / historyH
      // （面板级偏好与瞬时 UI 态，切仓库无残留语义）。
      const resetView = () => {
        setDiffFile(null);
        diffFileRef.current = null;
        setDiffText("");
        setDiffTruncated(false);
        setDiffStaged(false);
        setSelectedCommit(null);
        setCommitFiles(null);
        setCommitFile(null);
        setSelectedCommitText("");
        setCommitDiffTruncated(false);
        setRightTab("diff");
        setFileViewText("");
        setFileViewHeadText("");
        setFileLog([]);
        setBlameLines([]);
        setError(null);
        setOutput("");
        setMessage("");
        if (msgRef.current) msgRef.current.style.height = "auto";
      };

      // 用户手动选择子仓：置「已手动选择」标记（抑制随后的自动选首仓），先清残留
      // 再切 cwd。后续所有 op 均以 activePath（= cwd）为 path，故自动跟随新仓库。
      const pickRepo = (path) => {
        if (!path || path === cwd) return;
        repoPickedRef.current = true;
        resetView();
        setCwd(path);
      };

      // 仓库胶囊 option 文案：仓库名优先 \`name（branch）\`；detached（无分支）显示「游离 短哈希」；
      // 位置消歧：relPath 与显示名不一致时（根仓显示「根」、嵌套仓显示相对路径）追加「· 位置」；
      // prunable 追加失效警示。
      const repoOptionText = (r) => {
        const head = r.branch ? r.branch : "游离" + (r.head ? " " + r.head : "");
        const disp = r.name || r.relPath;
        const where = r.relPath === "." ? "根" : r.relPath;
        const tail = where !== disp ? " · " + where : "";
        return disp + "（" + head + "）" + tail + (r.prunable ? " \\u26A0 疑似失效" : "");
      };

      // 仓库胶囊图标（与分支胶囊结构统一：图标 + 名称 + 折叠符）。用内联 SVG 而非
      // primitives 图标导出——图标名曾在 dsh 升级时被改名（BranchIcon 被迫做回退解析），
      // 内联可免疫此类外部变动。文件夹剪影，currentColor 继承胶囊文字色。
      const RepoIcon = ({ size }) => jsx("svg", { width: size, height: size, viewBox: "0 0 16 16", fill: "currentColor", "aria-hidden": true, children: jsx("path", { d: "M2.5 2h3.6c.4 0 .8.2 1.1.5l1.2 1.2c.3.3.7.5 1.1.5h4c.8 0 1.5.7 1.5 1.5v6.8c0 .8-.7 1.5-1.5 1.5h-11A1.5 1.5 0 0 1 1 12.5v-9C1 2.7 1.7 2 2.5 2z" }) });

      // 当前选中的仓库条目：优先精确匹配 cwd（用户切换或自动选首仓后必命中），
      // 退化到首条目（根仓库条目 relPath="." 恒排最前）。
      const repoCurrent = repos.find((r) => r.path === cwd) || repos[0] || null;`);

const repoEffectAnchor = `        if (sessionCwd) setCwd(sessionCwd);`;
if (s.split(repoEffectAnchor).length !== 2) throw new Error("repo listRepos effect anchor not found");
s = s.split(repoEffectAnchor).join(repoEffectAnchor + `
        // 会话根变化：同步清空上一会话的仓库列表与新鲜度标签，旧会话数据不再渲染
        // 切换器（新鲜度守卫由此转为纵深防御）；「已手动选择」标记也随之复位。
        setRepos([]);
        setReposTag("");
        repoPickedRef.current = false;
        if (!sessionCwd) { setRootIsRepo(false); setReposTruncated(""); return; }
        // 本 effect 只发起 listRepos（依赖里不含 repos，否则 repos 引用变化会重入
        // 触发请求风暴）。闭包捕获发起请求时的 sessionCwd 作为 tag；响应落地时随
        // repos 一并保存，供选仓 effect 判断新鲜度。tag 与 sessionCwd 同源同形态，
        // 精确相等即可（响应 root 经宿主 realpath 归一化，形态可能与 sessionCwd 不同）。
        const tag = sessionCwd;
        let stale = false;
        gitCall("listRepos", { path: sessionCwd }).then((r) => {
          // 乱序防护：会话根在响应返回前又变了，本响应已过期，直接丢弃。
          if (stale) return;
          if (!r || !r.ok) {
            // 请求失败：清空列表与 tag，回落现状 UI（不沿用旧会话数据）。
            setRepos([]);
            setRootIsRepo(false);
            setReposTruncated("");
            setReposTag("");
            return;
          }
          const v = r.value || {};
          setRootIsRepo(v.rootIsRepo === true);
          setReposTruncated(typeof v.truncated === "string" ? v.truncated : "");
          setRepos(Array.isArray(v.repos) ? v.repos : []);
          setReposTag(tag);
        });
        return () => { stale = true; };`);

const repoPickEffectAnchor = `      const activePath = cwd;`;
if (s.split(repoPickEffectAnchor).length !== 2) throw new Error("repo pick effect anchor not found");
s = s.split(repoPickEffectAnchor).join(`
      // 选仓 effect（双 effect 结构之二）：只做选仓判断，绝不发请求。首判 tag 与
      // 当前 sessionCwd 相等（新鲜度守卫）才允许动作——sessionCwd 变化后、新响应
      // 到达前的窗口内 repos/rootIsRepo 仍是上一会话的值，不设守卫会把 cwd 劫持到
      // 旧会话的子仓；依赖 [sessionCwd, repos] 同时使选仓动作与 effect 声明顺序无关。
      react.useEffect(() => {
        if (!reposTag || reposTag !== sessionCwd) return; // 旧会话脏数据：本轮 no-op
        if (repos.length === 0) return;
        if (rootIsRepo) return;                           // 根即仓库：cwd 保持会话根
        if (repoPickedRef.current) return;                // 用户已手动选择：不覆盖
        // 会话根非仓库且有子仓：自动进入第一个子仓（顺带修复现状「非仓库根直接报错」）。
        resetView();
        setCwd(repos[0].path);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [sessionCwd, repos]);

      const activePath = cwd;`);

const repoCapsuleAnchor = `          branch || currentTag`;
if (s.split(repoCapsuleAnchor).length !== 2) throw new Error("repo capsule anchor not found");
s = s.split(repoCapsuleAnchor).join(`          repos.length > 0 && (repos.length > 1 || !rootIsRepo)
            ? jsx("span", { className: "dshGitRepo dshGitBranch dshGitBranchBtn", onClick: () => { const el = repoSelectRef.current; if (el) { try { el.showPicker ? el.showPicker() : el.click(); } catch { try { el.click(); } catch {} } } }, title: "切换仓库（当前：" + (repoCurrent ? repoCurrent.path : cwd) + "）" + (reposTruncated ? "｜⚠ 列表已截断：" + reposTruncated : ""), children: [
                jsx(RepoIcon, { size: 14 }),
                jsx("span", { className: "dshGitBranchName", children: repoCurrent ? (repoCurrent.name || repoCurrent.relPath) : "." }),
                jsx("span", { className: "dshGitBranchCaret", children: "\\u25BE" }),
                jsx("select", { ref: repoSelectRef, className: "dshGitBranchSelect", value: repoCurrent ? repoCurrent.path : "", onClick: (e) => { e.stopPropagation(); }, onChange: (e) => { pickRepo(e.target.value); }, children: [
                  reposTruncated ? jsx("option", { key: "truncated", value: "", disabled: true, children: "⚠ 列表已截断：" + reposTruncated }) : null,
                  repos.map((r) => jsx("option", { key: r.path, value: r.path, title: r.path, children: repoOptionText(r) })),
                ] }),
              ] })
            : null,
          branch || currentTag`);

writeFileSync(file, s);
console.log("patched client bundle: openFile guard + wording + alpha.5 cm fallback + git-only tabs + width handles + mobile responsive + tag switch + self-hosting guard + 0.1.6 session cwd + 0.1.7 branch icon + multi-repo switcher");
