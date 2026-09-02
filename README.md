# dsh-git-graph

> DeepSeek Harness 集成 **Git** 与 **文件浏览/编辑** 一体化的插件。

`dsh-git-graph` 把 Git 操作（状态 / 分支 / 差异 / 提交 / 推送拉取 / 提交图 / 溯源）与工作区
文件浏览编辑（文件树 / 预览 / 编辑 / 保存）打包成一个可直接安装的 dsh 插件。宿主半注册 `/git` 与 `/fs`
两个 JSON API，浏览器半在侧栏底部加一个 **Git** 按钮，打开与当前会话工作目录绑定的面板（Git 页签 +
「文件」页签）。界面文案中英双语（跟随 dsh locale 服务）。

---

## 特性

### Git 操作（`/git`）
- **工作区状态**：`status` 返回分支信息 + 已暂存 / 未暂存 / 未跟踪三类文件，逐文件标注状态码（`XY`）。
- **分支管理**：列出本地/远程分支（`branches`）、切换（`switchBranch`）、新建（`newBranch`）、
  删除（`deleteBranch`）、重命名（`renameBranch`）、合并（`merge`，可选 `--no-ff`）。
- **差异与提交**：`diff`（工作区 / 已暂存）、`stage` / `unstage` / `discard` / `remove`、
  `commit`（提交选中文件或全部）、`amend`。
- **历史与溯源**：`log`（oneline 列表）、`graphLog`（带父提交的提交图）、`fileLog`（单文件历史）、
  `blame`（逐行溯源）、`show` / `showStat` / `showFiles` / `showFileDiff`（提交详情与单文件差异）、
  `catFile`（读指定 ref 或工作区文件内容）。
- **远程与标签**：`push` / `pull` / `fetch`（可 `prune`）、`remotes`、`tags`、`conflicts`。

### 文件浏览/编辑（`/fs`）
- `tree`：递归列出工作区文件树（自动跳过 `node_modules`、`.git`、`.dsh` 等目录，默认深度 10）。
- `read`：读取文件，文本 / Base64 图片 / 二进制自动判别。
- `write`：写入文件（自动创建父目录）。
- **越界拦截**：`safePath` 保证所有读写都落在 `root` 之内，`../` 或绝对路径逃逸一律拒绝。

> 大 diff 截断到 2 MiB；「文件」预览对**超大文件**（>1 MiB 文本 / >8 MiB 图片）以及**超长单行**内容会
> 降级为「文件过大或二进制，无法预览」，避免把巨型文档喂给编辑器导致页面卡死。

---

## 兼容性

| 项 | 要求 |
|---|---|
| dsh（宿主） | `>= 0.1.0-rc.5` |
| Node.js | `>= 20` |
| git | `>= 2.28`（`git init -b` 需要；分支/合并/日志等日常操作 2.x 均可） |
| 平台 | 宿主（Node）+ Web（浏览器） |

---

## 安装

该插件是 **bundle 插件**（`package.json` 声明 `dsh.bundle` + `cordis.patch.yml`，并声明 `dsh.client`），
装好后宿主层与浏览器层都会被自动激活。

```sh
# 本地目录
dsh plugin --profile web add /path/to/dsh-git-graph

# 或已发布的 npm 包
dsh plugin --profile web add dsh-git-graph
```

---

## 使用

1. 装好插件并在会话内打开一个工作区（仓库目录）。
2. 侧栏底部出现 **Git** 按钮，点击打开全屏面板。
3. 面板内：
   - **Git 页签**：顶部分支栏 + 提交图；选中一个提交看详情（变更文件 / 差异）；选中工作区文件可暂存 / 提交 / 丢弃。
   - **文件页签**：左侧完整文件树；右侧文件内容。文本可编辑（⌘/Ctrl+S 保存，⌘/Ctrl+E 切换编辑/预览），
     支持的常见格式自动高亮；`.md/.markdown` 预览自动渲染；图片等直接预览。
4. 面板绑定「当前会话工作目录」；文件操作被限制在该目录之内。

---

## JSON API

所有请求都是 `POST`，`content-type: application/json`。通用响应：

```jsonc
// 成功
{ "ok": true, "value": { /* 结果 */ } }
// 失败
{ "ok": false, "error": { "code": "git-error", "message": "..." } }
```

### `/git` 操作

| op | 请求 | 说明 |
|---|---|---|
| `status` | `{ path }` | 分支 + staged / unstaged / untracked 文件 |
| `staged` | `{ path }` | 仅已暂存（index vs HEAD）文件 |
| `branches` | `{ path }` | 本地/远程分支（当前、track 信息、ahead/behind） |
| `switchBranch` | `{ path, name }` | 切换分支（远程名自动退化为本地短名） |
| `newBranch` | `{ path, name, base?, switch? }` | 新建分支，`switch` 为真时切过去 |
| `deleteBranch` | `{ path, name, force? }` | 删除分支（`force` → `-D`） |
| `renameBranch` | `{ path, name, oldName? }` | 重命名当前/指定分支 |
| `merge` | `{ path, name, noFf? }` | 合并分支，冲突时返回 `conflicts: true` |
| `diff` | `{ path, file?, staged? }` | 差异（截断到 2MiB） |
| `stage` | `{ path, files[] }` | 暂存指定文件 |
| `unstage` | `{ path, files[] }` | 取消暂存 |
| `discard` | `{ path, files[] }` | 丢弃工作区改动 |
| `remove` | `{ path, files[] }` | 物理删除（含未跟踪） |
| `log` | `{ path, n? }` | 最近提交列表 |
| `graphLog` | `{ path, n? }` | 提交图（含父提交、作者、日期、refs） |
| `fileLog` | `{ path, file, n? }` | 单文件历史 |
| `blame` | `{ path, file }` | 逐行溯源 |
| `catFile` | `{ path, file, ref?, workingTree? }` | 读某 ref 或工作区文件内容 |
| `commit` | `{ path, message, files[]? }` | 提交选中文件（缺省提交全部） |
| `amend` | `{ path, message? }` | 追加到上一提交 |
| `show` | `{ path, hash }` | 提交补丁 |
| `showStat` | `{ path, hash }` | 提交元信息 + stat + 补丁 |
| `showFiles` | `{ path, hash }` | 提交变更的文件名 |
| `showFileDiff` | `{ path, hash, file }` | 提交内单文件差异 |
| `push` | `{ path, branch?, setUpstream? }` | 推送 |
| `pull` | `{ path, rebase? }` | 拉取（`--ff-only`） |
| `fetch` | `{ path, prune? }` | 抓取远端 |
| `remotes` | `{ path }` | 远端列表（fetch/push URL） |
| `tags` | `{ path }` | 标签列表 |
| `conflicts` | `{ path }` | 冲突文件列表 |

### `/fs` 操作

| op | 请求 | 说明 |
|---|---|---|
| `tree` | `{ root }` | `{ root, files: [{ name, path, type, size? }] }` |
| `read` | `{ root, path }` | `{ type: "text"\|"image"\|"binary", text?/base64?/size? }` |
| `write` | `{ root, path, content }` | `{ written }`；越界返回 `invalid-path` |

---

## 目录结构

```
dsh-git-graph/
├── package.json        # 插件清单：dsh.bundle + dsh.client + 发布元数据
├── cordis.patch.yml    # 宿主激活 row（id=git-graph）
├── lib/
│   ├── index.js        # 宿主半：/git + /fs 路由 + 纯函数导出（可测）
│   └── client.js       # 浏览器半：Git/文件页签 UI（预编译单文件 bundle）
├── test/
│   ├── parse.test.js       # 纯函数单测（porcelain/分支头/safePath）
│   └── integration.test.js # 真实仓库 + HTTP 端到端烟测
├── README.md           # 中文文档
├── README.en.md        # English docs
└── LICENSE             # MIT
```

---

## 开发

```sh
# 运行测试（node 内置 test runner，无需额外依赖）
npm test

# 单跑某文件
node --test test/parse.test.js
node --test test/integration.test.js
```

- `test/integration.test.js` 会真实 `git init` 一个临时仓库、启动 `apply()`、用 HTTP 驱动 `/git`、`/fs`
  做端到端冒烟，结束后清理临时目录。要求 `git` 在 `PATH` 中。
- `lib/client.js` 是预编译产物（esbuild，单文件、无 React 冲突的命令式 CodeMirror 编辑器 + One Dark 主题）。
  本仓库直接复用桌面版已编译 bundle，宿主/浏览器两半用同一包名在 dsh 客户端模块系统里注册
  （`window.__ModuleLoader__.load({ id: "dsh-git-graph", factory })`）。

---

## 安全

- `/fs` 所有 `path` 经 `safePath` 校验，`../` 与绝对路径逃逸一律拒绝（`invalid-path`）。
- 每个 `/git` 操作都限定在请求的 `path` 目录内执行，不引入任意 shell（走 `execFile` 参数数组）。
- 请求体上限 1MiB、`git` 输出缓冲 64MiB、diff 截断 2MiB，避免超大内容拖垮进程。

---

## 许可证

[MIT](LICENSE)
