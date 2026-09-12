# Epic of Viento Line 架构说明

> 更新时间：2026-09-09

作品与程序已分离，作品及备份位于系统应用数据目录，本机默认作品由应用配置目录的 `viento.config.json` 指定，见 [本机数据目录](LOCAL_DATA_STORAGE.md)。`design-data/`、`data-template/`、`assets/` 和 `metadata/` 均相对于作品根目录；生成数据实际位于作品的 `.viento/cache/`。下文 `docs-standard/...` 和 `web/data/index.json` 仍作为兼容访问路径，由服务映射到缓存，不代表仓库根目录还有这些文件。

当前目录与元数据/迁移契约以 [作品库布局](WORKSPACE_LAYOUT.md) 为准，桌面宿主见 [桌面版说明](../desktop/README.md)。浏览模式已改用 Node.js 只读服务，同样支持程序与作品分离。

## 1. 系统定位

`Epic of Viento Line` 的文档体系是一个“**内容源 -> 标准化 -> 索引 -> 前后端 API/前端渲染**”的单仓库系统。

- 源数据：`design-data/`（策划原文，人工编辑）
- 中间产物：`docs-standard/`（标准化 JSON）
- 渲染输入：`web/data/index.json`（轻量索引）
- 运行时分发：`web/` 静态页面 + `scripts/doc-site-server.mjs` 编辑 API

---

## 2. 目录职责总览

```text
.
├─ web/                   # 前端资源与运行时页面
├─ scripts/               # 管道、服务、校验、启动编排
├─ desktop/               # 桌面首页、运行资源准备、原生测试
├─ src-tauri/             # 桌面宿主与完整迁移
├─ schemas/               # 通用数据格式
└─ README.md
```

作品数据树位于应用数据目录的 `workspaces/<作品>/`，保留 `workspace.json`、`design-data/`、`data-template/`、`metadata/`、`assets/` 与 `.viento/cache/`。`scripts/lib/app-storage.mjs` 负责本机配置和默认作品解析，`paths.mjs` 分别导出程序、作品及缓存路径。

### scripts 目录层级

- `scripts/ops/*`
  - 启动入口和工作流编排。
  - `ops/site.mjs` 负责解析启动参数并调用启动服务。
  - `ops/rebuild.mjs` 统一导出重建能力。
- `scripts/lib/*`
  - 公共服务、路由、分类、扫描、构建、校验、运行时路径与日志指标。
  - `doc-api-contract.mjs` 是前后端 API 协议锚点。
  - `doc-api-service.mjs` / `doc-server-*.mjs` 负责文档服务层。
  - `standardize-docs/*` 负责标准化解析/分类/输出流水线。
  - `rebuild-workflow.mjs` 统一 orchestration（标准化 + 静态索引构建）。
- `scripts/lib/scan-files.mjs`
  - 文件扫描基础能力：递归列举可处理文件。
- `scripts/standardize-docs/*`
  - 文本/JSON/YAML 解析
  - source 分类与元信息提取
  - 标准化 JSON 输出与写入规则
  - `parser.mjs` 通用解析，`legacy-profile.mjs` 负责旧格式兼容
  - `layout.mjs` 从原文章节、字段和内容块生成统一布局；类型不限定字段
- `scripts/normalize-*.mjs`
  - 特化清洗脚本：英雄/单位/建筑/物品等文本规范化重排（可选写回）

### 前端

- `web/app.js`：应用入口
- `web/modules/app-state.js`：状态、常量、API 路径常量入口
- `web/modules/app-runtime.js`：渲染主循环、列表/详情/编辑状态机
- `web/modules/app-editor-draft.js`：从当前源码拆分编辑区块，保留原文格式并按修改区块写回
- `web/modules/app-doc-service.js`：与后端 API 的交互
- `web/modules/app-services.js`：请求工具（超时、错误、JSON 解析）

---

## 3. 运行模式

### 浏览模式（默认）

- 启动：`./scripts/start-doc-site.sh --mode browse`
- 行为：
  1. 可选重建标准化产物与索引
  2. 启动只读文件服务（Node.js）
  3. 仅读取 `web/data/index.json` 与 `docs-standard` 渲染展示

### 编辑模式

- 启动：`./scripts/start-doc-site.sh --mode edit`
- 行为：
  1. 可选重建标准化产物与索引
  2. 启动 `doc-site-server`
  3. 提供 `/api/*` 读写源文件、`/api/rebuild` 重建、`/api/capabilities` 能力探测

---

## 4. 数据流

### 4.1 标准化管道

1. 启动/重建时：读取 `design-data/` 原文路径。
2. `standardize-docs` 通过 `sources -> parser -> doc-factory -> catalog` 输出标准文档。
3. 标准文档写入 `docs-standard/`。
4. `build-static-doc-site` 构建 `web/data/index.json`。
5. 前端加载索引进行列表与详情渲染。

### 4.2 编辑写回闭环

1. 前端 `/api/doc?path=...` 读取源文件内容。
2. 用户编辑保存。
3. 后端在同一文档的串行事务中校验版本，再通过临时文件和原子替换写回 `design-data/`；并发新建使用独占创建，旧版本保存返回 409。
4. 触发重建可更新 `docs-standard/` 与 `web/data/index.json`。

文档由 `metadata/documents/<UUID>.json` 登记身份、解析配置和归属关系。角色背景用 `part-of` 关联角色，索引解析 ID 关系后生成嵌套目录与档案内导航；独立故事章节保持独立条目。多个角色可关联同一份背景。全量与局部重建均保留关系，详见 [OC 文档模型](OC_DOCUMENT_MODEL.md)。

编辑器的源码/区块切换共享当前草稿，不从展示索引反向生成文本。保存及重建期间禁止重复提交和编辑状态切换；源码与模板读取使用请求序号，防止迟到响应覆盖另一会话。新建路径也参与未保存判断，新建写入成功后即转为已有文件，重建失败仍可继续编辑。

### 4.3 可编辑路径边界

- 允许写路径：`design-data/` 与 `docs-standard/design-data/`。
- `safePathFromQuery / resolveEditableFilePath / isAllowedEditPath` 负责防路径穿越。

---

## 5. API 与契约

核心契约定义集中在：
- [scripts/lib/doc-api-contract.mjs](../scripts/lib/doc-api-contract.mjs)

关键端点：
- `/api/capabilities`
- `/api/health`
- `/api/metrics`
- `/api/index`
- `/api/doc`
- `/api/rebuild`

契约执行：启动前会做预检，异常时停止启动。
- 预检文件：`scripts/lib/verify-doc-api-contract.mjs`

---

## 6. 关键能力矩阵（模块职责）

| 能力 | 模块 | 备注 |
|---|---|---|
| 启动模式解析 | `scripts/lib/site-options.mjs` | CLI 参数与帮助 |
| 启动编排 | `scripts/lib/site-launcher.mjs` | 编辑/浏览分支、标准化与静态启动 |
| 重建编排 | `scripts/lib/rebuild-workflow.mjs` | 统一调用标准化与静态构建 |
| 标准化 | `scripts/standardize-docs/*` | 解析、分类、标准对象生成 |
| 索引构建 | `scripts/lib/static-index.mjs` | 从标准文档构建页面索引 |
| 编辑服务 | `scripts/lib/doc-api-service.mjs` + `scripts/lib/doc-server-*` | 读写与重建 API |
| 前端渲染 | `web/modules/app-runtime.js` | 页面渲染、编辑状态机 |
| 前端网络 | `web/modules/app-services.js` / `app-doc-service.js` | 网络请求、错误与重试上下文 |
| 验证与健康 | `scripts/validate-standard-docs.mjs`, `validate-data-template-alignment.mjs`, 指标 | 数据质量与模板一致性 |

---

## 7. 当前可维护性诊断（现状）

- 结构已形成“来源-标准化-索引-渲染-服务”四层链路，重构方向正确。
- 前后端契约约束较强，降低了接口断裂风险。
- 运行时职责虽清晰，但有一定“工具脚本重复逻辑”倾向（normalize 系列）可逐步抽象。

---

## 8. 重构优先级（建议）

### P0（建议优先）
1. 文档源扫描白名单统一：将所有标准化与修复脚本的扫描规则统一到共享配置（避免路径一致性偏差）。
2. 统一重建错误模型：把标准化失败、索引失败、模板缺失失败分类并返回统一结构。
3. 前端错误面板结构化：将当前全局错误聚合输出为可追踪链（服务URL/attempts/状态码）。

### P1
4. 将 `start-doc-site-edit.sh`、`start-doc-site-live.sh` 迁移到 `scripts/ops/site.mjs` 参数入口，减少 shell 入口冗余。
5. 把“可写字段/排序”类型脚本统一为 `scripts/normalize-cli.mjs` 插件化子命令。
6. 为 `DOC/重建/索引` 提供单元测试级别的回归样例（至少三类文档+一条错误路径）。

### P2
7. 增加“文件级变更追踪日志”（写回时间、操作者、版本快照）。
8. 优化 `docs-standard` 与源文件版本映射（便于回滚和差异比对）。
9. 在 `validate-standard-docs` 中补充字段分组一致性检查（按 `inferPurposeGroup` 与 template 期望字段）。

---

## 9. 近期可执行任务清单

- [ ] 将新增脚本（如 `reorder-source-metadata-fields.mjs`）加入统一工具文档索引
- [ ] 增加 `scripts/ops/site.mjs` 的参数帮助中显示全部 `--help` 子命令说明
- [ ] 为 `/api/health` 加入重建队列长度（当前有进行中态）
- [ ] 补齐系统级架构图到可视文档（SVG/PlantUML 任选其一）

## 10. 系统结构图

```mermaid
flowchart LR
    User[用户浏览器\n(web/app.js)] -->|请求索引/详情| Frontend(前端渲染与状态层)
    Frontend -->|静态读取| IndexFile[(web/data/index.json)]
    Frontend -->|编辑读写接口| API[doc-site-server\n/doc-api-service]

    API -->|读写| SourceData[design-data\n源文件]
    API -->|校验| FSGuard[路径与版本守卫]
    API -->|执行| Rebuild[rebuild-workflow]

    Rebuild --> Std[standardize-docs]
    Std --> DocStd[docs-standard]
    DocStd --> IndexBuilder[static-index]
    IndexBuilder --> IndexFile

    SourceData --> Std
    scripts[启动脚本/ops/lib]
    scripts --> Rebuild
    scripts --> SiteLauncher[site-launcher]
    SiteLauncher --> API
    SiteLauncher --> StaticServer[只读文件服务\n(Node.js)]
    StaticServer --> Frontend
```

## 11. 前端渲染与错误处理链路（建议实现）

- 前端统一入口：所有异步调用通过 `web/modules/app-services.js` 封装，形成统一的 request wrapper。
- 错误标准化：服务端 `/api/*` 返回固定 `{ ok: boolean, data?, error?, requestId? }`，前端按 `error.code / status` 分类提示。
- 视图层降级：主视图优先读 `web/data/index.json`，API 调用失败时显示离线/重试提示，不阻塞基础列表加载。
- 编辑态安全：`/api/doc` 先做 schema 验证，再做路径校验，失败原因返回 `400/403/409`，并在前端展示具体字段（路径/版本/原因）。
- 重建异步化：`/api/rebuild` 返回任务快照 `queued / running / finished / failed`，前端轮询 `metrics/health` 显示处理状态，避免阻塞主线程。
- 可观测增强：`/api/health` 建议加入重建中排队长度、近 5 分钟错误率、当前重建耗时分位数，前端错误面板可直接消费。

## 12. 参考入口

- 源数据：`design-data/README.md`
- 构建脚本：`scripts/README.md`
- 运行入口：`scripts/start-doc-site.sh`
- API 契约：`scripts/lib/doc-api-contract.mjs`
