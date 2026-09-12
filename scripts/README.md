# scripts 目录说明

脚本按启动编排、文档转换、文件服务和作品数据管理分层。应用目录与作品目录独立，默认作品由应用配置目录的 `viento.config.json` 指定；位置可用 `npm run workspace -- paths` 查看，详见 [本机数据目录](../docs/LOCAL_DATA_STORAGE.md)。

## 目录结构

- `ops/`
  - `site.mjs`：统一启动入口（浏览/编辑模式、参数解析、启动子进程）
  - `rebuild.mjs`：封装标准化+索引构建流程的重建任务

- `lib/`
  - `paths.mjs`：分别定位程序、作品、外置素材与缓存目录
  - `workspace.mjs`：作品清单、文档/素材登记、内容指纹、目录绑定与独立索引
  - `process.mjs`：运行外部命令、打开浏览器、命令探测的通用工具
  - `doc-api-service.mjs`：新增服务层（文档查询/编辑/重建能力、索引缓存、重建并发控制）
  - `doc-file-store.mjs`：同一文档的读写串行控制、内容与版本快照、原子写入和独占新建
  - `category.mjs`：文档分类/用途推断、字段归类等纯逻辑（可被多个脚本共享）
  - `static-index.mjs`：标准化文档索引构建核心逻辑（数据提取、分类、图片归集），供静态索引脚本复用
  - `doc-server.mjs`：编辑服务器通用能力（安全路径、API payload 解析、索引构建、文件读写辅助、路径规范化）
  - `doc-server-routes.mjs`：API 路由分发与实现（`/api/index`、`/api/doc`、`/api/rebuild`、`/api/capabilities`、`/api/health`、`/api/metrics`）
  - `doc-api-metrics.mjs`：API 请求级监控（请求数、成功率、平均耗时、路由维度快照）
  - `doc-server-static-routes.mjs`：静态资源路由（favicon、静态文件、SPA 回退）
  - `doc-api-contract.mjs`：API 入口、方法、参数与响应字段约定
  - `site-options.mjs`：启动命令行参数解析和帮助文案
  - `site-launcher.mjs`：站点启动/重建流程编排（重建任务、启动静态服务或编辑服务器）
  - `rebuild-workflow.mjs`：重建流程与执行器（标准化 + 静态索引构建）

- 业务脚本
  - `standardize-docs.mjs`：原始文档标准化
  - `reorder-source-metadata-fields.mjs`：扫描识别手动新增/改动源文件，并可直接写回原元数据文件
  - `build-static-doc-site.mjs`：静态索引构建入口（读取作品标准化缓存，生成 `.viento/cache/indexes/` 下的文档、素材与引用索引）
  - `doc-site-server.mjs`：编辑模式 API + 文件服务
  - `browse-server.mjs`：只读文件服务，同样支持程序/作品分离
  - `workspace.mjs`：登记、校验与绑定素材目录的命令入口

元数据字段修复示例：

- 扫描单个文件并回写：`node scripts/reorder-source-metadata-fields.mjs --write design-data/design-item/xxx.md`
- 按类型扫描并回写：`node scripts/reorder-source-metadata-fields.mjs --write --type item --path design-data/design-item`
- 扫描目录：`node scripts/reorder-source-metadata-fields.mjs --path design-data/design-item --path design-data/design-units`
- 扫描默认全量并包含手动路径：`node scripts/reorder-source-metadata-fields.mjs --all --path /abs/path/to/newfile.md`

## 使用入口

- `./scripts/start-doc-site.sh`：推荐入口
  - 浏览模式：`./scripts/start-doc-site.sh --mode browse --no-open`
  - 编辑模式：`./scripts/start-doc-site.sh --mode edit --no-open`

兼容入口：
- `./scripts/start-doc-site-edit.sh --no-open`
- `./scripts/start-doc-site-live.sh --no-open`

## 说明

`start-doc-site.sh` 仅作为薄层代理，真正的参数解析和流程在 `scripts/ops/site.mjs`，
便于后续把 shell 逻辑逐步迁移到 JS，减少重复和分散。

启动前会执行 API 契约预检（`scripts/lib/verify-doc-api-contract.mjs`），用于快速校验：

- API 常量与约定字段是否完整（`/scripts/lib/doc-api-contract.mjs`）
- 后端路由是否使用约定常量（`/scripts/lib/doc-server-routes.mjs`）
- 前端状态和运行入口是否仍引用服务层，以及请求组装是否遵循契约（`web/modules/app-state.js`、`web/modules/app-runtime.js`、`web/modules/app-doc-service.js`）

若预检失败，启动将直接中止，避免边改边跑导致的前后端约定不一致。

- 服务架构全图和链路说明可见：`docs/ARCHITECTURE.md`

### API 监控与健康能力

- 新增内部诊断接口：
  - `/api/health`：返回服务健康状态、重建状态、运行时配置与请求统计快照
  - `/api/metrics`：返回接口请求的运行时指标（请求数、错误、状态码分布、路由级耗时）

- `doc-api-service.mjs` 会在每次请求开始/结束时记录监控指标，并在 `getDiagnosticSnapshot()` 中同时返回 `requestMetrics`。

### 回归检查与输出目录

先运行 `npm run rebuild` 生成当前作品缓存，再运行 `node scripts/check-project.mjs` 执行完整检查；`node --test scripts/tests/*.test.mjs` 只执行回归测试。
测试在系统临时目录创建独立数据，完成后自动清理。

`editor-draft.test.mjs` 验证区块编辑的原文往返与局部修改；`editor-runtime.test.mjs`
通过轻量 DOM 环境验证实际编辑器控制器的草稿保护、读取顺序、保存互斥和新建恢复流程。
浏览器中的新建、源码/区块保存、快捷键和索引刷新另作交互验证。

编辑器测试模拟浏览器 textarea 将换行统一为 LF 的行为，验证保存时保留原文件的 BOM、CRLF 和末尾空格，
并覆盖新建文件在重建后获得正式索引标识时保持编辑状态。未保存草稿在取消文档切换、退出编辑和切换浏览模式时均应保留。

2026-09-09 的临时项目浏览器验证覆盖：源码与区块连续修改、Ctrl+S / Ctrl+Enter 保存、重新打开、
模板类型切换、同名创建拒绝覆盖、中文标点路径、新建后继续编辑、空文档、JSON、CRLF 原文保真、
保存冲突时保留草稿/载入最新，以及索引构建失败后继续编辑并再次保存。每次成功保存均核对源文件与重建索引。
原生未保存确认框会阻塞当前浏览器自动化工具，其保留/放弃分支由控制器测试验证，未计为完整浏览器验证。

`standardize-docs.mjs --output <目录>` 只更新指定目录并清理其中的过期文档，不删除默认目录。
输出目录必须与项目源目录分离，扫描来源时会排除该输出，避免重复构建将产物再次当作源文档。

模板校验过滤隐藏文件，并使用前端模板定义中的字段别名检查覆盖范围。
正文对话不作为背景故事元数据；尚未使用的可选模板字段仅作信息提示，未知的结构化字段和错误映射仍使严格检查失败。

### 元数据转换与预览

首次运行先执行 `npm ci`。JSON/YAML 保留数值、布尔值、数组和嵌套对象；YAML 使用 `yaml` 解析库，
引号中的 `#`、网址片段和多行文本不会被当作注释截断。格式错误会保留原文、标记解析失败，并使严格校验失败。

文本转换区分标题、代码围栏、表格、正文和元数据。英雄技能的内部参数保留在所属技能中；背景故事只把
`正文`、`内容`、`剧情`、`正文内容` 和 `_header` 作为显式字段，其余台词按正文显示。
表格保留空单元格与列对齐，正文保留重复段落；预览只隐藏已经在卡片中显示的字段。
索引中的源路径保留真实扩展名，空源文件保持为空。同名但扩展名不同的源文件若会写入同一标准化路径，构建会报错。

`reorder-source-metadata-fields.mjs` 只排序无扩展名、`.md`、`.txt` 文本，保留 BOM、换行格式和末尾换行，
不会跨 Markdown 标题或代码围栏移动字段。JSON/YAML 不进行逐行排序，错误的类型参数会直接终止。

`parser.test.mjs`、`metadata-conversion.test.mjs`、`structured-render.test.mjs` 覆盖解析、索引、API 读写与重建、
字段排序和实际预览函数；编辑器的源码/区块往返检查仍由 `editor-draft.test.mjs` 和 `editor-runtime.test.mjs` 执行。
