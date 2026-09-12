# Epic of Viento Line

当前版本：**b.2.8**。更新内容和版本规则见 [发布记录](docs/RELEASE_b.2.8.md)。

Viento Studio 是通用 OC 设计 IDE；此仓库包含编辑器、转换器和桌面宿主。正文、模板、元数据、素材及作品备份保存在独立作品文件夹，具体位置可用 `npm run workspace -- paths` 查看。新项目采用 `documents / templates / metadata / assets`，类型和模板由项目定义，见 [通用项目结构](docs/GENERIC_PROJECTS.md)。

## 仓库结构

```text
web/                  编辑器界面
scripts/              服务、转换器、登记与校验工具
src-tauri/            桌面宿主及完整备份迁移
desktop/             桌面首页、运行环境准备、原生测试
schemas/              通用文件格式定义
docs/                 架构、数据格式与迁移记录
```

Linux 默认作品目录为 `~/.local/share/io.viento.studio/workspaces/`，本机选择配置为 `~/.config/io.viento.studio/viento.config.json`。启动命令读取本机配置，也可用 `VIENTO_WORKSPACE_ROOT` 指定作品；桌面程序记住移动后的路径。作品内容和内部层级保持原样，缓存仍集中在作品的 `.viento/cache/`。

[本机数据目录与迁移方式](docs/LOCAL_DATA_STORAGE.md)

[作品库布局与元数据契约](docs/WORKSPACE_LAYOUT.md) · [本次迁移及完整性记录](docs/STRUCTURE_MIGRATION.md)

## 文档规范

- 默认使用 UTF-8 编码与 LF 换行。
- 保持中文字段名统一，优先使用全角冒号 `：`。
- 同类文档尽量遵循相同字段顺序，避免同义字段混写。
- 不轻易修改既有文件名与目录层级，优先通过补充说明文档来提升可读性与可维护性。

## 资料维护建议

1. 新项目正文保存在 `documents/`，按需要修改 `templates/` 中的模板与项目类型。
2. 角色背景写在角色档案中；独立故事另行保存。旧作品继续使用原有目录和归属登记。
3. 素材使用稳定 ID 登记和关联；名称用于展示，路径用于定位，不再依靠相似名称自动关联。

### 架构与运维参考

- 系统整体架构：[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- 脚本职责说明：[`scripts/README.md`](scripts/README.md)

## Tauri 桌面版

`Viento Studio` 提供作品库首页，可新建作品、直接打开现有项目文件夹，或导入与导出含完整性校验的迁移包。安装包内置运行环境，双击应用即可启动编辑器；正文、模板和素材保存在独立作品库中。

- 开发运行：`npm ci` 后执行 `npm run desktop:dev`。
- 构建安装包：`npm run desktop:build`。
- 本机交付：`dist/current/`，包含 b.2.8 Linux 便携包、源码与校验记录；完整作品迁移包在应用数据目录的 `backups/`。
- 构建后释放空间：`npm run clean`，仅清理可重建的桌面构建目录；交付目录和作品保留。
- 数据目录、备份格式、三端发行与构建依赖见 [`desktop/README.md`](desktop/README.md)。
- 最新发布见 [b.2.8 发布记录](docs/RELEASE_b.2.8.md)，故障复现和验证见 [修复记录](docs/BUGFIX_0.2.1.md)。
- 本版本后续排查见 [调用链故障记录](docs/CALL_PATH_BUGFIX_b.2.8.md)。

## 文档网页化预览（HTML5）

运行环境：Node.js 18.19 或更新版本；浏览和编辑服务均由 Node.js 提供。首次运行先执行 `npm ci` 安装 YAML 解析依赖。项目使用原生 ES 模块。

新增了文档仓库站点，主页面位于 [web/index.html](web/index.html)。

站点支持两种模式：

- 浏览模式（只读）：使用标准化后的静态页面。
- 编辑模式（可新建 / 编辑 / 重建）：在页面提供编辑接口的前提下运行服务端 API。

### 一键启动（推荐）

`./scripts/start-doc-site.sh` 支持动态模式切换，`--mode` 可选：

- `--mode browse`：浏览模式（默认，只读）
- `--mode edit`：编辑模式（带 `/api/doc`、`/api/rebuild`）

示例：

- 浏览：`./scripts/start-doc-site.sh --mode browse --no-open`
- 编辑：`./scripts/start-doc-site.sh --mode edit --no-open`

也可以继续使用兼容入口：

- `./scripts/start-doc-site-edit.sh --no-open`（等价于 `--mode edit`）
- `./scripts/start-doc-site-live.sh --no-open`（等价于 `--mode edit`）

### 浏览模式

1. 运行：`./scripts/start-doc-site.sh --mode browse --no-open`
2. 默认会先标准化全部文档到 作品的 `.viento/cache/docs-standard/`（不改动原文件），再生成清单并启动本地服务。
3. 文档按通用解析布局展示。角色背景通过元数据中的 `part-of` 关系归属角色，从角色档案内查看和编辑；作品故事保持独立章节。详见 [OC 文档模型](docs/OC_DOCUMENT_MODEL.md)。
4. 浏览器自动打开 `http://127.0.0.1:4173/web/`
5. 命令参数可选：
   - `./scripts/start-doc-site.sh --port 8080`
   - `./scripts/start-doc-site.sh --no-build`（保留现有作品索引，不重新构建）
   - `./scripts/start-doc-site.sh --no-standardize`（只构建索引，不重建标准化数据）
   - `./scripts/start-doc-site.sh --no-open`

### 编辑模式

若你要使用页面里的“新建/编辑/重建”能力，请启动编辑模式：

1. 运行：`./scripts/start-doc-site.sh --mode edit --no-open`
   - 兼容入口：`./scripts/start-doc-site-edit.sh --no-open` 或 `./scripts/start-doc-site-live.sh --no-open`
2. 默认端口同样是 `4173`，访问：`http://127.0.0.1:4173/web/`
3. 该命令会包含：
   - `node scripts/standardize-docs.mjs`
   - `node scripts/build-static-doc-site.mjs`
   - `node scripts/doc-site-server.mjs --port 4173`

参数与说明同样支持：
- `-p / --port` 切换端口
- `--no-open` 禁止自动打开浏览器
- `--no-build` 跳过作品索引重建
- `--no-standardize` 跳过标准化步骤

编辑器操作：

- 新建时选择文档类型以加载模板；路径默认沿用同类文档的目录，切换类型后使用对应分类目录。
- 源码和区块模式可以来回切换，区块取自当前草稿，保留代码围栏、表格、空行和缩进。
- 两种编辑模式均支持 `Ctrl/Cmd+S` 或 `Ctrl/Cmd+Enter` 保存。文本框支持浏览器原生撤销、重做。
- 取消编辑、切换文档或模式时，未保存的内容与新建路径都会触发确认。
- 保存和索引重建期间暂停输入及重复提交；新建写入成功但重建失败时，可在当前文档继续编辑和重试。

标准化脚本可单独运行：
- `node scripts/standardize-docs.mjs`
- 生成文件位于 作品的 `.viento/cache/docs-standard/`
- 原始文件与现有目录保持不变，适合用于版本化存档和后续站点接入。

脚本层也已重构：启动入口仍是 `./scripts/start-doc-site.sh`，实际逻辑集中在 `scripts/ops` 与 `scripts/lib`，详细分层说明见 [`scripts/README.md`](scripts/README.md)。

### 项目检查

- `npm test`：运行回归测试，覆盖编辑器草稿、模式切换、异步请求、并发保存、模块加载、章节标识、构建输出和模板校验。
- `npm run check`：检查语法、接口契约、当前本机作品的标准化数据、模板对齐和索引唯一性，再运行回归测试。
- `npm run check -- --app-only`：只检查程序及临时样例测试，用于新环境和 CI，不需要日常作品或素材。
- 也可直接运行 `node scripts/check-project.mjs`。

首次检查或需要同步生成数据时运行 `npm run rebuild`。也可以依次运行 `node scripts/standardize-docs.mjs` 和 `node scripts/build-static-doc-site.mjs`。
`--no-build` 只跳过索引构建；同时加上 `--no-standardize` 可直接使用现有产物启动。

### 常用命令

```sh
npm ci
npm run rebuild
npm run check
npm start -- --no-open
```

`npm run browse -- --no-open` 启动只读预览。`npm run workspace -- register` 增量登记新素材和文档；`npm run workspace -- verify` 核验素材原文件及登记关系。`npm run workspace -- paths` 显示本机作品与备份位置；桌面版从最近作品列表打开。
