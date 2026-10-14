/**
 * 最终产物断言：lib/client.js 的 Patch 18（多子仓切换器）标记，以及四条互斥红线。
 *
 * Run with: node --test test/bundle-assertions.test.js
 *
 * lib/client.js 是约 850KB 的已补丁权威产物（raw bundle 不在仓库内，无法整链重放），
 * 因此本文件只做「读取产物 + 正则计数」式断言，绝不整读：
 *
 * 1) 互斥红线（Patch 18 新增文本不得破坏既有补丁的计数约束）：
 *    - 完整 scoped 串 `@deepseek-ai/dsh-git-graph` 零出现（必须匹配完整串——
 *      bundle 内 `require("@deepseek-ai/dsh-client-ui-primitives")` 是合法前缀，
 *      用 `@deepseek-ai` 前缀匹配会假阳性）；
 *    - `primitives.IconBranchOutline16,` 零出现（BranchIcon 解析器回退能力保留）；
 *    - 除 `primitives.Button` 外没有其它 primitives 组件的 JSX 直引；
 *    - 裸 `props.useSessions` 计数 === 2（Patch 18 必须复用现有 sessionCwd 通道，
 *      不得新增第三处调用）。
 * 2) Patch 18 行为标记：仓库胶囊显示条件、listRepos 请求、双 effect 结构、
 *    新鲜度守卫、resetView、截断提示与失效徽标。
 * 3) scripts/patch-client.mjs 内的 Patch 18 段落与锚点校验。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const bundle = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
const patchScript = readFileSync(new URL("../scripts/patch-client.mjs", import.meta.url), "utf8");

/** 统计正则匹配次数（bundle 断言统一口径：计数而非整读比对）。 */
const countOf = (source, re) => (source.match(re) ?? []).length;

test("红线：完整 scoped 串 @deepseek-ai/dsh-git-graph 零出现（禁前缀匹配）", () => {
  assert.equal(countOf(bundle, /@deepseek-ai\/dsh-git-graph/g), 0,
    "bundle 内不得残留本仓库自身的 scoped 包名");
  // 防空断言：bundle 内确有合法的 `@deepseek-ai/` scoped require，
  // 证明这条红线不是靠「文件里根本没有 @deepseek-ai」侥幸通过。
  assert.ok(countOf(bundle, /@deepseek-ai\//g) >= 1,
    "预期 bundle 至少有一处合法的 @deepseek-ai scoped require");
});

test("红线：primitives.IconBranchOutline16, 零出现，且 BranchIcon 解析器仍在", () => {
  assert.equal(countOf(bundle, /primitives\.IconBranchOutline16\s*,/g), 0,
    "已移除的图标名不得作为 JSX 类型直传给 jsx()/jsxs()");
  // 解析器必须同时保留三个版本的候选导出，回退链不被 Patch 18 破坏
  assert.match(bundle, /const BranchIcon = primitives\.IconBranchOutline16\r?\n[\s\S]{0,200}?IconBranchOutlineRegular[\s\S]{0,200}?IconBranchOutlineMedium/,
    "BranchIcon 必须保留跨版本的解析回退链");
  assert.equal(countOf(bundle, /jsxs?\(BranchIcon,/g), 3,
    "三处分支图标渲染都必须走解析器");
});

test("红线：除 primitives.Button 外没有 primitives.X 的 JSX 直引", () => {
  const direct = [...bundle.matchAll(/jsxs?\(primitives\.([A-Za-z0-9_]+),/g)].map((m) => m[1]);
  assert.ok(direct.length > 0, "防空断言：应存在 primitives.Button 直引");
  assert.deepEqual([...new Set(direct)].sort(), ["Button"],
    "引用其它 primitives 组件前必须先补版本容忍的解析器");
});

test("红线：裸 props.useSessions 计数 === 2（Patch 18 未新增第三处调用）", () => {
  assert.equal(countOf(bundle, /props\.useSessions/g), 2,
    "多子仓切换器必须复用现有 sessionCwd 通道，不得新增独立的 sessions 订阅");
});

test("Patch 18：仓库胶囊与状态流关键标记齐全", () => {
  const markers = [
    ["仓库胶囊类名（复用分支胶囊样式族）", "dshGitRepo dshGitBranch dshGitBranchBtn"],
    ["胶囊显示条件（单仓且根即仓库时隐藏）", "repos.length > 0 && (repos.length > 1 || !rootIsRepo)"],
    ["listRepos 请求", 'gitCall("listRepos"'],
    ["选仓新鲜度守卫（tag === sessionCwd 才动作）", "reposTag !== sessionCwd"],
    ["选仓 effect 依赖 [sessionCwd, repos]", "[sessionCwd, repos]"],
    ["用户已手动选择标记", "repoPickedRef"],
    ["option 文案构造（name（branch）/ 位置消歧 / 游离 / 失效徽标）", "repoOptionText"],
    ["option 名称优先与位置消歧拼接", 'const tail = where !== disp ? " · " + where : "";'],
    ["option 根仓位置标记", 'const where = r.relPath === "." ? "根" : r.relPath;'],
    ["option detached 游离文案", 'const head = r.branch ? r.branch : "游离" + (r.head ? " " + r.head : "");'],
    ["手动切仓入口", "pickRepo(e.target.value)"],
    ["截断提示文案", "列表已截断"],
    ["prunable 失效徽标文案", "疑似失效"],
    ["会话根变化时清空 repos 与 tag", "setReposTag(\"\")"],
  ];
  for (const [label, marker] of markers) {
    assert.ok(bundle.includes(marker), `bundle 缺少标记：${label} —— ${marker}`);
  }
});

test("Patch 18：truncated 提示为禁用 option，不占 value、不影响选中", () => {
  assert.ok(bundle.includes('key: "truncated"'), "截断提示必须是独立的 option");
  assert.match(bundle, /key: "truncated"[\s\S]{0,120}?disabled: true/,
    "截断提示 option 必须 disabled");
});

test("Patch 18：resetView 清空右栏残留，并重置提交草稿与内联高度", () => {
  assert.equal(countOf(bundle, /const resetView = \(\) => \{/g), 1, "resetView 唯一定义");
  assert.match(
    bundle,
    /const resetView = \(\) => \{[\s\S]*?setMessage\(""\)[\s\S]*?msgRef\.current\.style\.height = "auto"/,
    "切仓必须清空提交说明草稿并重置受控 textarea 的内联高度",
  );
  // 有意保留的瞬时 UI 态不得被 resetView 顺手清掉（语义回归防线）
  assert.match(bundle, /有意保留：newBranchName \/ mergeTarget \/ confirmDelete \/ modal \/ historyH/,
    "resetView 的「有意保留」清单必须留在产物中");
});

test("红线：repoOptionText 已弃用 ◻（u25FB）字符（部分 Windows 字体渲染为豆腐块）", () => {
  assert.equal(countOf(bundle, /u25FB/g), 0,
    "detached 标记必须为「游离」文案，不再使用 ◻（决策 35）");
});

test("弹层配色：option 显式主题令牌色，双轨各 1 份（透明叠加层不得使弹层文字透明）", () => {
  // .dshGitBranchSelect 用 color:transparent 做透明叠加层，但原生 select 弹层的
  // 条目颜色继承 select 本身 → 弹层文字透明、白底不可见（验收发现：子仓看似「没扫出来」）。
  // 修复 = 追加 option 显式配色规则；bundle 与补丁脚本必须各含且仅含 1 份（决策 36）。
  const rule = ".dshGitBranchSelect option{color:var(--dsw-alias-label-primary);background-color:var(--dsw-alias-bg-base)}";
  const re = new RegExp(rule.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
  assert.equal(countOf(bundle, re), 1, "bundle 必须含且仅含 1 份 option 显式配色规则");
  assert.equal(countOf(patchScript, re), 1, "补丁脚本必须镜像同一 option 配色规则（双轨）");
});

test("风格统一：optgroup 显式配色 + 仓库胶囊 RepoIcon（决策 37）", () => {
  // optgroup 分组标签同样继承 select 透明色（弹层分组开头出现空白行），需独立显式配色。
  const og = ".dshGitBranchSelect optgroup{color:var(--dsw-alias-label-tertiary)";
  const ogRe = new RegExp(og.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
  assert.equal(countOf(bundle, ogRe), 1, "bundle 必须含 optgroup 显式配色规则");
  assert.equal(countOf(patchScript, ogRe), 1, "补丁脚本必须镜像 optgroup 配色规则（双轨）");
  // 仓库胶囊与分支胶囊结构统一：图标 + 名称 + 折叠符；RepoIcon 用内联 SVG（免疫图标改名）。
  assert.equal(countOf(bundle, /jsx\(RepoIcon, \{ size: 14 \}\),/g), 1, "仓库胶囊必须前置 RepoIcon");
  assert.equal(countOf(patchScript, /jsx\(RepoIcon, \{ size: 14 \}\),/g), 1, "补丁脚本必须镜像胶囊图标（双轨）");
  assert.equal(countOf(bundle, /const RepoIcon = \(\{ size \}\) => jsx\("svg"/g), 1, "RepoIcon 内联 SVG 定义必须在产物中");
});

test("patch-client.mjs：Patch 18 段落存在且含锚点校验", () => {
  assert.match(patchScript, /\/\/ Patch 18: multi-repo switcher/, "补丁脚本必须记录 Patch 18");
  assert.ok(patchScript.includes('gitCall("listRepos"'), "补丁脚本必须包含 listRepos 调用文本");
  assert.ok(patchScript.includes("reposTag !== sessionCwd"), "补丁脚本必须包含新鲜度守卫文本");
  assert.ok(patchScript.includes("游离"), "补丁脚本必须包含 detached 游离文案（双轨同步）");
  assert.ok(patchScript.includes("const tail = where !== disp"), "补丁脚本必须包含位置消歧文本（双轨同步）");
  for (const guard of [
    "repo state anchor not found",
    "repo select ref anchor not found",
    "repo resetView anchor not found",
    "repo listRepos effect anchor not found",
    "repo pick effect anchor not found",
    "repo capsule anchor not found",
  ]) {
    assert.ok(patchScript.includes(guard), `补丁脚本缺少锚点唯一性校验：${guard}`);
  }
});

test("patch-client.mjs：Patch 18 新增文本不得引入第三处 props.useSessions", () => {
  const p18 = patchScript.slice(patchScript.indexOf("// Patch 18:"));
  assert.ok(p18.length > 0, "必须能定位 Patch 18 段落");
  assert.ok(!p18.includes("props.useSessions"),
    "Patch 18 不得新增 props.useSessions 调用（红线：裸计数必须保持 2）");
});
