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

writeFileSync(file, s);
console.log("patched client bundle: openFile guard + wording + alpha.5 cm fallback");
