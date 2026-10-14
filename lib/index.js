/**
 * dsh-git-graph — host half.
 *
 * A Cordis plugin that registers two HTTP JSON APIs on the app's `webServer`:
 *
 *   POST /git  — run `git` in a directory: status / staged / branches /
 *                switchBranch / switchTag / newBranch / deleteBranch / renameBranch /
 *                merge / diff / stage / unstage / discard / remove / log /
 *                graphLog / fileLog / blame / catFile / commit / amend /
 *                show / showStat / showFiles / showFileDiff / push / pull /
 *                fetch / remotes / tags / conflicts.
 *   POST /fs   — workspace file browser: tree / read / write, with a
 *                path-escape guard that keeps every operation inside the
 *                resolved root.
 *
 * The browser half (this package's `exports["./client"]`) renders the Git tab
 * and the File-browser tab and calls these two endpoints.
 *
 * The module has no side effects on import: it only defines functions and the
 * helper exports below, so it can be imported directly by tests without a
 * running Cordis context.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { rm, readdir, readFile, writeFile, stat, lstat, mkdir, realpath } from "node:fs/promises";
import { resolve, join, relative, basename, extname, dirname, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

/** Cordis plugin name — matches the `id` in cordis.patch.yml. */
export const name = "git-graph";
/** The webserver service owns the HTTP routes we register. */
export const inject = ["webServer"];

/** This package's own root — the repository that ships the plugin. */
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Is `dir` this plugin's own source tree?
 *
 * The Git panel can be pointed at the very repository that ships the plugin
 * (self-hosting): switching a ref there rewrites the plugin's own files, so the
 * browser half warns before a tag checkout. Both sides are resolved through
 * `realpath` because the profile installs the package as a symlink.
 */
let pluginRootReal;
async function isSelfRepo(dir) {
  try {
    pluginRootReal ??= await realpath(PLUGIN_ROOT);
    return (await realpath(dir)) === pluginRootReal;
  } catch {
    return false;
  }
}

const MAX_BODY_BYTES = 1_000_000;
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;
/** Cap a single diff payload so a huge hunk cannot freeze transport / parse. */
const MAX_DIFF_BYTES = 2_000_000;

export function ok(value) {
  return { ok: true, value };
}

export function fail(code, message, extra) {
  return { ok: false, error: { code, message, ...(extra ?? {}) } };
}

/** Run one git command; on non-zero exit resolve (not reject) with the output. */
async function git(cwd, args, opts = {}) {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: MAX_BUFFER_BYTES,
      encoding: "utf8",
      timeout: opts.timeoutMs ?? 60_000,
      env: { ...process.env },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return {
      code: typeof error.code === "number" ? error.code : 1,
      stdout: typeof error.stdout === "string" ? error.stdout : "",
      stderr: typeof error.stderr === "string" ? error.stderr : String(error?.message ?? error),
    };
  }
}

function requirePath(payload) {
  if (typeof payload?.path !== "string" || payload.path.length === 0) {
    throw new Error("payload.path must be a non-empty string");
  }
  return payload.path;
}

function requireString(payload, key) {
  const v = typeof payload?.[key] === "string" ? payload[key].trim() : "";
  if (v.length === 0) throw new Error(`payload.${key} must be a non-empty string`);
  return v;
}

/**
 * Parse a porcelain line keeping the two status columns distinct:
 * `XY path` where X = index (staged) status, Y = worktree status.
 * Returns `{ code, staged, worktree, path, original }`.
 */
export function parsePorcelainLine(line) {
  const xy = line.slice(0, 2);
  const x = xy[0] === " " ? "" : xy[0];
  const y = xy[1] === " " ? "" : xy[1];
  let path = line.slice(3).trim();
  let original = "";
  const arrow = path.indexOf(" -> ");
  if (arrow !== -1) {
    original = path.slice(0, arrow).trim();
    path = path.slice(arrow + 4).trim();
  }
  const code = x + y;
  const staged = x !== "" && x !== "?";
  return { code, staged, worktree: y, path, original };
}

/** Unquote a git path shown inside double quotes (`R  "a b" -> "c d"`). */
function unquoteGitPath(p) {
  return p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\") : p;
}

/**
 * Parse a porcelain rename with quoted paths (`XY old -> new`).
 */
export function parsePorcelainRename(line) {
  const xy = line.slice(0, 2);
  const x = xy[0] === " " ? "" : xy[0];
  const y = xy[1] === " " ? "" : xy[1];
  const rest = line.slice(3).trim();
  const m = rest.match(/^(.*?) -> (.*)$/);
  if (!m) return { code: x + y, path: rest, original: "", staged: x !== "" && x !== "?" };
  return {
    code: x + y,
    original: unquoteGitPath(m[1].trim()),
    path: unquoteGitPath(m[2].trim()),
    staged: x !== "" && x !== "?",
  };
}

/**
 * Split a porcelain list into staged / unstaged / untracked, with rename handling.
 */
export function splitPorcelain(stdout) {
  const staged = [];
  const unstaged = [];
  const untracked = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    if (line.startsWith("## ")) continue;
    if (line.includes(" -> ")) {
      const r = parsePorcelainRename(line);
      if (r.code === "R" || r.code === "C") {
        if (r.staged) staged.push({ ...r, status: r.code });
        else unstaged.push({ ...r, status: r.code });
        continue;
      }
    }
    const p = parsePorcelainLine(line);
    if (p.code === "??") untracked.push({ path: p.path, status: p.code, staged: false, original: p.original });
    else if (p.staged) staged.push({ path: p.path, status: p.code, staged: true, original: p.original });
    else unstaged.push({ path: p.path, status: p.code, staged: false, original: p.original });
  }
  return { staged, unstaged, untracked };
}

/**
 * Parse the `git status --porcelain=v1 -b` branch header line, e.g.
 * `## main...origin/main [ahead 1, behind 2]` or `## No commits yet on main`.
 */
export function parseBranchHeader(header) {
  const h = header.startsWith("## ") ? header.slice(3) : header;
  if (h.startsWith("No commits yet on ")) {
    return { branch: h.slice("No commits yet on ".length), upstream: "", ahead: 0, behind: 0 };
  }
  let rest = h;
  let ahead = 0;
  let behind = 0;
  const track = h.match(/^(.*?)\s+\[(.*)\]$/);
  if (track) {
    rest = track[1];
    const am = track[2].match(/ahead (\d+)/);
    const bm = track[2].match(/behind (\d+)/);
    if (am) ahead = parseInt(am[1], 10);
    if (bm) behind = parseInt(bm[1], 10);
  }
  const parts = rest.split("...");
  return {
    branch: parts[0].trim(),
    upstream: parts.length > 1 ? parts[1].trim() : "",
    ahead,
    behind,
  };
}

/**
 * Resolve `target` against `root`, rejecting any path that escapes the root.
 */
export function safePath(root, target) {
  const rel = relative(resolve(root), resolve(target));
  if (rel === "") return resolve(target);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("path is outside the workspace root");
  return resolve(target);
}

// ── /git op: listRepos —— 会话工作目录下的子代码库发现 ─────────────────────

/**
 * listRepos 的防护上限（对齐现有 MAX_* 常量风格）。
 *
 * 请求体可经 `limits` 注入更小的值，供单测用小上限触发截断（无需造 50 个真实仓库）；
 * 注入值**只能收紧不能放大**，保证「repos ≤ 50 / 目录 ≤ 5000 / 整体 ≤ 10s」的对外契约
 * 不会被请求参数绕过。
 */
const LISTREPOS_LIMITS = {
  /** repos 条目上限：超出后按 relPath 排序取前 N */
  maxRepos: 50,
  /** 遍历到的目录条目上限：超出后停止遍历 */
  maxEntries: 5000,
  /** 整体超时（毫秒）：外层计时，超时返回已累积的部分结果 */
  timeoutMs: 10_000,
  /** depth 缺省值与钳制区间 */
  defaultDepth: 2,
  minDepth: 1,
  maxDepth: 4,
};

/**
 * 注入式上限取整：非法值（缺失 / 非数值 / 非整数 / ≤0）落回默认值；
 * 合法值只允许收紧到 [1, max] 区间内。
 */
function pickLimit(value, fallback, max) {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return fallback;
  return Math.max(1, Math.min(max, value));
}

/**
 * 路径归一化：统一正斜杠并去掉末尾分隔符，用于比较 / 去重 / 归组键。
 *
 * 只统一分隔符形态，不做大小写折叠（Windows 大小写差异由入口 realpath 归一化兜住）。
 * 驱动器根（`C:/`）保留末尾斜杠，避免被归一成非法的 `C:`。
 *
 * @param {string} p 任意路径
 * @returns {string} 正斜杠形态、无末尾分隔符的路径
 */
export function normalizeRepoPath(p) {
  const slashed = String(p ?? "").replace(/\\/g, "/");
  const trimmed = slashed.replace(/\/+$/, "");
  return /^[A-Za-z]:$/.test(trimmed) ? `${trimmed}/` : trimmed;
}

/**
 * 条目的相对扫描根路径（统一正斜杠）。根本身固定返回 "."。
 *
 * @param {string} root 已 realpath 归一化的扫描根
 * @param {string} repoPath 条目绝对路径
 */
export function repoRelPath(root, repoPath) {
  if (normalizeRepoPath(resolve(root)) === normalizeRepoPath(resolve(repoPath))) return ".";
  return normalizeRepoPath(relative(resolve(root), resolve(repoPath)));
}

/**
 * depth 语义：缺省 2；非法值（0 / 负数 / 非整数 / 非数值）一律落缺省；
 * 合法整数在 1–4 之外钳制到边界。
 */
export function normalizeScanDepth(value) {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return LISTREPOS_LIMITS.defaultDepth;
  return Math.min(LISTREPOS_LIMITS.maxDepth, Math.max(LISTREPOS_LIMITS.minDepth, value));
}

/**
 * 解析 `git worktree list --porcelain` 输出。
 *
 * 条目按 `worktree <path>` 行分块，空行与未知 annotation 行跳过（向前兼容新 git 版本）。
 * 容错：bare 条目没有 HEAD / branch 行，head / branch 落空串。
 *
 * @param {string} stdout porcelain 原始输出
 * @returns {Array<{path: string, head: string, branch: string, detached: boolean, bare: boolean, locked: string, prunable: string}>}
 */
export function parseWorktreePorcelain(stdout) {
  const entries = [];
  let current = null;
  for (const rawLine of String(stdout ?? "").split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.startsWith("worktree ")) {
      if (current !== null) entries.push(current);
      current = { path: line.slice("worktree ".length).trim(), head: "", branch: "", detached: false, bare: false, locked: "", prunable: "" };
      continue;
    }
    if (current === null) continue; // 首块之前的杂项直接忽略
    if (line === "") continue;
    if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length).trim();
      continue;
    }
    if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length).trim();
      // branch refs/heads/xxx → 短名；detached 时该行不存在
      current.branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
      continue;
    }
    if (line === "detached") {
      current.detached = true;
      continue;
    }
    if (line === "bare") {
      current.bare = true;
      continue;
    }
    if (line === "locked" || line.startsWith("locked ")) {
      current.locked = line.slice("locked".length).trim();
      continue;
    }
    if (line === "prunable" || line.startsWith("prunable ")) {
      current.prunable = line.slice("prunable".length).trim();
      continue;
    }
    // 未知 annotation：忽略
  }
  if (current !== null) entries.push(current);
  return entries;
}

/**
 * 归组键：`--git-common-dir` 原始输出在主仓根为 `.git`、主仓子目录为 `../.git`、
 * 仅 linked worktree 为绝对路径；直接拿原始输出当 key 会把同组拆成多组。
 * 统一按 `path.resolve(仓库路径, 原始输出)` 再正斜杠归一。
 */
export function worktreeGroupKey(repoPath, commonDirRaw) {
  const raw = String(commonDirRaw ?? "").trim() || ".";
  return normalizeRepoPath(resolve(repoPath, raw));
}

/**
 * worktree.role 判定：porcelain 不标注 main/linked。
 * 条目路径 resolve 后等于「归组键的父目录」者为 main，其余为 linked。
 * bare 主仓被过滤后组内只剩 linked 的场景下该规则仍成立（bare 仓路径 ≠ 键的父目录）。
 */
export function worktreeRole(entryPath, groupKey) {
  return normalizeRepoPath(resolve(entryPath)) === normalizeRepoPath(dirname(resolve(groupKey))) ? "main" : "linked";
}

/**
 * 过滤规则之一：条目是否位于扫描根之内，且不等于根本身。
 * 根本身由根探测通道产出，本通道剔除以免重复。
 */
export function isInsideScanRoot(entryPath, root) {
  const rel = relative(resolve(root), resolve(entryPath));
  if (rel === "") return false; // 根本身
  if (isAbsolute(rel)) return false;
  return !(rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith("../"));
}

/**
 * 过滤规则之一：条目是否落在归组键内部（等于键，或位于键目录之下）。
 *
 * submodule 从其工作目录执行 porcelain 时，唯一条目路径是 gitdir 位置
 * （`<主仓>/.git/modules/...`），恰落在键内部，由本条剔除；主仓 / linked / bare
 * 组的正常条目都不在键内，零误伤。
 */
export function isInsideGroupKey(entryPath, groupKey) {
  const p = normalizeRepoPath(resolve(entryPath));
  const key = normalizeRepoPath(resolve(groupKey));
  return p === key || p.startsWith(`${key}/`);
}

/**
 * 条目过滤（纯字符串部分）：非 bare、位于扫描根内且不等于根本身、不落在归组键内部。
 * 第 2 条「目录仍然存在」是异步检查，由调用方在此之前完成。
 */
export function filterWorktreeEntries(entries, { root, groupKey }) {
  return entries.filter((entry) =>
    entry !== null &&
    typeof entry.path === "string" &&
    entry.path.length > 0 &&
    entry.bare !== true &&
    isInsideScanRoot(entry.path, root) &&
    !isInsideGroupKey(entry.path, groupKey));
}

/**
 * 合流语义：根条目 ∪ 扫描命中 ∪ 过滤后 porcelain 条目。
 *
 * 以归一化路径为键去重，同键时以 porcelain 条目字段为准（扫描命中与 porcelain 条目
 * 通常同指一仓）；结果按 relPath 排序，保证 50 上限截断的确定性。
 * 「空组丢弃」是自然结果：组内成员全被过滤时不会有条目进入。
 *
 * @param {{rootEntry?: object|null, scanHits?: object[], porcelainEntries?: object[]}} acc
 */
export function mergeRepoEntries({ rootEntry = null, scanHits = [], porcelainEntries = [] } = {}) {
  const byPath = new Map();
  const put = (item, prefer) => {
    if (item === null || item === undefined) return;
    const key = normalizeRepoPath(item.path);
    if (!byPath.has(key)) {
      byPath.set(key, item);
      return;
    }
    if (prefer) byPath.set(key, item);
  };
  for (const item of scanHits) put(item, false);
  for (const item of porcelainEntries) put(item, true);
  put(rootEntry, false);
  return [...byPath.values()].sort((a, b) => a.relPath.localeCompare(b.relPath));
}

/** `.git` 存在即视为仓库（lstat 判定，文件态 = linked worktree / submodule，目录态 = 普通仓库） */
async function hasGitEntry(dir) {
  try {
    await lstat(join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

/** 目录仍然存在？（剔除手删后遗留的 worktree 注册项） */
async function dirExists(dir) {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/** `git rev-parse --git-common-dir` → 归组键；非仓库或失败返回 null */
async function readGroupKey(repoPath) {
  const result = await git(repoPath, ["rev-parse", "--git-common-dir"]);
  if (result.code !== 0) return null;
  const raw = result.stdout.trim();
  if (raw.length === 0) return null;
  return worktreeGroupKey(repoPath, raw);
}

/** 组内任一成员执行一次 `worktree list --porcelain`，即可得到该组全部成员 */
async function readGroupWorktrees(repoPath) {
  const result = await git(repoPath, ["worktree", "list", "--porcelain"]);
  if (result.code !== 0) return [];
  return parseWorktreePorcelain(result.stdout);
}

/**
 * porcelain 条目 → 响应条目。
 *
 * @param {object} entry parseWorktreePorcelain 的条目
 * @param {string} groupKey 归组键
 * @param {string} root 扫描根
 * @param {"main"|"linked"} [roleOverride] 覆盖 role（根条目固定 main）
 */
function porcelainRepoItem(entry, groupKey, root, roleOverride) {
  return {
    path: entry.path,
    relPath: repoRelPath(root, entry.path),
    name: basename(entry.path),
    branch: entry.branch ?? "",
    head: (entry.head ?? "").slice(0, 8),
    group: groupKey,
    worktree: { role: roleOverride ?? worktreeRole(entry.path, groupKey) },
    prunable: entry.prunable ?? "",
  };
}

/**
 * 无 porcelain 匹配的扫描命中直取字段（典型：submodule 工作目录——其组 porcelain
 * 唯一条目是 gitdir 位置，已被「不落在归组键内部」规则剔除，真实工作目录不在成员表中）。
 *
 * role 固定 linked（该工作目录 ≠ 归组键父目录）；branch 用 `rev-parse --abbrev-ref HEAD`
 * （detached → 空串），head 用 `rev-parse --short=8 HEAD`（恒有值），prunable 空串。
 */
async function directRepoItem(repoPath, groupKey, root, roleOverride = "linked") {
  const branchResult = await git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const rawBranch = branchResult.code === 0 ? branchResult.stdout.trim() : "";
  // 统一按 8 位短哈希返回：`--short` 会按 git 认为的最小唯一长度输出（实测常见 7 位），
  // 与响应契约要求的 8 位不一致，故显式请求 `--short=8`（语义为最小 8 位，海量对象
  // 前缀碰撞时 git 会自动延长）；旧版 git 不支持该参数时退回全长哈希截取前 8 位。
  let head = "";
  const shortResult = await git(repoPath, ["rev-parse", "--short=8", "HEAD"]);
  if (shortResult.code === 0) {
    head = shortResult.stdout.trim().slice(0, 8);
  } else {
    const fullResult = await git(repoPath, ["rev-parse", "HEAD"]);
    if (fullResult.code === 0) head = fullResult.stdout.trim().slice(0, 8);
  }
  return {
    path: repoPath,
    relPath: repoRelPath(root, repoPath),
    name: basename(repoPath),
    branch: rawBranch === "HEAD" ? "" : rawBranch,
    head,
    group: groupKey,
    worktree: { role: roleOverride },
    prunable: "",
  };
}

/**
 * 扫描 root 下的子 / 孙目录，寻找含 `.git` 的仓库（发现层）。
 *
 * - 跳过：`SKIP_DIRS`（复用现有集合）、一切点开头目录、符号链接（junction 在本机实测
 *   上报 isSymbolicLink=true，天然被本规则覆盖，故不额外做 reparse 检查）；
 * - 命中 `.git` 后**不再下探**其内部，内部成员交给 worktree list 通道；
 * - 目录条目计数达到上限即停止遍历，标记 truncated。
 *
 * @param {string} root 已 realpath 归一化的扫描根
 * @param {number} depth 扫描深度（1 = 仅直接子目录，2 = 子 + 孙）
 * @param {{maxEntries?: number, shouldStop?: () => boolean}} [opts] 注入式上限与外部中止钩子
 * @returns {Promise<{hits: string[], visited: number, truncated: boolean, stopped: boolean}>}
 */
export async function scanRepoDirs(root, depth, opts = {}) {
  const maxEntries = pickLimit(opts.maxEntries, LISTREPOS_LIMITS.maxEntries, LISTREPOS_LIMITS.maxEntries);
  const shouldStop = typeof opts.shouldStop === "function" ? opts.shouldStop : () => false;
  const hits = [];
  let visited = 0;
  let truncated = false;
  let stopped = false;

  async function walk(dir, level) {
    if (truncated || stopped || level > depth) return;
    let items;
    try {
      items = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // 权限不足 / 扫描期间被删除：跳过该目录
    }
    for (const item of items) {
      if (truncated || stopped) return;
      if (shouldStop()) {
        stopped = true;
        return;
      }
      if (item.name.startsWith(".")) continue;
      if (item.isSymbolicLink()) continue; // junction 亦落在此支
      if (!item.isDirectory()) continue;
      if (SKIP_DIRS.has(item.name)) continue;
      // 上限判定放在过滤之后：只有真正计入 visited 的候选目录才触发截断，
      // 避免文件 / 点目录 / 符号链接把上限提前耗尽、产生无实指的 dirs 截断。
      if (visited >= maxEntries) {
        truncated = true;
        return;
      }
      const full = join(dir, item.name);
      visited += 1;
      if (await hasGitEntry(full)) {
        hits.push(full);
        continue; // 命中后不下探
      }
      await walk(full, level + 1);
    }
  }

  await walk(root, 1);
  return { hits, visited, truncated, stopped };
}

const handlers = {
  /** Combined status: branch info + staged/unstaged/untracked split. */
  async status(payload) {
    const path = requirePath(payload);
    const short = await git(path, ["status", "--porcelain=v1", "-b", "--untracked-files=all"]);
    if (short.code !== 0) return fail("git-error", short.stderr || "git status failed");
    const lines = short.stdout.split("\n");
    const header = lines[0] ?? "";
    const branch = parseBranchHeader(header);
    const { staged, unstaged, untracked } = splitPorcelain(lines.slice(1).join("\n"));
    return ok({ ...branch, self: await isSelfRepo(path), staged, unstaged, untracked });
  },

  /** Staged-only status (index vs HEAD). */
  async staged(payload) {
    const path = requirePath(payload);
    const r = await git(path, ["diff", "--cached", "--name-status"]);
    if (r.code !== 0) return fail("git-error", r.stderr || "git diff --cached failed");
    const files = r.stdout.split("\n").filter(Boolean).map((line) => {
      const [status, ...rest] = line.split("\t");
      const name = rest.join("\t");
      const arrow = name.indexOf(" -> ");
      return arrow === -1
        ? { status, path: name, original: "" }
        : { status, path: name.slice(arrow + 4), original: name.slice(0, arrow) };
    });
    return ok({ files });
  },

  async branches(payload) {
    const path = requirePath(payload);
    const result = await git(path, [
      "for-each-ref",
      "--format=%(refname)%09%(HEAD)%09%(upstream:short)%09%(upstream:track)%09%(objectname:short)%09%(subject)",
      "refs/heads",
      "refs/remotes",
    ]);
    if (result.code !== 0) return fail("git-error", result.stderr || "git branch failed");
    const branches = result.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [ref, head, upstream, track, hash, ...subjectParts] = line.split("\t");
        const subject = subjectParts.join("\t");
        const remote = ref.startsWith("refs/remotes/");
        const name = remote ? ref.slice("refs/remotes/".length) : ref.slice("refs/heads/".length);
        let ahead = 0;
        let behind = 0;
        const am = track.match(/ahead (\d+)/);
        const bm = track.match(/behind (\d+)/);
        if (am) ahead = parseInt(am[1], 10);
        if (bm) behind = parseInt(bm[1], 10);
        return { name, current: head === "*", remote, upstream, ahead, behind, hash, subject };
      })
      .filter((b) => !b.name.endsWith("/HEAD"))
      .sort((a, b) =>
        (a.current ? -1 : 0) - (b.current ? -1 : 0) ||
        (a.remote ? 1 : 0) - (b.remote ? 1 : 0) ||
        a.name.localeCompare(b.name),
      );
    return ok({ branches });
  },

  async switchBranch(payload) {
    const path = requirePath(payload);
    const branchName = requireString(payload, "name");
    let result = await git(path, ["switch", branchName]);
    // A remote branch (origin/x) fails when local x already exists; retry the
    // short name so we switch to the local tracking branch instead.
    if (result.code !== 0 && branchName.includes("/")) {
      const short = branchName.slice(branchName.indexOf("/") + 1);
      if (short.length > 0) result = await git(path, ["switch", short]);
    }
    if (result.code !== 0) return fail("git-error", result.stderr || "git switch failed");
    return ok({ stdout: result.stdout, stderr: result.stderr });
  },

  /**
   * Switch to a tag (checks it out into a detached HEAD).
   *
   * `git switch` has no tag form of its own, so detach explicitly and address
   * the tag through `refs/tags/` — that keeps a tag whose name also exists as
   * a branch (or a remote branch) unambiguous. A dirty worktree that would be
   * overwritten makes git refuse, and the refusal is surfaced verbatim.
   */
  async switchTag(payload) {
    const path = requirePath(payload);
    const tagName = requireString(payload, "name");
    const result = await git(path, ["switch", "--detach", `refs/tags/${tagName}`]);
    if (result.code !== 0) return fail("git-error", result.stderr || "git switch --detach failed");
    return ok({ stdout: result.stdout, stderr: result.stderr });
  },

  /** Create a new branch (optionally from a base ref, optionally switch to it). */
  async newBranch(payload) {
    const path = requirePath(payload);
    const branchName = requireString(payload, "name");
    const base = typeof payload.base === "string" && payload.base.trim() ? payload.base.trim() : null;
    if (payload.switch === true) {
      // git branch lacks --switch on some versions; use git switch -c.
      const args = ["switch", "-c", branchName];
      if (base) args.push(base);
      const result = await git(path, args);
      if (result.code !== 0) return fail("git-error", result.stderr || "git switch -c failed");
      return ok({ stdout: result.stdout, stderr: result.stderr });
    }
    const args = ["branch", branchName];
    if (base) args.push(base);
    const result = await git(path, args);
    if (result.code !== 0) return fail("git-error", result.stderr || "git branch failed");
    return ok({ stdout: result.stdout, stderr: result.stderr });
  },

  /** Delete a branch (-d; pass force:true for -D). */
  async deleteBranch(payload) {
    const path = requirePath(payload);
    const branchName = requireString(payload, "name");
    if (branchName.includes("/")) return fail("no-remote", "不能删除远程分支；请用远端操作（push origin --delete）");
    const args = ["branch", payload.force === true ? "-D" : "-d", branchName];
    const result = await git(path, args);
    if (result.code !== 0) return fail("git-error", result.stderr || "git branch -d failed");
    return ok({ stdout: result.stdout, stderr: result.stderr });
  },

  /** Rename the current branch (or a named branch). */
  async renameBranch(payload) {
    const path = requirePath(payload);
    const newName = requireString(payload, "name");
    const oldName = typeof payload.oldName === "string" && payload.oldName.trim() ? payload.oldName.trim() : null;
    const args = ["branch", "-m"];
    if (oldName) args.push(oldName);
    args.push(newName);
    const result = await git(path, args);
    if (result.code !== 0) return fail("git-error", result.stderr || "git branch -m failed");
    return ok({ stdout: result.stdout, stderr: result.stderr });
  },

  /** Merge a branch into the current branch (optionally --no-ff). */
  async merge(payload) {
    const path = requirePath(payload);
    const branchName = requireString(payload, "name");
    const args = ["merge"];
    if (payload.noFf === true) args.push("--no-ff");
    args.push(branchName);
    const result = await git(path, args, { timeoutMs: 120_000 });
    if (result.code !== 0) return fail("git-error", result.stderr || "git merge failed", { conflicts: /conflict/i.test(result.stderr) });
    return ok({ stdout: result.stdout, stderr: result.stderr });
  },

  async diff(payload) {
    const path = requirePath(payload);
    const args = payload.staged ? ["diff", "--cached"] : ["diff"];
    if (typeof payload.file === "string" && payload.file.length > 0) {
      args.push("--", payload.file);
    }
    const result = await git(path, args);
    if (result.code !== 0) return fail("git-error", result.stderr || "git diff failed");
    // Cap the payload so a huge diff cannot freeze transport/parse on the
    // client (the UI renders diffs incrementally and shows the truncation).
    const truncated = Buffer.byteLength(result.stdout) > MAX_DIFF_BYTES;
    return ok({ text: truncated ? result.stdout.slice(0, MAX_DIFF_BYTES) : result.stdout, truncated });
  },

  /** Stage files (git add). Accepts one file or a list; "." stages all. */
  async stage(payload) {
    const path = requirePath(payload);
    const files = Array.isArray(payload.files) ? payload.files.filter((f) => typeof f === "string" && f.length > 0) : [];
    if (files.length === 0) return fail("no-files", "no files to stage");
    const result = await git(path, ["add", "--", ...files]);
    if (result.code !== 0) return fail("git-error", result.stderr || "git add failed");
    return ok({ stdout: result.stdout, stderr: result.stderr });
  },

  /** Unstage files (git restore --staged). Accepts one file or a list. */
  async unstage(payload) {
    const path = requirePath(payload);
    const files = Array.isArray(payload.files) ? payload.files.filter((f) => typeof f === "string" && f.length > 0) : [];
    if (files.length === 0) return fail("no-files", "no files to unstage");
    const result = await git(path, ["restore", "--staged", "--", ...files]);
    if (result.code !== 0) return fail("git-error", result.stderr || "git restore --staged failed");
    return ok({ stdout: result.stdout, stderr: result.stderr });
  },

  /** Discard working-tree changes for files (git restore). */
  async discard(payload) {
    const path = requirePath(payload);
    const files = Array.isArray(payload.files) ? payload.files.filter((f) => typeof f === "string" && f.length > 0) : [];
    if (files.length === 0) return fail("no-files", "no files to discard");
    const result = await git(path, ["restore", "--", ...files]);
    if (result.code !== 0) return fail("git-error", result.stderr || "git restore failed");
    return ok({ stdout: result.stdout, stderr: result.stderr });
  },

  /** Remove files from the working tree (physical delete; works for untracked too). */
  async remove(payload) {
    const path = requirePath(payload);
    const files = Array.isArray(payload.files) ? payload.files.filter((f) => typeof f === "string" && f.length > 0) : [];
    if (files.length === 0) return fail("no-files", "no files to remove");
    const root = resolve(path);
    for (const f of files) {
      const target = resolve(root, f);
      if (target !== root && !target.startsWith(root + sep)) {
        return fail("invalid-path", `移除路径越界：${f}`);
      }
      await rm(target, { recursive: true, force: true });
    }
    return ok({ stdout: `已移除 ${files.length} 个文件/目录` });
  },

  async log(payload) {
    const path = requirePath(payload);
    const n = Number.isInteger(payload.n) && payload.n > 0 ? payload.n : 30;
    const result = await git(path, ["log", `-n${n}`, "--oneline"]);
    if (result.code !== 0) return fail("git-error", result.stderr || "git log failed");
    const commits = result.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const space = line.indexOf(" ");
        return {
          hash: space === -1 ? line : line.slice(0, space),
          subject: space === -1 ? "" : line.slice(space + 1),
        };
      });
    return ok({ commits });
  },

  /** Graphical history (commit graph with branch lines). */
  async graphLog(payload) {
    const path = requirePath(payload);
    const n = Number.isInteger(payload.n) && payload.n > 0 ? payload.n : 100;
    // --all --date-order：所有分支按时间交错，前端按父子关系自行分列（Git Graph 风格）。
    // --exclude=refs/stash 必须写在 --all 之前：stash 也挂在 refs/ 下，否则 stash
    // 提交（含其 index 提交）会作为分支外的孤立节点出现在图里。
    const result = await git(path, [
      "log",
      `-n${n}`,
      "--exclude=refs/stash",
      "--all",
      "--date-order",
      "--date=format:%Y-%m-%d %H:%M",
      "--pretty=format:%H%x09%d%x09%an%x09%ad%x09%P%x09%s",
    ]);
    if (result.code !== 0) return fail("git-error", result.stderr || "git log failed");
    const rows = result.stdout.split("\n").filter(Boolean).map((line) => {
      const parts = line.split("\t");
      const hash = parts[0] ?? "";
      const refs = (parts[1] ?? "").trim();
      const author = parts[2] ?? "";
      const date = parts[3] ?? "";
      const parents = (parts[4] ?? "").trim().split(/\s+/).filter(Boolean);
      const subject = parts.slice(5).join("\t");
      return { hash, refs, author, date, subject, parents };
    });
    return ok({ rows });
  },

  /** Per-file history (git log -- <file>). */
  async fileLog(payload) {
    const path = requirePath(payload);
    const file = requireString(payload, "file");
    const n = Number.isInteger(payload.n) && payload.n > 0 ? payload.n : 30;
    const result = await git(path, [
      "log",
      `-n${n}`,
      "--date=format:%Y-%m-%d %H:%M",
      "--pretty=format:%h%x09%an%x09%ad%x09%s",
      "--",
      file,
    ]);
    if (result.code !== 0) return fail("git-error", result.stderr || "git log -- <file> failed");
    const commits = result.stdout.split("\n").filter(Boolean).map((line) => {
      const [hash, author, date, ...subjectParts] = line.split("\t");
      return { hash, author, date, subject: subjectParts.join("\t") };
    });
    return ok({ commits });
  },

  /** Blame for a file (git blame --line-porcelain). */
  async blame(payload) {
    const path = requirePath(payload);
    const file = requireString(payload, "file");
    const result = await git(path, ["blame", "--line-porcelain", "--", file]);
    if (result.code !== 0) return fail("git-error", result.stderr || "git blame failed");
    // --line-porcelain groups: header `<hash> <orig> <final>` then metadata
    // lines (author/summary/filename/...), then the content line(s) which
    // start with a tab. Collect the tab lines for each header group.
    const lines = [];
    const raw = result.stdout.split("\n");
    for (let i = 0; i < raw.length; i++) {
      const m = raw[i].match(/^([0-9a-f]{40})\s+(\d+)\s+(\d+)/);
      if (!m) continue;
      // skip metadata lines (non-tab) until we hit the content line(s)
      let j = i + 1;
      while (j < raw.length && !raw[j].startsWith("\t")) j++;
      const content = [];
      while (j < raw.length && raw[j].startsWith("\t")) {
        content.push(raw[j].slice(1));
        j++;
      }
      lines.push({ hash: m[1].slice(0, 8), originalLine: m[2], content: content.join("\n") });
      i = j - 1;
    }
    return ok({ file, lines });
  },

  /** Read file content at a ref (HEAD by default) or in the working tree. */
  async catFile(payload) {
    const path = requirePath(payload);
    const file = requireString(payload, "file");
    const ref = typeof payload.ref === "string" && payload.ref.trim() ? payload.ref.trim() : "HEAD";
    const inWorkingTree = payload.workingTree === true;
    if (inWorkingTree) {
      const full = join(path, file);
      try {
        const buf = await readFile(full);
        return ok({ file, ref: "working-tree", text: buf.toString("utf8") });
      } catch (error) {
        return fail("git-error", `无法读取工作区文件：${error?.message ?? String(error)}`);
      }
    }
    const result = await git(path, ["--no-pager", "show", `${ref}:${file}`]);
    if (result.code !== 0) return fail("git-error", result.stderr || "git show <ref>:<file> failed");
    return ok({ file, ref, text: result.stdout });
  },

  async commit(payload) {
    const path = requirePath(payload);
    const message = typeof payload.message === "string" ? payload.message.trim() : "";
    if (message.length === 0) return fail("no-message", "commit message is required");
    const files = Array.isArray(payload.files)
      ? payload.files.filter((f) => typeof f === "string" && f.length > 0)
      : [];
    if (files.length > 0) {
      // Commit exactly the selected files: reset the index, stage only those,
      // then commit. Untracked and deleted paths are covered by `git add --`.
      const reset = await git(path, ["reset", "-q"]);
      if (reset.code !== 0) return fail("git-error", reset.stderr || "git reset failed");
      const add = await git(path, ["add", "--", ...files]);
      if (add.code !== 0) return fail("git-error", add.stderr || "git add failed");
      const commit = await git(path, ["commit", "-m", message]);
      if (commit.code !== 0) return fail("git-error", commit.stderr || "git commit failed");
      return ok({ stdout: commit.stdout, stderr: commit.stderr });
    }
    const add = await git(path, ["add", "-A"]);
    if (add.code !== 0) return fail("git-error", add.stderr || "git add failed");
    const commit = await git(path, ["commit", "-m", message]);
    if (commit.code !== 0) {
      return fail("git-error", commit.stderr || "git commit failed");
    }
    return ok({ stdout: commit.stdout, stderr: commit.stderr });
  },

  /** Amend the last commit (keeps staged files staged; message optional). */
  async amend(payload) {
    const path = requirePath(payload);
    const args = ["commit", "--amend", "--no-edit"];
    const message = typeof payload.message === "string" ? payload.message.trim() : "";
    if (message.length > 0) args.push("-m", message);
    const result = await git(path, args);
    if (result.code !== 0) return fail("git-error", result.stderr || "git commit --amend failed");
    return ok({ stdout: result.stdout, stderr: result.stderr });
  },

  async show(payload) {
    const path = requirePath(payload);
    const hash = typeof payload.hash === "string" ? payload.hash.trim() : "";
    if (hash.length === 0) return fail("no-hash", "commit hash is required");
    const result = await git(path, ["show", "--format=fuller", "--patch", hash]);
    if (result.code !== 0) return fail("git-error", result.stderr || "git show failed");
    return ok({ text: result.stdout });
  },

  /** Show commit metadata + stat (for the history graph detail pane). */
  async showStat(payload) {
    const path = requirePath(payload);
    const hash = requireString(payload, "hash");
    const result = await git(path, [
      "show",
      "--format=commit %H%nAuthor: %an <%ae>%nDate:   %ad%n%n%s%n%n%b",
      "--date=iso",
      "--stat",
      "--patch",
      hash,
    ]);
    if (result.code !== 0) return fail("git-error", result.stderr || "git show failed");
    return ok({ text: result.stdout });
  },

  /** List files changed by a commit (SourceTree-style: pick a file, then show
   *  that file's diff). Parses `git show --name-status --format= <hash>`. */
  async showFiles(payload) {
    const path = requirePath(payload);
    const hash = requireString(payload, "hash");
    const result = await git(path, ["show", "--name-status", "--format=", hash]);
    if (result.code !== 0) return fail("git-error", result.stderr || "git show --name-status failed");
    const files = [];
    for (const line of result.stdout.split("\n")) {
      const m = line.match(/^([MADRCU])(\d+)?\t(.+?)(?:\t(.+))?$/);
      if (m) {
        // rename rows are "R<score>\t<old>\t<new>" — the new path is the file.
        files.push(m[1] === "R" ? { status: "R", path: m[4], original: m[3] } : { status: m[1], path: m[3], original: m[4] });
      }
    }
    return ok({ files });
  },

  /** Diff of ONE file inside a commit (`git show <hash> -- <file>`), capped so
   *  a huge single-file change cannot freeze the client (UI virtualizes). */
  async showFileDiff(payload) {
    const path = requirePath(payload);
    const hash = requireString(payload, "hash");
    const file = requireString(payload, "file");
    const result = await git(path, ["show", "--format=", hash, "--", file]);
    if (result.code !== 0) return fail("git-error", result.stderr || "git show failed");
    const truncated = Buffer.byteLength(result.stdout) > MAX_DIFF_BYTES;
    return ok({ text: truncated ? result.stdout.slice(0, MAX_DIFF_BYTES) : result.stdout, truncated });
  },

  async push(payload) {
    const path = requirePath(payload);
    const args = ["push"];
    const branch = typeof payload.branch === "string" && payload.branch.trim() ? payload.branch.trim() : null;
    if (payload.setUpstream === true && branch) args.push("-u");
    if (branch) args.push("origin", branch);
    const result = await git(path, args, { timeoutMs: 120_000 });
    if (result.code !== 0) return fail("git-error", result.stderr || "git push failed");
    return ok({ stdout: result.stdout, stderr: result.stderr });
  },

  async pull(payload) {
    const path = requirePath(payload);
    const args = ["pull", "--ff-only"];
    if (payload.rebase === true) args.splice(1, 0, "--rebase");
    const result = await git(path, args, { timeoutMs: 120_000 });
    if (result.code !== 0) return fail("git-error", result.stderr || "git pull failed");
    return ok({ stdout: result.stdout, stderr: result.stderr });
  },

  /** Fetch all remotes (optionally prune). */
  async fetch(payload) {
    const path = requirePath(payload);
    const args = ["fetch"];
    if (payload.prune === true) args.push("--prune");
    const result = await git(path, args, { timeoutMs: 120_000 });
    if (result.code !== 0) return fail("git-error", result.stderr || "git fetch failed");
    return ok({ stdout: result.stdout, stderr: result.stderr });
  },

  /** List remotes (name, fetch/push url, HEAD branch). */
  async remotes(payload) {
    const path = requirePath(payload);
    const r = await git(path, ["remote", "-v"]);
    if (r.code !== 0) return fail("git-error", r.stderr || "git remote failed");
    const seen = new Map();
    for (const line of r.stdout.split("\n").filter(Boolean)) {
      const m = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
      if (!m) continue;
      const [name, url, dir] = [m[1], m[2], m[3]];
      const entry = seen.get(name) ?? { name, fetchUrl: "", pushUrl: "" };
      if (dir === "fetch") entry.fetchUrl = url;
      else entry.pushUrl = url;
      seen.set(name, entry);
    }
    return ok({ remotes: [...seen.values()] });
  },

  /** List tags (name + short hash + subject). */
  async tags(payload) {
    const path = requirePath(payload);
    const r = await git(path, ["tag", "-n", "--format=%(refname:short)%09%(objectname:short)"]);
    if (r.code !== 0) return fail("git-error", r.stderr || "git tag failed");
    const tags = r.stdout.split("\n").filter(Boolean).map((line) => {
      const [name, hash] = line.split("\t");
      return { name, hash };
    });
    // Which tag is CHECKED OUT (the detached-HEAD state `switchTag` produces)?
    // Only meaningful while HEAD is detached: on a branch that merely happens to
    // sit on a tagged commit the answer would be misleading, so report "" there.
    // Both probes are non-error: a non-zero exit simply means "no".
    const attached = await git(path, ["symbolic-ref", "--short", "-q", "HEAD"]);
    let current = "";
    if (attached.code !== 0) {
      const exact = await git(path, ["describe", "--tags", "--exact-match", "HEAD"]);
      if (exact.code === 0) current = exact.stdout.trim();
    }
    return ok({ tags, current });
  },

  /** Merge conflicts present? Returns conflicting file paths (git diff --name-only --diff-filter=U). */
  async conflicts(payload) {
    const path = requirePath(payload);
    const r = await git(path, ["diff", "--name-only", "--diff-filter=U"]);
    if (r.code !== 0) return fail("git-error", r.stderr || "git diff --name-only failed");
    const files = r.stdout.split("\n").filter(Boolean);
    return ok({ files });
  },

  /**
   * 列出会话工作目录下的子代码库，作为客户端多仓切换器的数据源。
   *
   * 参数：path（必需，绝对路径）；depth（可选，缺省 2，非法落缺省、越界钳制 1–4）；
   *       limits（可选，注入式上限，只能收紧默认上限，供单测触发截断）。
   * 流程：入口 realpath 归一化 → 根探测 → 子/孙目录扫描 → 按组取 worktree 信息
   *       → 条目过滤与合流 → 排序、50 上限、整体超时。
   * 边界：realpath 失败（路径不存在）返回 invalid-path；整体超时**不 kill** 子进程，
   *       返回已累积的部分结果并置 truncated="timeout"。
   */
  async listRepos(payload) {
    let root;
    try {
      // 入口归一化必须走 fs/promises 的 realpath（libuv native 实现）：8.3 短名与
      // junction 都会展开为长名真实路径；同步 / 回调版是 JS 实现，不展开 8.3 短名，
      // 会让后续 in-root 与 role 判定全数失配。
      root = await realpath(requirePath(payload));
    } catch (error) {
      return fail("invalid-path", `cannot resolve path: ${error?.message ?? String(error)}`);
    }

    const injectedLimits = payload !== null && typeof payload === "object" && payload.limits !== null && typeof payload.limits === "object"
      ? payload.limits
      : {};
    const limits = {
      maxRepos: pickLimit(injectedLimits.maxRepos, LISTREPOS_LIMITS.maxRepos, LISTREPOS_LIMITS.maxRepos),
      maxEntries: pickLimit(injectedLimits.maxEntries, LISTREPOS_LIMITS.maxEntries, LISTREPOS_LIMITS.maxEntries),
      timeoutMs: Number.isInteger(injectedLimits.timeoutMs) && injectedLimits.timeoutMs >= 0
        ? Math.min(injectedLimits.timeoutMs, LISTREPOS_LIMITS.timeoutMs)
        : LISTREPOS_LIMITS.timeoutMs,
    };

    const rootIsRepo = await hasGitEntry(root);
    // 累积器：超时返回时保留已算出的部分结果（部分结果优于无结果）。
    const acc = { rootEntry: null, scanHits: [], porcelainEntries: [] };
    let timedOut = false;
    let dirsTruncated = false;
    let rootGroupKey = null;

    /** 排序、套 50 上限、汇总截断原因后产出响应 */
    const finalize = () => {
      const merged = mergeRepoEntries(acc);
      let repos = merged;
      let reposTruncated = false;
      if (repos.length > limits.maxRepos) {
        repos = repos.slice(0, limits.maxRepos); // mergeRepoEntries 已按 relPath 排序
        reposTruncated = true;
      }
      const reasons = [];
      if (reposTruncated) reasons.push("repos");
      if (dirsTruncated) reasons.push("dirs");
      return ok({ root, rootIsRepo, repos, truncated: timedOut ? "timeout" : reasons.join("+") });
    };

    const runPipeline = async () => {
      const scan = await scanRepoDirs(root, normalizeScanDepth(payload?.depth), {
        maxEntries: limits.maxEntries,
        shouldStop: () => timedOut,
      });
      dirsTruncated = scan.truncated;
      if (timedOut) return;

      // 候选仓库：根本身（若为仓库，由根探测通道产出）+ 扫描命中。
      const candidates = rootIsRepo ? [root, ...scan.hits] : [...scan.hits];

      // 每个候选仓库取归组键（并行）；同一组只保留一份成员表。
      const grouped = new Map();
      await Promise.all(candidates.map(async (repoPath) => {
        const key = await readGroupKey(repoPath);
        if (key === null) return; // 非仓库 / rev-parse 失败：跳过该候选
        if (rootIsRepo && normalizeRepoPath(repoPath) === normalizeRepoPath(root)) rootGroupKey = key;
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(repoPath);
      }));
      if (timedOut) return;

      // 逐组执行一次 worktree list（组内全部成员的 branch / head / bare / prunable 一次取全）。
      for (const [key, members] of grouped) {
        if (timedOut) return;
        const raw = await readGroupWorktrees(members[0]);
        // 非 bare / 位于根内且非根本身 / 不落在归组键内部为纯字符串规则，
        // 「目录仍然存在」需异步检查。
        const inRoot = filterWorktreeEntries(raw, { root, groupKey: key });
        const alive = [];
        for (const entry of inRoot) {
          if (timedOut) return;
          if (await dirExists(entry.path)) alive.push(entry);
        }
        for (const entry of alive) {
          acc.porcelainEntries.push(porcelainRepoItem(entry, key, root));
        }
        // 扫描命中但 porcelain 未覆盖（典型：submodule 工作目录）→ 直取字段补条目。
        for (const member of members) {
          if (timedOut) return;
          const memberKey = normalizeRepoPath(member);
          if (rootIsRepo && memberKey === normalizeRepoPath(root)) continue; // 根条目单独构造
          if (alive.some((entry) => normalizeRepoPath(entry.path) === memberKey)) continue; // 已由 porcelain 覆盖
          acc.scanHits.push(await directRepoItem(member, key, root));
        }
        // 根条目：role 固定 "main"（根即用户主工作面，即使根本身是 linked worktree）；
        // branch / head 优先取 porcelain 中匹配根本身的条目。
        if (rootIsRepo && rootGroupKey === key) {
          const matched = raw.find((entry) => normalizeRepoPath(entry.path) === normalizeRepoPath(root));
          acc.rootEntry = matched === undefined
            ? await directRepoItem(root, key, root, "main")
            : porcelainRepoItem(matched, key, root, "main");
          acc.rootEntry.path = root;
          acc.rootEntry.relPath = ".";
        }
      }
    };

    let timerHandle = null;
    const timeoutSignal = new Promise((resolveTimeout) => {
      timerHandle = setTimeout(() => {
        timedOut = true;
        resolveTimeout("timeout");
      }, limits.timeoutMs);
      timerHandle.unref?.(); // 不因计时器把进程钉住
    });
    const pipeline = runPipeline();
    const raced = await Promise.race([pipeline.then(() => "done", () => "done"), timeoutSignal]);
    if (timerHandle !== null) clearTimeout(timerHandle);
    if (raced === "timeout") {
      // 超时不 kill 子进程：在跑的 rev-parse / worktree list 按各自 60s 上限自行收敛，
      // 迟到结果丢弃（响应已返回）。
      pipeline.catch(() => {});
    }
    return finalize();
  },
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let body = "";
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      body += chunk.toString();
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function handler(req, res) {
  if (req.method !== "POST") {
    res.writeHead(405, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(fail("method", "POST required")));
    return;
  }
  let body;
  try {
    body = await readBody(req);
  } catch (error) {
    res.writeHead(413, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(fail("body", error.message)));
    return;
  }
  let payload;
  try {
    payload = JSON.parse(body || "{}");
  } catch {
    res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(fail("bad-json", "invalid JSON body")));
    return;
  }
  const fn = typeof payload.op === "string" ? handlers[payload.op] : undefined;
  if (fn === undefined) {
    res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(fail("bad-op", `unknown op ${JSON.stringify(payload.op)}`)));
    return;
  }
  let result;
  try {
    result = await fn(payload);
  } catch (error) {
    result = fail("internal", error?.message ?? String(error));
  }
  res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(result));
}

// ── /fs: workspace file browser / editor API ─────────────────────────────
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".avif", ".svg"]);
const IMAGE_MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp", ".ico": "image/x-icon", ".avif": "image/avif", ".svg": "image/svg+xml" };
const SKIP_DIRS = new Set(["node_modules", ".git", ".dsh", ".dsh-vision-router", ".DS_Store"]);
/** Cap a text file handed to the browser editor so a giant file cannot freeze
 *  the client's syntax highlighter (the client degrades it instead). */
const MAX_FS_READ_BYTES = 1_000_000;
/** Larger cap for inline image preview (base64). */
const MAX_IMAGE_BYTES = 8_000_000;

async function fsTree(payload) {
  const root = resolve(typeof payload.root === "string" && payload.root ? payload.root : process.cwd());
  const files = [];
  async function walk(dir, depth) {
    if (depth > 10) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (a.isDirectory() ? 0 : 1) - (b.isDirectory() ? 0 : 1) || a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.name.startsWith(".") && e.name !== ".gitignore") continue;
      if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        files.push({ name: e.name, path: full, type: "dir" });
        await walk(full, depth + 1);
      } else if (e.isFile()) {
        let size = 0;
        try { size = (await stat(full)).size; } catch {}
        files.push({ name: e.name, path: full, type: "file", size });
      }
    }
  }
  await walk(root, 0);
  return ok({ root, files });
}

async function fsRead(payload) {
  const root = resolve(typeof payload.root === "string" && payload.root ? payload.root : process.cwd());
  let file;
  try {
    file = safePath(root, requireString(payload, "path"));
  } catch (error) {
    return fail("invalid-path", error?.message ?? String(error));
  }
  const ext = extname(file).toLowerCase();
  const isImage = IMAGE_EXT.has(ext);
  let size;
  try {
    size = (await stat(file)).size;
  } catch (error) {
    return fail("fs-error", error?.message || String(error));
  }
  // A file beyond the preview cap is not shipped at all; the client shows a
  // "cannot preview" pane instead of trying to render/highlight a monster.
  if (size > (isImage ? MAX_IMAGE_BYTES : MAX_FS_READ_BYTES)) {
    return ok({ type: "binary", size });
  }
  try {
    const buf = await readFile(file);
    if (isImage) {
      return ok({ type: "image", mediaType: IMAGE_MIME[ext] || "image/png", base64: buf.toString("base64") });
    }
    const text = buf.toString("utf8");
    if (/\uFFFD/.test(text.slice(0, 8192))) {
      return ok({ type: "binary", size: buf.length });
    }
    return ok({ type: "text", text });
  } catch (error) {
    return fail("fs-error", error?.message || String(error));
  }
}

async function fsWrite(payload) {
  const root = resolve(typeof payload.root === "string" && payload.root ? payload.root : process.cwd());
  let file;
  try {
    file = safePath(root, requireString(payload, "path"));
  } catch (error) {
    return fail("invalid-path", error?.message ?? String(error));
  }
  const content = typeof payload.content === "string" ? payload.content : "";
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content, "utf8");
    return ok({ written: file });
  } catch (error) {
    return fail("fs-error", error?.message || String(error));
  }
}

const fsHandlers = { tree: fsTree, read: fsRead, write: fsWrite };

async function fsHandler(req, res) {
  if (req.method !== "POST") {
    res.writeHead(405, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(fail("method", "POST required")));
    return;
  }
  let body;
  try { body = await readBody(req); } catch (error) {
    res.writeHead(413, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(fail("body", error.message)));
    return;
  }
  let payload;
  try { payload = JSON.parse(body || "{}"); } catch {
    res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(fail("bad-json", "invalid JSON body")));
    return;
  }
  const fn = typeof payload.op === "string" ? fsHandlers[payload.op] : undefined;
  if (fn === undefined) {
    res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(fail("bad-op", "unknown fs op " + JSON.stringify(payload.op))));
    return;
  }
  let result;
  try { result = await fn(payload); } catch (error) { result = fail("internal", error?.message ?? String(error)); }
  res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(result));
}

/**
 * Register the two routes on the app's `webServer`. Both are registered inside
 * the effect callback so they are torn down together when the plugin is
 * stopped, updated, or removed.
 *
 * The desktop app ships a built-in git viewer that registers the SAME `/git`
 * and `/fs` exact routes; `webServer.register` throws on a duplicate
 * (kind, path). When another plugin already owns one of these routes we skip
 * gracefully instead of crashing the layer — the client half keeps working
 * against the existing routes (they are the same API).
 */
export function apply(ctx) {
  ctx.effect(
    () => {
      const disposers = [];
      // File-browser (/fs) is disabled for now (Git only): the fs* handlers
      // below stay in this module for a later re-enable, but are not wired.
      const routes = [
        ["/git", handler],
      ];
      for (const [path, routeHandler] of routes) {
        try {
          const off = ctx.webServer.register({ kind: "exact", path, handler: routeHandler });
          if (typeof off === "function") disposers.push(off);
        } catch (error) {
          // Route already owned by another plugin; release what we took and
          // become a no-op host (do not throw — a throw during apply would
          // break the layer / panel state).
          for (const off of disposers) {
            if (typeof off === "function") {
              try { off(); } catch { /* already gone */ }
            }
          }
          return () => {};
        }
      }
      return () => {
        for (const off of disposers) {
          if (typeof off === "function") off();
        }
      };
    },
    "dsh-git-graph: /git + /fs routes",
  );
}
