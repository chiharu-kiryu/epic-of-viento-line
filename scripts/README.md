# scripts 目录说明

最近我把站点启动/重建相关流程做了分层重构，尽量让脚本职责清晰。

## 目录结构

- `ops/`
  - `site.mjs`：统一启动入口（浏览/编辑模式、参数解析、启动子进程）
  - `rebuild.mjs`：封装标准化+索引构建流程的重建任务

- `lib/`
  - `paths.mjs`：路径常量（项目根、scripts、assets、web、标准化根目录等）
  - `process.mjs`：运行外部命令、打开浏览器、命令探测的通用工具
  - `category.mjs`：文档分类/用途推断、字段归类等纯逻辑（可被多个脚本共享）
  - `static-index.mjs`：标准化文档索引构建核心逻辑（数据提取、分类、图片归集），供静态索引脚本复用

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
