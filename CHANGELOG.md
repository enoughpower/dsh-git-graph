# 更新说明（CHANGELOG）

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
- 发布流程：`npm version patch && git push --tags` → GitHub Actions 自动测试并发布（带 provenance）。
