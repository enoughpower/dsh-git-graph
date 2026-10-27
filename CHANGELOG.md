# 更新说明（CHANGELOG）

## 0.1.9（2026-10-27）

- **修复：Git 面板中非 ASCII 文件名显示为八进制转义**。`git status --porcelain` 默认
  （`core.quotepath=true`）会把中文等非 ASCII 路径 C 风格转义成 `"\346\265\213..."`，面板既显示不出
  真实文件名，暂存/取消暂存时还会把这个转义串原样传回 git。现在所有 git 命令都以
  `-c core.quotepath=false` 运行，并在 porcelain 解析器里解码 git 的 C 风格引号（八进制 UTF-8 字节
  以及 `\a \b \f \n \r \t \v \\ \"`），即使用户显式开启 `core.quotepath` 也能正确显示。
- 测试：新增八进制 / 引号 / 反斜杠解码单测，以及「中文文件名经过 status → stage → staged」的集成测试。

## 0.1.8（2026-10-14）

- **新增：发现并切换子代码库（nested repos）**。Git 面板会扫描当前会话工作目录下的子/孙目录
  （depth 默认 2，钳制在 1–4），把发现的仓库列进顶部新增的「仓库」下拉；分组展示 linked worktree、
  过滤 submodule 的 ghost 条目，并对仓库数（≤50）、目录条目数（≤5000）、整体耗时（≤10s）设上限。
  当会话根目录本身不是仓库时，自动进入第一个子仓库；选项采用「名称优先 + 位置消歧」，并标注
  detached HEAD 与 prunable worktree、以及列表截断提示。宿主侧新增 `listRepos` op。
- 顶栏胶囊结构统一：仓库胶囊与分支胶囊共用样式；仓库图标改为内联 SVG，不再依赖 primitives 图标导出，
  避免 dsh 改名时整页崩溃。修复原生 `<select>` 弹层在透明叠加层下继承颜色导致的「白底白字」、
  optgroup 标签空白问题。
- 测试：修复 macOS 上 8.3 短名用例的跳过判定（`/var` → `/private/var` 是符号链接，会被误判为短名），
  现按路径是否含 `~数字` 段决定是否跳过；本机 80 pass / 0 fail / 1 skip。

## 0.1.7（2026-09-22）

- **提交图不再显示 stash 节点**。`graphLog` 使用 `git log --all`，而 stash 也挂在 `refs/` 下
  （`refs/stash`），因此 stash 提交和它的 index 提交会作为分支外的孤立节点出现在图里。现在在
  `--all` 之前加 `--exclude=refs/stash`，图只保留分支 / 远程分支 / 标签可达的提交。
- 新增集成测试：建一个带 stash 的临时仓库，断言 `graphLog` 结果里既保留分支提交、又不含 stash 提交。
- 注意：这是宿主半的改动，需要重启 `dsh web`（或安装 0.1.7）后生效；只刷新页面不会重载宿主插件。

## 0.1.6（2026-09-22）

- **修复：dsh 0.1.7-alpha.1 下 Git 页签整页崩溃（“读取不到目录”的真正原因）**。该版本把分支图标导出由
  `IconBranchOutline16` 改名为 `IconBranchOutlineRegular` / `IconBranchOutlineMedium`，插件直接渲染了被删除的
  `primitives.IconBranchOutline16`，于是 React 收到 undefined 元素类型抛出 #130，整个 `conversation.view`
  被错误边界替换成空白。现改为运行时按存在的导出回退解析（`IconBranchOutline16 → Regular → Medium → 空组件`），
  新旧 dsh 均可渲染。
- 新增回归测试 `test/primitives-compat.test.js`：分别用 0.1.6 / 0.1.7 / 未来无该导出的三种 primitives 形状断言
  图标解析，并扫描构建产物确保没有把被删除的 primitive 直接当作 JSX 类型使用。
- 说明：0.1.5 的会话 `cwd` 修复（`props.sessionId`）仍然有效，本次崩溃掩盖了它。

## 0.1.5（2026-09-18）

- **修复：dsh 0.1.6-alpha.2 下 Git 面板读不到当前目录**。该版本从会话列表 store
  （`useSessions` / `SessionListState`）移除了 `current` 字段，而插件原先靠 `s.current` 取当前会话的
  `cwd`，取值恒为空，面板因此找不到仓库。现改为优先读取 `conversation.view` 槽位提供的 `sessionId`
  （`s.byId[sessionId]?.cwd`），并保留 `s.current` 作为旧运行时回退；Git 视图与文件视图里的同一段
  选择器一起修正。
- 新增回归测试 `test/client-cwd.test.js`：从构建产物中提取选择器，分别在 0.1.6-alpha.2 与旧版 store
  形状下断言 cwd 解析。

## 0.1.4（2026-09-14）

- **新增：分支 / 标签统一下拉**：顶栏的分支胶囊改为一个下拉框，用 `<optgroup>` 分组列出「本地分支 / 远程分支 /
  标签」；选项值带 `branch:` / `tag:` 前缀（分支与标签可能同名），据此分别调用 `switchBranch` 或新增的
  `switchTag`（`git switch --detach refs/tags/<name>`，检出为 detached HEAD）。
- `tags` op 现在额外返回 `current`（当前检出的标签，仅在 detached HEAD 时非空），胶囊据此回显当前 ref
  （在标签上时显示标签名，而不是 `HEAD (no branch)`）。
- **自举保护**：`status` 新增 `self` 字段（该目录是否就是插件自身的源码树）。当面板指向插件自己的仓库时，
  从下拉框选标签会先弹确认（提示会替换正在运行的插件前端代码）——此前直接检出 `v0.1.1` 会让插件实时退回旧
  版本，表现为分支按钮弹出旧的页内菜单；选分支不拦截，保证能一键切回。

## 0.1.3（2026-09-03）

- **移动端适配（Git 视图）**：窄屏下面板自动单列堆叠、历史区固定约 5 行（178px）、底部提交栏由「挤压状态卡」改为堆叠布局、预留底部安全区（修复根节点与提交栏安全区内边距被重复叠加的问题）。
- **原生分支选择器**：统一桌面与移动端——点击分支胶囊调用 `showPicker()` 打开原生 `<select>`（隐藏的原生 select 覆盖层，而非叠加自绘胶囊）；修复 `branchSelectRef` 声明在 `DiffView` 导致的白屏；长分支名完整显示（不再截断）。
- **交互与兼容**：`patch-client.mjs` 作为权威构建产物；文件行显示指针光标（而非文本 I-beam）；Git 视图内隐藏 dsh-pocket 的「复制文件」按钮，并阻止 dsh-pocket 文件守卫截获 Git 文件行的点击。
- **发布说明**：`package.json` 版本提升到 `0.1.3`，tag `v0.1.3` 已推送，npm 已发布 `dsh-git-graph@0.1.3`（含 provenance）；**GitHub 未为该 tag 创建 Release**（此前仅 `v0.1.1`、`v0.1.2` 有 Release）。

## 0.1.2（2026-09-03）

- **修复**：dsh `0.1.2-alpha.5` 会话区新增的「可调宽面板」手柄（`data-width-handle`）在全屏 Git 页签上显示为
  竖条——在 Git 视图激活时将其隐藏（`[data-conversation-scroll]:has([data-git-view]) ~ [data-width-handle]`，
  仅影响 Git 页签，聊天/轨迹视图的可调宽面板不受影响）。
- **准备收录**：新增 `screenshots.json`（市场详情页截图声明，指向 `docs/screenshots/git-panel.png`）；
  仓库添加 `dsh-plugin` topic；`cordis.patch.yml` 注释更新为 Git 专用。

## 0.1.1（2026-09-03）

- **改为 Git-only**：移除「文件」浏览/编辑页签与 `/fs` API（原 CodeMirror 文件编辑器在 dsh `0.1.2-alpha.5`
  运行时上会触发 MutationObserver 死循环，先整体下线；宿主 `/fs` 代码保留，便于以后恢复）。
- **兼容性**：
  - 检测 alpha.5 的批处理 boot manifest（`window.__DSH_BOOT__.batches`），该运行时下文件编辑器自动降级为
    备选渲染（无 MutationObserver）；rc.2 保留完整 CodeMirror。
  - 宿主重复路由优雅跳过（桌面/其它插件已注册 `/git`、`/fs` 时不再崩溃）。
- **npm ↔ GitHub 关联 + CI**：`package.json` 增加 `repository`/`homepage`/`bugs`（指向 GitHub 仓库）；
  `.github/workflows/ci.yml`（push/PR 跑测试，Node 20/22）+ `release.yml`（打 `v*` 标签自动
  `npm publish --provenance`，tag 版本须与 package.json 一致）。
- **文档**：中英 README 精简为 Git-only 描述；加入 Git 面板截图
  （`docs/screenshots/git-panel.png`，从桌面工程 git 历史恢复）；发布元数据同步。
- **测试**：改为 git-only 断言（`apply()` 只注册 `/git`；`/fs` 返回 `no-route`）。

## 0.1.0（2026-09-02）

- **初始发布**（unscoped `dsh-git-graph`）：打包「Git + 文件浏览」为可安装的 dsh bundle 插件。
  - Git：状态 / 分支 / 差异 / 暂存 / 提交 / 推送拉取 / 提交图 / 溯源等 `/git` JSON API + 浏览器 Git 页签。
  - 文件浏览：`/fs` tree/read/write + 文件树 / 预览 / 编辑页签（后于 0.1.1 下线）。
  - 加固：大文件/超长单行守卫（`tooBig`）、`/fs` 越界拦截（`invalid-path`）、宿主路由注册容错。

---

## 备注

- 曾以 scoped 名 **`@enoughpower/dsh-git-graph`** 发布过 `0.1.0`/`0.1.1`；由于 2FA 绕过 token 无法执行
  撤包（npm 限制），该包仍在 registry 上，**请使用 unscoped 的 `dsh-git-graph`**。
- 发布流程：`npm version patch && git push --tags` → GitHub Actions 自动测试、发布到 npm（带 provenance）并创建对应的 GitHub Release。
