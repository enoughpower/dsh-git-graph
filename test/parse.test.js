/**
 * Unit tests for the exported parsing / safety helpers.
 *
 * Run with: node --test test/parse.test.js
 * These are pure functions with no I/O, so the suite is fast and offline.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  ok,
  fail,
  parsePorcelainLine,
  parsePorcelainRename,
  parseBranchHeader,
  splitPorcelain,
  safePath,
} from "../lib/index.js";

test("ok/fail build the standard envelope", () => {
  assert.deepEqual(ok({ a: 1 }), { ok: true, value: { a: 1 } });
  assert.deepEqual(fail("e1", "msg"), { ok: false, error: { code: "e1", message: "msg" } });
  assert.deepEqual(fail("e1", "msg", { extra: true }), {
    ok: false,
    error: { code: "e1", message: "msg", extra: true },
  });
});

test("parsePorcelainLine keeps the two status columns distinct", () => {
  // staged modified (index only) — the code is trimmed, position lives in staged/worktree
  assert.deepEqual(parsePorcelainLine("M  a.txt"), { code: "M", staged: true, worktree: "", path: "a.txt", original: "" });
  // worktree modified (unstaged)
  assert.deepEqual(parsePorcelainLine(" M b.txt"), { code: "M", staged: false, worktree: "M", path: "b.txt", original: "" });
  // both index and worktree modified
  assert.deepEqual(parsePorcelainLine("MM c.txt"), { code: "MM", staged: true, worktree: "M", path: "c.txt", original: "" });
  // untracked
  const untracked = parsePorcelainLine("?? d.txt");
  assert.equal(untracked.code, "??");
  assert.equal(untracked.staged, false);
  assert.equal(untracked.path, "d.txt");
});

test("parsePorcelainLine splits a rename arrow and keeps the original", () => {
  const r = parsePorcelainLine("R  old.txt -> new.txt");
  assert.equal(r.code, "R");
  assert.equal(r.path, "new.txt");
  assert.equal(r.original, "old.txt");
  assert.equal(r.staged, true);
});

test("parsePorcelainRename handles quoted paths with spaces", () => {
  const r = parsePorcelainRename('R  "a b.txt" -> "c d.txt"');
  assert.equal(r.original, "a b.txt");
  assert.equal(r.path, "c d.txt");
  assert.equal(r.code, "R");
});

test("parseBranchHeader parses branch, upstream and ahead/behind", () => {
  assert.deepEqual(parseBranchHeader("## main"), { branch: "main", upstream: "", ahead: 0, behind: 0 });
  assert.deepEqual(parseBranchHeader("## main...origin/main"), { branch: "main", upstream: "origin/main", ahead: 0, behind: 0 });
  assert.deepEqual(parseBranchHeader("## main...origin/main [ahead 1, behind 2]"), { branch: "main", upstream: "origin/main", ahead: 1, behind: 2 });
  assert.deepEqual(parseBranchHeader("## No commits yet on main"), { branch: "main", upstream: "", ahead: 0, behind: 0 });
});

test("splitPorcelain groups staged / unstaged / untracked and skips the header", () => {
  const stdout = [
    "## main...origin/main [ahead 1]",
    "M  staged.txt",
    " M unstaged.txt",
    "?? untracked.txt",
  ].join("\n");
  const { staged, unstaged, untracked } = splitPorcelain(stdout);
  assert.deepEqual(staged.map((f) => f.path), ["staged.txt"]);
  assert.deepEqual(unstaged.map((f) => f.path), ["unstaged.txt"]);
  assert.deepEqual(untracked.map((f) => f.path), ["untracked.txt"]);
  assert.equal(untracked[0].status, "??");
});

test("splitPorcelain routes renames correctly", () => {
  const stdout = ["R  old.txt -> new.txt", " R w.txt -> x.txt"].join("\n");
  const { staged, unstaged } = splitPorcelain(stdout);
  assert.equal(staged[0].path, "new.txt");
  assert.equal(staged[0].original, "old.txt");
  assert.equal(unstaged[0].path, "x.txt");
  assert.equal(unstaged[0].original, "w.txt");
});

test("safePath keeps paths under the root", () => {
  assert.equal(safePath("/repo", "/repo/a.txt"), "/repo/a.txt");
  assert.equal(safePath("/repo", "/repo/sub/dir/b.txt"), "/repo/sub/dir/b.txt");
  // `..` inside the root is normalised, staying inside
  assert.equal(safePath("/repo", "/repo/a/../b.txt"), "/repo/b.txt");
  // the root itself is allowed
  assert.equal(safePath("/repo", "/repo"), "/repo");
});

test("safePath rejects paths that escape the root", () => {
  assert.throws(() => safePath("/repo", "../outside"), /outside the workspace root/);
  assert.throws(() => safePath("/repo", "/etc/passwd"), /outside the workspace root/);
  assert.throws(() => safePath("/repo", "/repo/../../etc/passwd"), /outside the workspace root/);
});
