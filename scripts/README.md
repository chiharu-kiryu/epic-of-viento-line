# scripts 目录说明

最近我把站点启动/重建相关流程做了分层重构，尽量让脚本职责清晰。

## 目录结构

- `ops/`
  - `site.mjs`：统一启动入口（浏览/编辑模式、参数解析、启动子进程）
  - `rebuild.mjs`：封装标准化+索引构建流程的重建任务

- `lib/`
  - `paths.mjs`：路径常量（项目根、scripts、assets、web、标准化根目录等）
  - `process.mjs`：运行外部命令、打开浏览器、命令探测的通用工具
  - `doc-api-service.mjs`：新增服务层（文档查询/编辑/重建能力、索引缓存、重建并发控制）
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
  - `build-static-doc-site.mjs`：静态索引构建入口（读取 docs-standard，生成 `web/data/index.json`）
  - `doc-site-server.mjs`：编辑模式 API + 文件服务

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
- 前端模块是否仍引用约定入口（`/web/modules/app-state.js`、`/web/modules/app-runtime.js`）

若预检失败，启动将直接中止，避免边改边跑导致的前后端约定不一致。

### API 监控与健康能力

- 新增内部诊断接口：
  - `/api/health`：返回服务健康状态、重建状态、运行时配置与请求统计快照
  - `/api/metrics`：返回接口请求的运行时指标（请求数、错误、状态码分布、路由级耗时）

- `doc-api-service.mjs` 会在每次请求开始/结束时记录监控指标，并在 `getDiagnosticSnapshot()` 中同时返回 `requestMetrics`。
