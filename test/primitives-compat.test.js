/**
 * Regression test for dsh 0.1.7-alpha.1: the branch icon export was renamed
 * (IconBranchOutline16 -> IconBranchOutlineRegular / IconBranchOutlineMedium).
 * The plugin rendered the removed name directly, so React received an
 * undefined element type and threw error #130, replacing the whole Git view
 * with the slot error boundary.
 *
 * The bundle must resolve whichever export exists at runtime and must never
 * hand an undefined component to React.
 *
 * Run with: node --test test/primitives-compat.test.js
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const bundle = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
const patchScript = readFileSync(new URL("../scripts/patch-client.mjs", import.meta.url), "utf8");

/**
 * Pull the runtime fallback expression out of the bundle.
 *
 * 行尾必须容忍 CRLF：本仓库 `core.autocrlf=true`，Windows 检出为 `\r\n`，
 * 只匹配 `;\n` 会在工作树上失配（bundle 内的 BranchIcon 形态保持不变）。
 */
function extractBranchIconResolver(source) {
  const m = source.match(/const BranchIcon = ([\s\S]*?);\r?\n/);
  assert.ok(m, "bundle must define a BranchIcon resolver");
  return m[1];
}

test("BranchIcon resolves across dsh versions and never yields undefined", () => {
  const expr = extractBranchIconResolver(bundle);
  const resolve = new Function("primitives", `return (${expr})`);

  const legacy = () => "legacy-16";
  const regular = () => "regular";
  const medium = () => "medium";

  // dsh 0.1.6-alpha.2 and earlier.
  assert.equal(resolve({ IconBranchOutline16: legacy }), legacy);
  // dsh 0.1.7-alpha.1.
  assert.equal(resolve({ IconBranchOutlineRegular: regular, IconBranchOutlineMedium: medium }), regular);
  // Only the medium artwork exists.
  assert.equal(resolve({ IconBranchOutlineMedium: medium }), medium);
  // A future runtime with none of them still returns a renderable component.
  const fallback = resolve({});
  assert.equal(typeof fallback, "function", "fallback must be a component, never undefined");
  assert.equal(fallback(), null);
});

test("the bundle never uses a removed primitive as a JSX type", () => {
  // The renamed name may only appear inside the resolver, never as an element.
  assert.doesNotMatch(bundle, /primitives\.IconBranchOutline16\s*,/,
    "IconBranchOutline16 must not be passed to jsx()/jsxs() directly");
  const uses = (bundle.match(/jsxs?\(BranchIcon,/g) ?? []).length;
  assert.equal(uses, 3, "every branch icon render goes through the resolver");
});

test("only still-exported primitives are referenced directly", () => {
  // jsx(primitives.X, ...) / jsxs(primitives.X, ...)
  const direct = [...bundle.matchAll(/jsxs?\(primitives\.([A-Za-z0-9_]+),/g)].map(m => m[1]);
  assert.deepEqual([...new Set(direct)].sort(), ["Button"],
    "add a version-tolerant resolver before referencing any new primitive");
});

test("patch-client.mjs records the 0.1.7 branch-icon fix", () => {
  assert.match(patchScript, /Patch 17: dsh 0\.1\.7-alpha\.1 renamed the branch icon/);
  assert.match(patchScript, /primitives\.IconBranchOutlineRegular/);
});
