/**
 * Unit tests for the exported parsing / safety / repository-discovery helpers.
 *
 * Run with: node --test test/parse.test.js
 *
 * 纯函数部分（envelope / porcelain 解析 / safePath / listRepos 的解析与归一化助手）
 * 无 I/O，离线且快速；扫描器与入口 realpath 归一化需要真实文件系统，使用系统临时
 * 目录、测试结束后清理（无网络依赖）。
 */
import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative } from "node:path";
import {
  ok,
  fail,
  parsePorcelainLine,
  parsePorcelainRename,
  parseBranchHeader,
  splitPorcelain,
  safePath,
  normalizeRepoPath,
  repoRelPath,
  normalizeScanDepth,
  parseWorktreePorcelain,
  worktreeGroupKey,
  worktreeRole,
  isInsideScanRoot,
  isInsideGroupKey,
  filterWorktreeEntries,
  mergeRepoEntries,
  scanRepoDirs,
} from "../lib/index.js";

/**
 * 稳健清理临时目录：Windows 上 git / 文件句柄可能延迟释放导致 EBUSY，
 * 线性退避重试；仍失败则放弃（残留临时目录不影响测试语义）。
 */
async function rmRetry(dir, attempts = 6) {
  if (!dir) return;
  for (let i = 0; i < attempts; i += 1) {
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return;
    } catch {
      if (i === attempts - 1) return;
      await new Promise((r) => setTimeout(r, 150 * (i + 1)));
    }
  }
}

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
  // 期望值一律用 path API 构造：Windows 下 resolve 会得到盘符形态，硬编码 POSIX 会误判
  const root = resolve("/repo");
  assert.equal(safePath(root, resolve(root, "a.txt")), resolve(root, "a.txt"));
  assert.equal(safePath(root, join(root, "sub", "dir", "b.txt")), join(root, "sub", "dir", "b.txt"));
  // `..` inside the root is normalised, staying inside
  assert.equal(safePath(root, resolve(root, "a", "..", "b.txt")), resolve(root, "b.txt"));
  // the root itself is allowed
  assert.equal(safePath(root, root), root);
});

test("safePath rejects paths that escape the root", () => {
  assert.throws(() => safePath("/repo", "../outside"), /outside the workspace root/);
  assert.throws(() => safePath("/repo", "/etc/passwd"), /outside the workspace root/);
  assert.throws(() => safePath("/repo", "/repo/../../etc/passwd"), /outside the workspace root/);
});

// ── listRepos 纯函数：路径归一化 ────────────────────────────────────────────

test("normalizeRepoPath unifies separators, trims trailing slashes and keeps drive roots", () => {
  assert.equal(normalizeRepoPath("C:\\a\\b\\"), "C:/a/b");
  assert.equal(normalizeRepoPath("/a/b///"), "/a/b");
  // 驱动器根保留末尾斜杠，避免归一成非法的 `C:`
  assert.equal(normalizeRepoPath("C:\\"), "C:/");
  assert.equal(normalizeRepoPath(""), "");
  assert.equal(normalizeRepoPath(undefined), "");
  assert.equal(normalizeRepoPath(resolve("/r", "sub")), normalizeRepoPath(resolve("/r", "sub")));
  assert.match(normalizeRepoPath(resolve("/r", "sub")), /\/r\/sub$/);
});

test("repoRelPath returns '.' for the root itself and forward-slash relatives", () => {
  assert.equal(repoRelPath(resolve("/r"), resolve("/r")), ".");
  assert.equal(repoRelPath(resolve("/r"), resolve("/r", "a", "b")), "a/b");
  assert.equal(repoRelPath(resolve("/r") + "/", resolve("/r", "a")), "a");
});

// ── listRepos 纯函数：depth 语义 ────────────────────────────────────────────

test("normalizeScanDepth: 缺省 2、非法落缺省、越界钳制到 1–4", () => {
  assert.equal(normalizeScanDepth(undefined), 2);
  assert.equal(normalizeScanDepth(null), 2);
  assert.equal(normalizeScanDepth(0), 2);
  assert.equal(normalizeScanDepth(-3), 2);
  assert.equal(normalizeScanDepth(1.5), 2);
  assert.equal(normalizeScanDepth(Number.NaN), 2);
  assert.equal(normalizeScanDepth("2"), 2);
  assert.equal(normalizeScanDepth(1), 1);
  assert.equal(normalizeScanDepth(2), 2);
  assert.equal(normalizeScanDepth(4), 4);
  assert.equal(normalizeScanDepth(5), 4);
  assert.equal(normalizeScanDepth(99), 4);
});

// ── listRepos 纯函数：worktree porcelain 解析 ───────────────────────────────

test("parseWorktreePorcelain 按 worktree 行分块并剥除 refs/heads 前缀", () => {
  const stdout = [
    "worktree C:/x/main",
    "HEAD abc1234567",
    "branch refs/heads/main",
    "",
    "worktree C:/x/wt",
    "HEAD def7654321",
    "branch refs/heads/feat",
    "detached",
    "locked why",
    "prunable gone now",
    "",
    "worktree C:/x/bare.git",
    "bare",
    "",
  ].join("\n");
  const entries = parseWorktreePorcelain(stdout);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries[0], {
    path: "C:/x/main", head: "abc1234567", branch: "main",
    detached: false, bare: false, locked: "", prunable: "",
  });
  assert.equal(entries[1].branch, "feat");
  assert.equal(entries[1].detached, true);
  assert.equal(entries[1].locked, "why");
  assert.equal(entries[1].prunable, "gone now");
});

test("parseWorktreePorcelain 容忍 CRLF、未知 annotation、首块前杂项与 bare 无 HEAD", () => {
  const stdout = [
    "future-annotation 1",
    "worktree /repo/bare.git",
    "bare",
    "worktree /repo/with space",
    "HEAD 1111111111",
    "branch refs/heads/topic",
    "unknown-future-line whatever",
  ].join("\r\n") + "\r\n";
  const entries = parseWorktreePorcelain(stdout);
  assert.equal(entries.length, 2, "首块之前的杂项必须忽略");
  // bare 条目没有 HEAD / branch 行：容错为空串
  assert.deepEqual(entries[0], {
    path: "/repo/bare.git", head: "", branch: "",
    detached: false, bare: true, locked: "", prunable: "",
  });
  assert.equal(entries[1].path, "/repo/with space");
  assert.equal(entries[1].branch, "topic");
});

test("parseWorktreePorcelain 对空输入与无 worktree 行输出返回空数组", () => {
  assert.deepEqual(parseWorktreePorcelain(""), []);
  assert.deepEqual(parseWorktreePorcelain(undefined), []);
  assert.deepEqual(parseWorktreePorcelain("HEAD abc\nbranch refs/heads/main\n"), []);
});

// ── listRepos 纯函数：归组键 / role / 过滤 / 合流 ───────────────────────────

test("worktreeGroupKey：common-dir 三形态归一为同组同 key", () => {
  const repoRoot = resolve("/repos/proj");
  const gitDir = resolve(repoRoot, ".git");
  // 主仓根：`.git`；主仓子目录：`../.git`；仅 linked worktree：绝对路径
  const fromMain = worktreeGroupKey(repoRoot, ".git");
  const fromSubdir = worktreeGroupKey(resolve(repoRoot, "sub"), "../.git");
  const fromLinked = worktreeGroupKey(resolve("/repos/proj-wt"), gitDir);
  assert.equal(fromMain, normalizeRepoPath(gitDir));
  assert.equal(fromSubdir, fromMain);
  assert.equal(fromLinked, fromMain);
  // 空输出退化为主仓目录本身，不产生空 key
  assert.equal(worktreeGroupKey(repoRoot, ""), normalizeRepoPath(repoRoot));
});

test("worktreeRole：条目路径等于归组键父目录者为 main，其余 linked（含 bare 组）", () => {
  const groupKey = worktreeGroupKey(resolve("/repos/proj"), ".git");
  assert.equal(worktreeRole(resolve("/repos/proj"), groupKey), "main");
  assert.equal(worktreeRole(resolve("/repos/proj-wt"), groupKey), "linked");

  // bare 主仓：归组键指向 <bare>.git，其父目录是 bare 仓所在目录，不是 bare 仓本身
  const bareKey = normalizeRepoPath(resolve("/repos/bare.git"));
  assert.equal(worktreeRole(resolve("/repos/bare.git"), bareKey), "linked");
  assert.equal(worktreeRole(resolve("/repos/bare-wt"), bareKey), "linked");
});

test("isInsideScanRoot：根内为真、根本身与根外为假（含前缀同名目录陷阱）", () => {
  const root = resolve("/repos");
  assert.equal(isInsideScanRoot(resolve("/repos/a"), root), true);
  assert.equal(isInsideScanRoot(resolve("/repos/a/b"), root), true);
  assert.equal(isInsideScanRoot(root, root), false, "根本身由根探测通道产出，本通道剔除");
  assert.equal(isInsideScanRoot(resolve("/repos-outside"), root), false);
  assert.equal(isInsideScanRoot(resolve("/other"), root), false);
});

test("isInsideGroupKey：等于键或位于键目录内部为真（含前缀同名陷阱）", () => {
  const key = normalizeRepoPath(resolve("/super/.git/modules/sub"));
  assert.equal(isInsideGroupKey(resolve("/super/.git/modules/sub"), key), true);
  assert.equal(isInsideGroupKey(resolve("/super/.git/modules/sub/x"), key), true);
  assert.equal(isInsideGroupKey(resolve("/super/sub"), key), false);
  // /super/.git/modules/sub-other 与键同前缀但不在键目录内
  assert.equal(isInsideGroupKey(resolve("/super/.git/modules/sub-other"), key), false);
});

test("filterWorktreeEntries：剔除 bare / 根外 / 根本身 / 键内部与畸形条目", () => {
  const root = resolve("/repos");
  const groupKey = worktreeGroupKey(resolve("/repos/proj"), ".git");
  const keep = { path: resolve("/repos/proj-wt"), bare: false };
  const entries = [
    keep,
    { path: resolve("/repos/proj"), bare: true },          // bare
    { path: resolve("/repos"), bare: false },              // 根本身
    { path: resolve("/outside/proj-wt"), bare: false },    // 根外
    { path: resolve("/repos/proj/.git/worktrees/x"), bare: false }, // 键内部
    { path: "", bare: false },                             // 空路径
    null,
  ];
  assert.deepEqual(filterWorktreeEntries(entries, { root, groupKey }).map((e) => e.path), [keep.path]);
});

test("submodule 幽灵条目：其 gitdir 位置落在归组键内部而被剔除，工作目录直取条目保留", () => {
  // 真实形态：submodule 组 porcelain 唯一条目路径 = <主仓>/.git/modules/sub
  const superRoot = resolve("/super");
  const groupKey = normalizeRepoPath(resolve(superRoot, ".git", "modules", "sub"));
  const ghost = { path: resolve(superRoot, ".git", "modules", "sub"), bare: false };
  const workdir = { path: resolve(superRoot, "sub"), bare: false };
  assert.equal(isInsideGroupKey(ghost.path, groupKey), true, "幽灵条目必须落在键内部");
  assert.equal(isInsideGroupKey(workdir.path, groupKey), false, "submodule 工作目录不在键内部");
  const kept = filterWorktreeEntries([ghost, workdir], { root: superRoot, groupKey });
  assert.deepEqual(kept.map((e) => e.path), [workdir.path]);
});

test("mergeRepoEntries：按归一化路径去重、porcelain 字段优先、'.' 排最前、空组丢弃", () => {
  const rootEntry = {
    path: resolve("/repos/proj"), relPath: ".", name: "proj", branch: "main", head: "aaaaaaa1",
    group: "k", worktree: { role: "main" }, prunable: "",
  };
  const scanSub = {
    path: resolve("/repos/proj/sub"), relPath: "sub", name: "sub", branch: "", head: "",
    group: "k2", worktree: { role: "linked" }, prunable: "",
  };
  const scanZeta = {
    path: resolve("/repos/zeta"), relPath: "zeta", name: "zeta", branch: "main", head: "bbbbbbb2",
    group: "k3", worktree: { role: "main" }, prunable: "",
  };
  const porcelainSub = {
    path: resolve("/repos/proj/sub"), relPath: "sub", name: "sub", branch: "feat", head: "ccccccc3",
    group: "k2", worktree: { role: "linked" }, prunable: "",
  };
  const merged = mergeRepoEntries({ rootEntry, scanHits: [scanZeta, scanSub], porcelainEntries: [porcelainSub] });
  assert.deepEqual(merged.map((x) => x.relPath), [".", "sub", "zeta"], "'.' 最前，其余按 relPath 排序");
  assert.equal(merged.find((x) => x.relPath === "sub").branch, "feat", "同键以 porcelain 字段为准");
  assert.equal(merged.length, 3, "同路径必须去重");

  assert.deepEqual(mergeRepoEntries({}), [], "空组丢弃");
  assert.deepEqual(mergeRepoEntries({ scanHits: [null, undefined] }), []);
});

// ── listRepos 纯函数：扫描器（真实文件系统）────────────────────────────────

describe("scanRepoDirs 扫描器", () => {
  let root;
  let linkCreated = false;

  before(async () => {
    // 归一化为长名基准，避免 8.3 短名让路径比较形态不一致
    root = await realpath(await mkdtemp(join(tmpdir(), "dsh-scan-")));
    /** 造目录；gitKind：dir = .git 目录，file = .git 文件（linked worktree / submodule 形态） */
    const make = async (rel, gitKind) => {
      const dir = join(root, rel);
      await mkdir(dir, { recursive: true });
      if (gitKind === "dir") await mkdir(join(dir, ".git"), { recursive: true });
      if (gitKind === "file") await writeFile(join(dir, ".git"), "gitdir: /elsewhere\n");
    };
    await make("adir", "dir");                                   // 深度 1 命中
    await make("bfile", "file");                                 // 深度 1 命中（文件态）
    await make(join("c", "deep"), "dir");                        // 深度 2 孙目录命中
    await make("inner", "dir");                                  // 命中后不下探
    await make(join("inner", "nested-repo"), "dir");             // 内嵌仓库：不应被发现
    await make(join("node_modules", "pkg"), "dir");              // SKIP_DIRS
    await make(join(".hidden"), "dir");                          // 点目录
    await make(join("plain", "sub"), undefined);                 // 非仓库目录
    await writeFile(join(root, "readme.md"), "not a dir\n");     // 普通文件不计入目录条目
    try {
      await symlink(join(root, "adir"), join(root, "linkdir"), process.platform === "win32" ? "junction" : "dir");
      linkCreated = true;
    } catch {
      linkCreated = false; // 无权限平台：符号链接用例按平台中性方式跳过
    }
  });

  after(async () => {
    await rmRetry(root);
  });

  /** 命中路径 → 相对扫描根的正斜杠形态，排序后便于比较 */
  const relHits = (hits) => hits.map((h) => normalizeRepoPath(relative(root, h))).sort();

  test("子目录与孙目录命中；.git 文件与目录双态都算仓库", async () => {
    const result = await scanRepoDirs(root, 2, {});
    assert.deepEqual(relHits(result.hits), ["adir", "bfile", "c/deep", "inner"]);
    assert.equal(result.truncated, false);
    assert.equal(result.stopped, false);
    // 只统计真实目录条目：跳过的点目录 / SKIP_DIRS / 符号链接 / 普通文件都不计
    assert.equal(result.visited, 7);
  });

  test("跳过 SKIP_DIRS、点目录与普通文件", async () => {
    const result = await scanRepoDirs(root, 2, {});
    const rels = relHits(result.hits);
    assert.ok(!rels.some((p) => p.startsWith("node_modules")), "SKIP_DIRS 内的仓库不发现");
    assert.ok(!rels.some((p) => p.startsWith(".hidden")), "点目录不下探");
    assert.ok(!rels.includes("readme.md"));
  });

  test("跳过符号链接（Windows junction 同路径）", async (t) => {
    if (!linkCreated) {
      t.skip("本平台无法创建符号链接 / junction，跳过该断言");
      return;
    }
    const result = await scanRepoDirs(root, 2, {});
    assert.ok(!relHits(result.hits).includes("linkdir"), "符号链接不得被当作仓库命中");
  });

  test("命中仓库后不再下探其内部（内嵌仓库由 worktree list 通道发现）", async () => {
    const result = await scanRepoDirs(root, 4, {});
    const rels = relHits(result.hits);
    assert.ok(rels.includes("inner"));
    assert.ok(!rels.some((p) => p.startsWith("inner/")), "命中后不得再进入其内部");
  });

  test("depth=1 只扫直接子目录，depth=2 含孙目录", async () => {
    const depth1 = await scanRepoDirs(root, 1, {});
    assert.deepEqual(relHits(depth1.hits), ["adir", "bfile", "inner"]);
    const depth2 = await scanRepoDirs(root, 2, {});
    assert.deepEqual(relHits(depth2.hits), ["adir", "bfile", "c/deep", "inner"]);
  });

  test("注入 maxEntries 小上限：停止遍历并标记 truncated", async () => {
    const full = relHits((await scanRepoDirs(root, 2, {})).hits);
    const result = await scanRepoDirs(root, 2, { maxEntries: 2 });
    assert.equal(result.truncated, true);
    assert.equal(result.visited, 2, "达到上限即停，visited 不超过注入值");
    assert.equal(result.hits.length, 2);
    for (const hit of relHits(result.hits)) assert.ok(full.includes(hit), `${hit} 必须是完整结果中的子集`);
  });

  test("注入 shouldStop 外部中止钩子：标记 stopped 且不误报 truncated", async () => {
    let calls = 0;
    const result = await scanRepoDirs(root, 4, { shouldStop: () => (calls += 1) > 2 });
    assert.equal(result.stopped, true);
    assert.equal(result.truncated, false);
    assert.ok(result.hits.length >= 1);
    for (const hit of relHits(result.hits)) {
      assert.ok(["adir", "bfile", "c/deep", "inner"].includes(hit));
    }
  });
});

// ── listRepos 纯函数：目录上限只被候选目录消耗（判定顺序）──────────────────

describe("scanRepoDirs 目录上限判定顺序", () => {
  let base;

  before(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), "dsh-scan-limit-")));
    await mkdir(join(base, "link-target"), { recursive: true });

    // 夹具 A：候选目录名排在非候选之后——NTFS 按名序返回时「首个条目是点目录」
    const a = join(base, "non-candidate-first");
    await mkdir(join(a, ".a-dotdir"), { recursive: true });
    await writeFile(join(a, "a-file.txt"), "x\n");
    await mkdir(join(a, "z-repo", ".git"), { recursive: true });

    // 夹具 B：候选目录名排在非候选之前——非候选在候选之后才被遍历，
    // 旧实现（上限判定在过滤之前）会在这里误报 dirs 截断
    const b = join(base, "candidate-first");
    await mkdir(join(b, "a-repo", ".git"), { recursive: true });
    await writeFile(join(b, "z-file.txt"), "x\n");
    await mkdir(join(b, ".z-dotdir"), { recursive: true });

    // 符号链接同样是非候选（无法创建的平台退化为「文件 + 点目录」，断言不变）
    try {
      await symlink(join(base, "link-target"), join(a, "a-link"), process.platform === "win32" ? "junction" : "dir");
    } catch { /* 无权限平台：忽略 */ }
    try {
      await symlink(join(base, "link-target"), join(b, "z-link"), process.platform === "win32" ? "junction" : "dir");
    } catch { /* 无权限平台：忽略 */ }
  });

  after(async () => {
    await rmRetry(base);
  });

  test("maxEntries=1 且首个条目为非候选（点目录/文件/符号链接）：不触发 dirs 截断", async (t) => {
    const dir = join(base, "non-candidate-first");
    const items = await readdir(dir, { withFileTypes: true });
    assert.ok(items.length >= 1);
    if (items[0].name === "z-repo") {
      // 哈希序文件系统（如 ext4）不保证按名返回：语义断言仍成立，仅记录未覆盖「首条目」顺序
      t.diagnostic(`本机 readdir 首条目为 ${items[0].name}，本夹具未覆盖「非候选在前」的遍历顺序`);
    }
    const result = await scanRepoDirs(dir, 1, { maxEntries: 1 });
    assert.equal(result.truncated, false, "普通文件 / 点目录 / 符号链接不得消耗目录上限");
    assert.equal(result.visited, 1);
    assert.deepEqual(result.hits.map((h) => normalizeRepoPath(relative(dir, h))), ["z-repo"]);
  });

  test("maxEntries=1 且非候选条目排在候选之后：只有第二个候选目录才触发截断", async () => {
    const dir = join(base, "candidate-first");
    const result = await scanRepoDirs(dir, 1, { maxEntries: 1 });
    assert.equal(result.truncated, false, "非候选条目在候选之后被遍历时不得误报 dirs 截断");
    assert.equal(result.visited, 1);
    assert.deepEqual(result.hits.map((h) => normalizeRepoPath(relative(dir, h))), ["a-repo"]);
  });

  test("两个候选目录 + maxEntries=1：仍触发 dirs 截断（对照，证明上限未被削弱）", async () => {
    const dir = join(base, "two-candidates");
    await mkdir(join(dir, "r1", ".git"), { recursive: true });
    await mkdir(join(dir, "r2", ".git"), { recursive: true });
    const result = await scanRepoDirs(dir, 1, { maxEntries: 1 });
    assert.equal(result.truncated, true);
    assert.equal(result.visited, 1);
    assert.equal(result.hits.length, 1);
  });
});

// ── listRepos 入口：realpath 归一化（8.3 短名）─────────────────────────────

test("入口 realpath 归一化：8.3 短名根展开为长名基准（无法构造时跳过）", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-realpath-"));
  try {
    const long = await realpath(dir);
    if (normalizeRepoPath(dir) === normalizeRepoPath(long)) {
      t.skip(`本机临时目录已是长名形态（${dir}），无法构造 8.3 短名场景`);
      return;
    }
    // 短名形态特征：路径段内出现 `~数字`
    assert.match(dir, /~\d/, "预期临时目录包含 8.3 短名段");
    // fs/promises 的 realpath 必须把短名展开为长名（宿主入口依赖该行为做 in-root 判定）
    assert.equal(normalizeRepoPath(await realpath(dir)), normalizeRepoPath(long));
    // 归一化基准一致：长名形态下同一路径既是根本身，也不会被误判为根内子目录
    assert.equal(repoRelPath(long, long), ".");
    assert.equal(isInsideScanRoot(long, long), false);
  } finally {
    await rmRetry(dir);
  }
});
