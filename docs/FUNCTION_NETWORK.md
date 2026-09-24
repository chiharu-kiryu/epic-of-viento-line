# Viento Studio 功能链路网络

此页枚举 **2026-09-24、b.4.3 发布工作树**的实际功能入口、业务步骤、接口和数据落点，包含[按图排查的四十五轮修复](NETWORK_BUGFIX_b.2.8.1.md)。此为修订 63，收录 N114–N120 并同步[发布验证](RELEASE_b.4.3.md)。JSON 保留此前源码与发布验证证据；本次发布前 Git 基线为 `03265ba0`。最初基线为 `51d522cb919c20b15815b129bd62e859af9a97a0`。

- [离线交互浏览器](function-network.html)：筛选业务链路，点击节点查看上下游，查询真实模块导入及接口。下载后双击即可使用，不访问外网。
- [机器可读快照](function-network.json)：完整节点、边、源码引用、模块导入、事件绑定、路由、命令和扫描文件指纹。
- [总图 Mermaid 源文件](function-network.mmd)：可在支持 Mermaid 的工具中继续编辑。

## 1. 范围与读图方式

| 统计项 | 数量 |
| --- | ---: |
| 已枚举业务链路 | 50 |
| 功能及数据节点 | 66 |
| 业务步骤连接（去重） | 173 |
| 扫描代码文件（JS / MJS / Rust / Python / Shell） | 170 |
| 其中 JavaScript 模块 | 150 |
| 本地模块导入语句 | 499 |
| 字面量事件名的显式事件绑定 | 98 |
| 业务 HTTP 路径 / 方法组合 | 11 / 16 |
| 桌面桥路径 / 方法组合 | 5 / 6 |
| 原生首页命令 | 11 |
| 作品维护 CLI 子命令 | 7 |

业务图的箭头表示请求、数据传递或处理步骤；同一节点可以再次出现，且分支可能在文字中展开。**它不是逐函数调用图**。JSON 的 `moduleImports` 才是代码中实际声明的本地导入；它也不能表示调用次数或性能。桌面归档示例 CLI 另有 4 个操作，不计入 7 个作品维护命令。

网络从代码静态梳理，不是运行时追踪。本次发布 app-only 检查共 586 项，全部通过、零失败、零跳过，已启用实际原生归档程序。[发布验证记录](test-results/release-b.4.3/results.json)区分本轮重跑结果和三轮开发阶段的真实浏览器验证；历史报告继续保留。每条链路的“已有验证入口”不代表所有运行状态均已覆盖。测试仅使用临时作品，日常正文、素材和备份未读写。

## 2. 总体网络

```mermaid
flowchart LR
  subgraph UI[界面入口]
    Home[作品库首页]
    Editor[文档浏览与编辑]
    Project[项目类型与模板]
    Media[图片 / 视频 / 音频]
    Export[导出]
    Language[语言设置]
  end
  subgraph HOST[桌面与服务]
    Tauri[Tauri 宿主与会话]
    API[本地业务接口]
    Static[静态文件与素材服务]
    Jobs[导出任务]
  end
  subgraph ENGINE[共享引擎]
    Types[类型 / 模板 / 解析规则]
    Registry[稳定 ID 与归属登记]
    Parser[通用解析器]
    Layout[viento-layout-v1]
    Build[标准化与三份索引]
  end
  subgraph DATA[作品与本机数据]
    Source[正文 / 模板 / 元数据]
    Assets[素材根 / 外置绑定]
    Cache[可重建缓存]
    Preferences[本机配置与最近作品]
    ZIP[分享包 / 完整项目包]
  end
  Home --> Tauri
  Tauri -->|启动引擎| API
  Tauri -->|Rust 归档| ZIP
  Tauri --> Preferences
  Editor -->|读写原文| API
  Editor -->|加载展示索引| Static
  Project --> API
  Media --> API
  Export --> API
  Language -->|桌面偏好桥| Tauri
  API --> Source
  API --> Assets
  API --> Types
  API -->|重建| Build
  API --> Jobs
  Jobs -->|Node 归档| ZIP
  Jobs --> Parser
  Types --> Parser
  Source --> Build
  Registry --> Build
  Build --> Parser
  Parser --> Layout
  Layout --> Build
  Build --> Cache
  Cache --> Static
  Assets --> Static
  Static -->|内容与媒体| Editor
```

程序安装包提供宿主、界面、服务和引擎；每个作品持有自己的内容、类型与素材。日常浏览读取生成索引，编辑读取源文件，保存后再重建展示。权威正文不会从展示 JSON 反向恢复。

## 3. 关键分支图

### 3.1 编辑、保存与索引刷新

```mermaid
flowchart TD
  Select[选择文档] --> Read[GET /api/doc：原文与版本]
  Read --> Draft[源码或区块草稿]
  Template[项目类型模板] --> New[新建草稿]
  New --> Draft
  Draft --> Save[POST /api/doc]
  Save --> Version{版本及创建条件}
  Version -->|冲突| Conflict[冲突选择；草稿保留]
  Version -->|已有文档| Write[原子写入源文件]
  Version -->|新建| Register[登记类型和 UUID]
  Register --> Write
  Write --> Rebuild[POST /api/rebuild]
  Rebuild --> Standard[标准化 → 布局 → 索引]
  Standard --> Reload[读取静态展示索引]
  Reload --> View[重新定位和渲染]
  Rebuild -->|失败| Retry[正文已保存；可重试重建]
```

源码保存与展示重建是两个阶段。新建成功后，即使重建失败，界面也应按已有文档继续工作。取消、切换、返回和关窗分别读取当前草稿与忙碌状态。

### 3.2 三处共用解析，以及两种索引

```mermaid
flowchart LR
  Source[已保存原文] --> Standardize[标准化]
  Rules[登记类型与项目规则] --> Standardize
  Form[类型表单中的模板] --> Preview[模板预览]
  ExportSource[导出选中的原文] --> ExportPlan[分享导出]
  Standardize --> Parser[parseSourceContent]
  Preview --> Parser
  ExportPlan --> Parser
  Parser --> Layout[buildDocumentLayout]
  Layout --> StdCache[标准文档缓存]
  StdCache --> Index[完整文档索引]
  Relations[part-of 与稳定登记] --> Index
  Index --> Display[静态 URL → 编辑器展示]
  Layout --> PreviewUI[模板预览界面]
  Layout --> Offline[离线 HTML / Markdown]
  IndexAPI[GET /api/index] --> Scan[扫描源路径与登记]
  Scan --> Light[轻量目录；独立内存缓存]
```

**当前界面加载路径不是 `/api/index`**：`getDataIndexUrlCandidates()` 依次尝试页面相对 `data/index.json`、`/web/data/index.json`、`/data/index.json`，去掉重复项。`/web/data/index.json` 映射到作品的完整索引；v2/v3 为 `.viento/cache/indexes/documents.json`。

`/api/index` 的 `buildEditableDocIndex()` 只扫描文件路径、登记类型、修改时间和图片关联，不解析正文、不生成 layout、不附加归属树。它的默认 5 秒缓存与完整展示索引是不同的数据通道。

### 3.3 媒体导入、嵌入与播放

```mermaid
flowchart TD
  Choose[选择文件 / 粘贴 / 拖入] --> Upload[POST /api/assets]
  Upload --> Check[内容检测、体积校验、哈希去重]
  Check --> Asset[素材文件 + UUID 元数据]
  Existing[复用已登记素材] --> Insert[嵌入引用]
  Asset --> Insert
  Insert -->|文本| Caret[光标处插入媒体语法]
  Insert -->|JSON / YAML| Patch[POST /api/assets/insert：源范围补丁]
  Caret --> Draft[当前草稿]
  Patch --> Draft
  Draft --> Preview[同一接口解析草稿并提取媒体]
  Preview --> Player[图片 / 原生音视频控件]
  Player --> Resolve[本地素材 URL → ID / 旧路径解析]
  Resolve --> Root[当前素材根；支持外置绑定]
  Draft --> Save[保存正文才持久化引用]
```

导入素材会先落盘；放弃文档草稿并不自动删除已经导入的文件。取消导入也覆盖后续结构化补丁请求；应用响应前核对草稿，迟到结果不覆盖新的编辑状态。图片、视频和音频共用引用与导出链路；媒体预览调用解析器提取媒体，不经过通用卡片布局。元数据 `assetBindings` 进入登记、索引及导出附件清单；当前索引的图片补全只取 image，绑定音视频本身不等于正文已插入播放器。

### 3.4 分享、完整迁移与两种归档实现

```mermaid
flowchart TD
  UI[编辑器 / 浏览模式导出] --> Jobs[Node 导出任务]
  Jobs --> Mode{范围}
  Mode -->|当前文档| Share[原文 + 附属文档 + 用到的素材]
  Share --> Render[通用解析和布局 → HTML / Markdown]
  Render --> ShareZIP[文档分享 ZIP]
  Mode -->|完整项目| NodeArchive[正文、模板、登记和全部素材]
  NodeArchive --> FullZIP[完整迁移 ZIP]
  Home[作品库备份] --> RustArchive[Rust 流式归档]
  RustArchive --> FullZIP
  ShareZIP --> Save{保存方式}
  FullZIP --> Save
  Save -->|编辑器桌面窗口| Native[任务 ID → 宿主对话框 → 原子复制]
  Save -->|网页| Download[GET /api/export 下载]
  FullZIP --> Restore[作品库导入 → 校验 → 新目录 → 登记和重建]
```

作品库备份直接通过 Rust 写用户选择的目的文件；编辑器的 Node 任务先写暂存包，再下载或交给宿主保存。只有完整迁移包支持作品库恢复；文档分享包用于阅读。浏览模式也开放导出接口，只写导出缓存，不提供正文写入。

### 3.5 桌面会话与语言

```mermaid
sequenceDiagram
  participant Home as 作品库首页
  participant Host as Tauri 宿主
  participant Engine as 内置 Node 引擎
  participant Editor as 编辑窗口
  Home->>Host: launch_workspace
  Host->>Host: 校验最近作品、获取会话锁
  Host->>Engine: 启动进程，随机本机端口
  Engine->>Engine: 登记与重建
  Engine-->>Host: VIENTO_EVENT ready
  Host->>Editor: 打开会话 URL
  Editor->>Engine: 会话 token 换取 Cookie
  Editor->>Engine: preferences / library / export / close-response
  Engine-->>Host: VIENTO_EVENT
  Host-->>Editor: 语言结果 / 保存结果 / 窗口状态
  Host-->>Home: 最近作品和语言同步
  Host->>Editor: 带请求 ID 读取忙碌与草稿状态
  Editor->>Engine: close-response（id / busy / dirty）
  Engine-->>Host: 转发状态；无回复时宿主提供原生恢复确认
  Host->>Host: 有草稿时原生确认；取消恢复编辑
  Host->>Engine: 确认关闭后发送 VIENTO_SHUTDOWN
  Engine->>Engine: 停止并等待索引进程退出
  Engine-->>Host: Terminated
  Host->>Host: 释放作品会话锁
```

首页通过 11 个原生命令操作作品。编辑网页通过受限本机会话桥交给宿主处理原生动作；返回作品库隐藏原编辑窗口，继续编辑复用同一草稿。关闭才结束窗口与引擎。语言同步先订阅再读取，迟到的读取/保存结果不覆盖新通知；超时允许重试并中止未完成请求，已提交选择以实际通知为准。普通网页重新读取当前 localStorage，同步删除与清空事件。

## 4. 完整业务枚举

节点名称可跳到后面的职责与代码表。同一业务中的数据节点表示读取或写入落点，具体副作用和条件以文字为准。

### 作品库与桌面

<a id="f01"></a>

#### F01 · 启动与最近作品

入口：启动桌面应用。

[Tauri 桌面宿主](#node-host) → [作品库首页](#node-library) → [原生语言偏好](#node-native_language) → [本机配置与最近作品](#node-local_config) → [作品库首页](#node-library)

先订阅语言通知，再读取版本、语言、最近作品与活动窗口状态；启动中的旧读取不会覆盖新选择。 未打开项目时不会启动该作品的 Node 服务。

已有验证入口：[scripts/tests/i18n.test.mjs](../scripts/tests/i18n.test.mjs)、[desktop/tests/native-smoke.py](../desktop/tests/native-smoke.py)、[scripts/tests/settings.test.mjs](../scripts/tests/settings.test.mjs)、[src-tauri/src/lib.rs](../src-tauri/src/lib.rs)。

<a id="f02"></a>

#### F02 · 新建空白项目

入口：作品库 → 新建作品库。

[作品库首页](#node-library) → [Tauri 桌面宿主](#node-host) → [原生作品与归档](#node-native_workspace) → [项目清单](#node-manifest) → [项目模板](#node-templates) → [原始正文](#node-documents) → [素材原文件](#node-assets) → [本机配置与最近作品](#node-local_config)

创建通用 v3 目录、六个默认类型/模板，登记最近作品。 已有编辑窗口时，首页禁用入口，宿主在原生选择器、写文件及登记前拒绝切换。正文初始为空；取消原生目录选择不创建项目。

已有验证入口：[scripts/tests/generic-project.test.mjs](../scripts/tests/generic-project.test.mjs)、[src-tauri/src/workspace.rs](../src-tauri/src/workspace.rs)、[desktop/tests/native-library.py](../desktop/tests/native-library.py)、[scripts/tests/desktop-library.test.mjs](../scripts/tests/desktop-library.test.mjs)。

<a id="f03"></a>

#### F03 · 选择已有作品

入口：作品库 → 打开已有文件夹。

[作品库首页](#node-library) → [Tauri 桌面宿主](#node-host) → [原生作品与归档](#node-native_workspace) → [项目清单](#node-manifest) → [本机配置与最近作品](#node-local_config)

验证/兼容已有作品并记录位置，然后进入打开链路。 已有编辑窗口时，首页禁用入口，宿主在原生选择器、写文件及登记前拒绝切换。兼容 v1/v2/v3；不把旧作品强行搬为新目录。

已有验证入口：[scripts/tests/desktop-workspace.test.mjs](../scripts/tests/desktop-workspace.test.mjs)、[src-tauri/src/workspace.rs](../src-tauri/src/workspace.rs)、[desktop/tests/native-library.py](../desktop/tests/native-library.py)、[scripts/tests/desktop-library.test.mjs](../scripts/tests/desktop-library.test.mjs)。

<a id="f04"></a>

#### F04 · 打开作品和启动引擎

入口：最近作品 → 打开。

[作品库首页](#node-library) → [Tauri 桌面宿主](#node-host) → [桌面内置服务启动](#node-boot) → [文档与素材登记](#node-registry) → [标准化与索引重建编排](#node-rebuild) → [编辑 HTTP 服务](#node-edit_server) → [桌面会话与事件桥](#node-session) → [编辑器状态与导航](#node-editor)

获取 .viento/session.lock；登记、重建，等待 ready 事件后打开随机本机端口。 已有编辑窗口时先结束当前会话；启动前即监听宿主退出，失败或关闭时停止并回收索引进程。

已有验证入口：[desktop/tests/native-smoke.py](../desktop/tests/native-smoke.py)、[scripts/tests/workspace-layout.test.mjs](../scripts/tests/workspace-layout.test.mjs)、[scripts/tests/desktop-workspace.test.mjs](../scripts/tests/desktop-workspace.test.mjs)、[desktop/tests/native-library.py](../desktop/tests/native-library.py)、[scripts/tests/desktop-library.test.mjs](../scripts/tests/desktop-library.test.mjs)。

<a id="f05"></a>

#### F05 · 打开系统文件夹

入口：最近作品 → 文件夹。

[作品库首页](#node-library) → [Tauri 桌面宿主](#node-host) → [原始正文](#node-documents)

由原生 opener 展示已经登记的作品目录。 输入路径必须属于最近作品登记；不是任意路径执行入口。

已有验证入口：[src-tauri/src/lib.rs](../src-tauri/src/lib.rs)。

<a id="f06"></a>

#### F06 · 返回作品库与继续编辑

入口：编辑器 → 作品库；作品库 → 继续编辑。

[编辑器状态与导航](#node-editor) → [桌面会话与事件桥](#node-session) → [Tauri 桌面宿主](#node-host) → [作品库首页](#node-library) → [Tauri 桌面宿主](#node-host) → [编辑器状态与导航](#node-editor) → [当前窗口草稿与状态](#node-memory)

隐藏/显示原有窗口，保留当前草稿与子进程。 这不是关闭项目，也不自动保存草稿。

已有验证入口：[desktop/tests/native-smoke.py](../desktop/tests/native-smoke.py)、[desktop/tests/native-library.py](../desktop/tests/native-library.py)。

<a id="f07"></a>

#### F07 · 关闭编辑窗口或退出

入口：关闭编辑窗口 / 原生关闭按钮。

[Tauri 桌面宿主](#node-host) → [编辑器状态与导航](#node-editor) → [当前窗口草稿与状态](#node-memory) → [桌面会话与事件桥](#node-session) → [Tauri 桌面宿主](#node-host) → [桌面内置服务启动](#node-boot) → [Tauri 桌面宿主](#node-host)

带请求 ID 读取忙碌与正文/模板草稿状态；有草稿时由宿主原生确认，批准后关闭窗口，等待引擎回收索引进程再释放会话锁。 原生确认按钮跟随应用语言，明确区分继续编辑与关闭并丢弃。 状态查询 5 秒无响应或界面不完整时提供原生恢复确认，不自动丢弃。用户确认不超时；迟到回复无效，取消恢复输入，确认期间禁止新文件操作。

已有验证入口：[desktop/tests/native-smoke.py](../desktop/tests/native-smoke.py)、[scripts/tests/desktop-close.test.mjs](../scripts/tests/desktop-close.test.mjs)、[scripts/tests/desktop-workspace.test.mjs](../scripts/tests/desktop-workspace.test.mjs)、[src-tauri/src/close_state.rs](../src-tauri/src/close_state.rs)、[src-tauri/src/lib.rs](../src-tauri/src/lib.rs)、[desktop/tests/native-library.py](../desktop/tests/native-library.py)。

<a id="f08"></a>

#### F08 · 导入完整项目包

入口：作品库 → 导入迁移包。

[作品库首页](#node-library) → [Tauri 桌面宿主](#node-host) → [原生作品与归档](#node-native_workspace) → [完整项目迁移包](#node-archive) → [项目清单](#node-manifest) → [原始正文](#node-documents) → [项目模板](#node-templates) → [文档元数据](#node-document_meta) → [素材元数据](#node-asset_meta) → [素材原文件](#node-assets) → [本机配置与最近作品](#node-local_config)

先检查每层路径及 ZIP 清单，逐文件校验实际内容后核对登记的正文、素材指纹和绑定，再保留新恢复目录。 已有编辑窗口时，首页禁用入口，宿主在原生选择器、写文件及登记前拒绝切换。只接受迁移格式；拒绝链接、大小写/Unicode 及文件目录冲突、未声明条目或不一致登记；失败清理本次恢复目录。 在保留恢复目录之前按编辑器约定检查文档类型、解析方式、关系目标/重复/循环及素材字段和旧路径别名；校验和正确的损坏登记也拒绝，原目录及已有作品保持不变。

已有验证入口：[src-tauri/src/workspace.rs](../src-tauri/src/workspace.rs)、[desktop/tests/native-smoke.py](../desktop/tests/native-smoke.py)、[scripts/tests/export.test.mjs](../scripts/tests/export.test.mjs)、[desktop/tests/native-library.py](../desktop/tests/native-library.py)、[scripts/tests/desktop-library.test.mjs](../scripts/tests/desktop-library.test.mjs)、[scripts/tests/archive-registry.test.mjs](../scripts/tests/archive-registry.test.mjs)。

<a id="f09"></a>

#### F09 · 作品库导出备份

入口：最近作品 → 导出备份。

[作品库首页](#node-library) → [Tauri 桌面宿主](#node-host) → [原生作品与归档](#node-native_workspace) → [原始正文](#node-documents) → [项目模板](#node-templates) → [文档元数据](#node-document_meta) → [素材元数据](#node-asset_meta) → [素材原文件](#node-assets) → [完整项目迁移包](#node-archive)

Rust 写入前固定文件快照与素材根，流式打包并核对正文/素材登记、内容指纹，复查文件与配置后原子发布。 活动编辑窗口不妨碍备份已保存内容；取消或失败后可重试，其他项目入口仍保持禁用。与 Node 整库导出独立实现；不包含未保存草稿、缓存或本机绑定。拒绝跨系统路径冲突和缺失内容，失败保留旧备份。 原生备份同样拒绝编辑器不可读的登记，失败保留原备份，修正后可重新生成。共享归属、一般引用、旧可选字段、未知素材指纹和同一素材重复别名继续兼容。

已有验证入口：[src-tauri/src/workspace.rs](../src-tauri/src/workspace.rs)、[scripts/tests/export.test.mjs](../scripts/tests/export.test.mjs)、[desktop/tests/native-library.py](../desktop/tests/native-library.py)、[scripts/tests/desktop-library.test.mjs](../scripts/tests/desktop-library.test.mjs)、[scripts/tests/archive-registry.test.mjs](../scripts/tests/archive-registry.test.mjs)。

### 浏览与导航

<a id="f10"></a>

#### F10 · 探测编辑能力和切换模式

入口：编辑器加载 / 浏览、编辑按钮。

[编辑器状态与导航](#node-editor) → [浏览器请求层](#node-request) → [业务接口分发](#node-router) → [文档服务](#node-doc_service) → [编辑器状态与导航](#node-editor)

探测完整 capabilities 路径清单及 project 能力，失败时尝试 health，决定编辑与新建是否可用。 浏览服务不提供写正文 API；浏览器模式选择不能突破后端能力。 语言刷新沿用后端可编辑性，禁用状态与辅助技术提示一致。

已有验证入口：[scripts/tests/doc-api.test.mjs](../scripts/tests/doc-api.test.mjs)、[scripts/tests/editor-runtime.test.mjs](../scripts/tests/editor-runtime.test.mjs)、[scripts/tests/editor-language.test.mjs](../scripts/tests/editor-language.test.mjs)。

<a id="f11"></a>

#### F11 · 加载索引与重试

入口：首次加载 / 重新加载按钮。

[编辑器状态与导航](#node-editor) → [浏览器请求层](#node-request) → [受限文件与素材服务](#node-static) → [标准缓存与索引](#node-cache) → [编辑器状态与导航](#node-editor) → [请求诊断与恢复](#node-diagnostics)

浏览与编辑均依次读取页面相对 data/index.json、/web/data/index.json、/data/index.json，去重并重试；不是 /api/index。 防止迟到响应覆盖新会话；替换前校验索引，失败保留上一次可用的列表与项目状态。 编辑会话按源路径匹配新条目；找不到当前源文件时拒绝整个目录和配置替换，保留当前编辑状态并提示重试。 筛选结果为空时也刷新当前编辑文档，显示层接收最新目录条目。 语言切换保留并翻译当前加载或失败状态及重试入口，成功后恢复目录；旧请求的迟到错误不改变新状态。

已有验证入口：[scripts/tests/call-paths.test.mjs](../scripts/tests/call-paths.test.mjs)、[scripts/tests/request-lifecycle.test.mjs](../scripts/tests/request-lifecycle.test.mjs)、[scripts/tests/editor-runtime.test.mjs](../scripts/tests/editor-runtime.test.mjs)、[scripts/tests/editor-index-refresh.test.mjs](../scripts/tests/editor-index-refresh.test.mjs)、[scripts/tests/editor-filtering.test.mjs](../scripts/tests/editor-filtering.test.mjs)、[scripts/tests/editor-language.test.mjs](../scripts/tests/editor-language.test.mjs)。

<a id="f12"></a>

#### F12 · 分类、搜索与列表

入口：类别标签 / 搜索 / 清空搜索。

[编辑器状态与导航](#node-editor) → [当前窗口草稿与状态](#node-memory) → [编辑器状态与导航](#node-editor)

在已载入且带归属关系的展示索引中筛选、自定义类别计数、分组与分批渲染。 不写磁盘；附属故事按归属展示，不重复列成顶层独立条目。 编辑、新建或读取中筛选只更新列表，保留当前文档；浏览模式仍按结果自动选中。自动刷新保留窄窗口侧栏，明确点选文档才收起。 缩略图允许文件名、目录名内部的连续点，仍拒绝父目录跳转和不受支持的来源。

已有验证入口：[scripts/tests/generic-project.test.mjs](../scripts/tests/generic-project.test.mjs)、[scripts/tests/document-model.test.mjs](../scripts/tests/document-model.test.mjs)、[scripts/tests/editor-filtering.test.mjs](../scripts/tests/editor-filtering.test.mjs)、[scripts/tests/image-display.test.mjs](../scripts/tests/image-display.test.mjs)。

<a id="f13"></a>

#### F13 · 文档详情与卡片

入口：点击文档。

[编辑器状态与导航](#node-editor) → [通用布局与内容渲染](#node-render) → [图片、视频与音频控件](#node-media_render) → [受限文件与素材服务](#node-static) → [素材原文件](#node-assets)

优先展示通用 layout 的标题、字段、正文、表格和媒体。 缺少通用 layout 时有 legacy_ui 回退；旧展示路径重名时按文档 ID 或源路径区分，归属链接随之更新。 封面、图库、列表和旧技能图统一编码原始文件名，支持 #、% 与连续点；缺图按候选顺序回退到名称头像，通用类型无需旧英雄占位路径。 媒体读取失败时提供单个资源的重试入口；图片或音视频成功加载后清除旧错误及按钮，失败重试不影响其他控件。 JSON/YAML 顶层列表和字符串与嵌套字段共用值渲染，媒体按出现顺序显示；空对象和空列表明确显示为 {}、[]，零值、false 和 null 保留。

已有验证入口：[scripts/tests/structured-render.test.mjs](../scripts/tests/structured-render.test.mjs)、[scripts/tests/media.test.mjs](../scripts/tests/media.test.mjs)、[scripts/tests/image-display.test.mjs](../scripts/tests/image-display.test.mjs)、[scripts/tests/media-loading.test.mjs](../scripts/tests/media-loading.test.mjs)、[scripts/tests/media-preview-content.test.mjs](../scripts/tests/media-preview-content.test.mjs)、[scripts/tests/structured-values.test.mjs](../scripts/tests/structured-values.test.mjs)。

<a id="f14"></a>

#### F14 · 角色背景与附属故事

入口：档案内背景 / 上级与子文档链接。

[文档元数据](#node-document_meta) → [文档归属关系](#node-hierarchy) → [文档/素材/引用索引](#node-index) → [编辑器状态与导航](#node-editor) → [原始正文](#node-documents)

part-of 元数据生成 owners/ownedDocuments，导航到实际子文档编辑。 支持多层及共享归属；环路/无效关系被校验；归属修改尚无专门图形编辑器。 通过明确映射补充共享归属后重建，多个父档案仍指向同一份背景源文。

已有验证入口：[scripts/tests/document-model.test.mjs](../scripts/tests/document-model.test.mjs)、[desktop/tests/native-smoke.py](../desktop/tests/native-smoke.py)、[scripts/tests/export.test.mjs](../scripts/tests/export.test.mjs)、[scripts/tests/document-migration.test.mjs](../scripts/tests/document-migration.test.mjs)。

### 正文编辑

<a id="f15"></a>

#### F15 · 读取原文并开始编辑

入口：开始编辑。

[编辑器状态与导航](#node-editor) → [浏览器请求层](#node-request) → [业务接口分发](#node-router) → [文档服务](#node-doc_service) → [文档文件事务](#node-file_store) → [原始正文](#node-documents) → [源码与区块草稿](#node-draft) → [当前窗口草稿与状态](#node-memory)

读取文件原文与内容指纹版本，建立草稿基线。 使用源文件而非展示索引还原正文；源读取失败不会把展示内容当成权威稿。客户端原样传回版本标记。 最新原文和编辑基线就绪后触发素材预览，无需额外输入。 原文请求在更新缓存之前核对代次、模式、当前源路径及索引对象；失效请求不进入编辑，当前失败保留旧内容，合法空正文可重新读取。 原文读取期间的搜索和分类切换不自动切走选中文档，读取完成后继续进入原编辑会话。 语言切换不取消或重新发起原文读取，结果仍进入原编辑会话。

已有验证入口：[scripts/tests/editor-runtime.test.mjs](../scripts/tests/editor-runtime.test.mjs)、[scripts/tests/metadata-conversion.test.mjs](../scripts/tests/metadata-conversion.test.mjs)、[scripts/tests/editor-dialogs.test.mjs](../scripts/tests/editor-dialogs.test.mjs)、[scripts/tests/editor-filtering.test.mjs](../scripts/tests/editor-filtering.test.mjs)、[scripts/tests/editor-language.test.mjs](../scripts/tests/editor-language.test.mjs)。

<a id="f16"></a>

#### F16 · 新建文档并选模板

入口：新建文档 → 选择类型和路径。

[编辑器状态与导航](#node-editor) → [项目类型解析契约](#node-types) → [浏览器请求层](#node-request) → [受限文件与素材服务](#node-static) → [项目模板](#node-templates) → [源码与区块草稿](#node-draft) → [当前窗口草稿与状态](#node-memory)

优先加载项目模板并建议安全的文件名、目录和扩展名；界面与服务共用新建路径校验。 模板读取失败明确提示空模板；重试成功恢复正常提示。选定类型不会因为更换保存目录而丢失。 模板加载期间先比较草稿路径和文档类型，立即清除上一份预览。 只有当前模板请求可更新正文、缓存和错误状态；取消后的旧请求也不能执行后续新建收尾。 模板加载及新建草稿期间可筛选目录，不因自动选中触发放弃确认或改变草稿路径/类型。 内置类型名称原位翻译，项目自定义名称保持原文；语言变化不重发模板请求或改动草稿路径和所选类型。 请求按路径组成部分编码模板文件名，避免片段与百分号读错文件；文本响应保留 UTF-8 BOM，沿用请求超时和取消。

已有验证入口：[scripts/tests/templates.test.mjs](../scripts/tests/templates.test.mjs)、[scripts/tests/generic-project.test.mjs](../scripts/tests/generic-project.test.mjs)、[scripts/tests/editor-runtime.test.mjs](../scripts/tests/editor-runtime.test.mjs)、[scripts/tests/project-engine.test.mjs](../scripts/tests/project-engine.test.mjs)、[scripts/tests/editor-dialogs.test.mjs](../scripts/tests/editor-dialogs.test.mjs)、[scripts/tests/editor-filtering.test.mjs](../scripts/tests/editor-filtering.test.mjs)、[scripts/tests/editor-language.test.mjs](../scripts/tests/editor-language.test.mjs)、[scripts/tests/template-http.test.mjs](../scripts/tests/template-http.test.mjs)。

<a id="f17"></a>

#### F17 · 源码与区块往返

入口：源码 / 区块按钮。

[编辑器状态与导航](#node-editor) → [当前窗口草稿与状态](#node-memory) → [源码与区块草稿](#node-draft) → [当前窗口草稿与状态](#node-memory) → [编辑器状态与导航](#node-editor)

区块来自当前源码草稿，序列化时只替换改动片段。 不是把解析后的字段对象整体重写为源文；JSON/YAML 等不适用的模式受 UI 限制。 媒体未改变时复用播放器，不因编辑方式切换中断播放。

已有验证入口：[scripts/tests/editor-draft.test.mjs](../scripts/tests/editor-draft.test.mjs)、[scripts/tests/editor-runtime.test.mjs](../scripts/tests/editor-runtime.test.mjs)、[scripts/tests/editor-dialogs.test.mjs](../scripts/tests/editor-dialogs.test.mjs)。

<a id="f18"></a>

#### F18 · 保存已有文档

入口：保存 / Ctrl或Cmd+S、Enter。

[编辑器状态与导航](#node-editor) → [源码与区块草稿](#node-draft) → [浏览器请求层](#node-request) → [业务接口分发](#node-router) → [文档服务](#node-doc_service) → [文档文件事务](#node-file_store) → [原始正文](#node-documents) → [标准化与索引重建编排](#node-rebuild) → [文档/素材/引用索引](#node-index) → [编辑器状态与导航](#node-editor)

校验 expectedVersion 与当前正文内容指纹，原子保存原文，失效服务缓存，再重建和重新载入。 保留文件时间的外部修改也会触发冲突；旧时间戳普通请求需重新读取。源文件保存和重建是两个阶段；重建或索引读取失败时明确报错，已保存正文继续可编辑并允许重试。 独立短临时文件名避免合法长名称在保存时超限。 保存过程中媒体未改变时保留现有播放器及源文件 BOM、换行和引用。 HTTP 401/403 正常报告权限或令牌问题；失败保留原版本和源码/区块草稿，修改后重试仍执行版本校验。 重新编辑并保存后，迟到的旧读取不能回退窗口内正文缓存与版本。 刷新目录不会把同一条目标识上的旧草稿改绑到另一源文件；保存与刷新并行时仍保留成功保存的正文和版本。 保存后的内容不再匹配搜索时仍保留重建后的编辑会话、输入模式、完整正文与当前版本。 语言切换期间保持保存锁定，实际禁用状态与辅助技术提示一致；完成后解锁，重复保存与模式切换仍受拦截。 开始保存会立即取消仍在读取的旧素材预览，保存与重建完成后按当前草稿安排新预览；请求取消不改写保存内容或重建已有播放器。

已有验证入口：[scripts/tests/doc-api.test.mjs](../scripts/tests/doc-api.test.mjs)、[scripts/tests/editor-runtime.test.mjs](../scripts/tests/editor-runtime.test.mjs)、[scripts/tests/call-paths.test.mjs](../scripts/tests/call-paths.test.mjs)、[scripts/tests/creation-workflow.test.mjs](../scripts/tests/creation-workflow.test.mjs)、[scripts/tests/editor-dialogs.test.mjs](../scripts/tests/editor-dialogs.test.mjs)、[scripts/tests/editor-index-refresh.test.mjs](../scripts/tests/editor-index-refresh.test.mjs)、[scripts/tests/editor-filtering.test.mjs](../scripts/tests/editor-filtering.test.mjs)、[scripts/tests/editor-language.test.mjs](../scripts/tests/editor-language.test.mjs)、[scripts/tests/media-preview-requests.test.mjs](../scripts/tests/media-preview-requests.test.mjs)、[scripts/tests/media-preview-parsing.test.mjs](../scripts/tests/media-preview-parsing.test.mjs)、[scripts/tests/media-preview-content.test.mjs](../scripts/tests/media-preview-content.test.mjs)、[scripts/tests/structured-values.test.mjs](../scripts/tests/structured-values.test.mjs)。

<a id="f19"></a>

#### F19 · 保存新文档

入口：新建草稿 → 保存。

[编辑器状态与导航](#node-editor) → [浏览器请求层](#node-request) → [业务接口分发](#node-router) → [文档服务](#node-doc_service) → [新文档身份登记](#node-create_doc) → [文档元数据](#node-document_meta) → [文档文件事务](#node-file_store) → [原始正文](#node-documents) → [标准化与索引重建编排](#node-rebuild) → [编辑器状态与导航](#node-editor)

在登记锁内重新读取类型、检查可迁移位置冲突，再建立 UUID 并独占创建源文件。 保护大小写/Unicode 等价名称、父目录和缺失源文件的登记身份；失败回滚本次登记，保存成功后即作为已有文档继续编辑。 成功创建返回内容版本，后续保存沿用同一校验。 合法 255 字节文件名可以新建、再次保存和刷新预览，身份与权限保持完整。 取消重试与手动更换扩展名后的保存使用当前路径、类型和源字节，模板缓存保留最新接受的内容。 自动补后缀后同步最终草稿路径和预览上下文，并再次检查文件名长度；重名失败可换名重试，保留原正文、登记及所选类型。 首次获得目录标识时承接已保存的完整正文与版本，退出后不回退为展示摘要。 来自真实 HTTP 模板的 BOM 与换行在五种格式的新建、索引和原文重开中保持一致，清单规则与所选类型继续生效。 采用共享定义后，v2/v3 的自动生成 Markdown 模板可通过真实接口新建、重开和重建；清单中的标题与字段分组也用于 HTML 导出。

已有验证入口：[scripts/tests/generic-project.test.mjs](../scripts/tests/generic-project.test.mjs)、[scripts/tests/editor-runtime.test.mjs](../scripts/tests/editor-runtime.test.mjs)、[scripts/tests/creation-workflow.test.mjs](../scripts/tests/creation-workflow.test.mjs)、[scripts/tests/editor-dialogs.test.mjs](../scripts/tests/editor-dialogs.test.mjs)、[scripts/tests/editor-index-refresh.test.mjs](../scripts/tests/editor-index-refresh.test.mjs)、[scripts/tests/template-http.test.mjs](../scripts/tests/template-http.test.mjs)、[scripts/tests/project-definition.test.mjs](../scripts/tests/project-definition.test.mjs)。

<a id="f20"></a>

#### F20 · 处理保存冲突

入口：保存返回 409。

[文档服务](#node-doc_service) → [浏览器请求层](#node-request) → [编辑器状态与导航](#node-editor) → [当前窗口草稿与状态](#node-memory) → [文档文件事务](#node-file_store)

选择读取最新、保留草稿、明确强制覆盖或取消。 强制覆盖需要二次确认；只有保存或读取最新正文成功后更新基线。强制写入失败仍保留原版本，普通重试重新检查冲突；读取失败保留错误、草稿和区块模式。 索引替换条目后失效的重读保留合并草稿和原基线；再次读取当前条目成功后才替换内容。 语言变化只更新冲突文案，保留待选决定、版本及强制覆盖警示；取消不写入文件。

已有验证入口：[scripts/tests/doc-api.test.mjs](../scripts/tests/doc-api.test.mjs)、[scripts/tests/editor-runtime.test.mjs](../scripts/tests/editor-runtime.test.mjs)、[scripts/tests/editor-language.test.mjs](../scripts/tests/editor-language.test.mjs)。

<a id="f21"></a>

#### F21 · 取消、切换与未保存保护

入口：取消编辑 / 切文档 / 切模式 / 刷新或关窗。

[编辑器状态与导航](#node-editor) → [当前窗口草稿与状态](#node-memory) → [编辑器状态与导航](#node-editor)

检测内容及新建路径差异，保留或明确丢弃草稿。 浏览器 beforeunload 和桌面关闭链路也查看脏状态；不提供磁盘自动草稿恢复。 空项目首份草稿也执行退出清理；取消确认保留草稿，确认退出则暂停音视频、隐藏预览并失效旧响应。 迟到模板请求不能污染缓存、误报当前错误，或重置新草稿的光标、滚动及未保存状态。 选择文档的后台原文读取也服从退出状态，迟到响应不能重新填回已清空的编辑区。 目录刷新保留源码/区块草稿的未保存状态；明确放弃后只恢复最后读取或保存的正文，不把草稿写入原文缓存。 搜索和分类变化不触发放弃草稿确认；明确点击另一份文档仍按原规则询问和切换。 退出编辑、移除素材或更换草稿路径/类型时，同时停止过期的预览读取，不必等待响应或超时；迟到清理不能取消新请求。

已有验证入口：[scripts/tests/editor-runtime.test.mjs](../scripts/tests/editor-runtime.test.mjs)、[desktop/tests/native-smoke.py](../desktop/tests/native-smoke.py)、[scripts/tests/editor-dialogs.test.mjs](../scripts/tests/editor-dialogs.test.mjs)、[scripts/tests/editor-index-refresh.test.mjs](../scripts/tests/editor-index-refresh.test.mjs)、[scripts/tests/editor-filtering.test.mjs](../scripts/tests/editor-filtering.test.mjs)、[scripts/tests/media-preview-requests.test.mjs](../scripts/tests/media-preview-requests.test.mjs)、[scripts/tests/media-preview-parsing.test.mjs](../scripts/tests/media-preview-parsing.test.mjs)。

<a id="f22"></a>

#### F22 · 手动刷新预览与局部重建

入口：刷新预览。

[编辑器状态与导航](#node-editor) → [浏览器请求层](#node-request) → [业务接口分发](#node-router) → [文档服务](#node-doc_service) → [标准化与索引重建编排](#node-rebuild) → [原文标准化](#node-standardize) → [文档/素材/引用索引](#node-index) → [编辑器状态与导航](#node-editor)

按选定源范围更新标准缓存，再生成全库索引。 完整文件名和目录范围精确重建、按 source.path 清理；后续索引读取失败也视为刷新失败，保留已保存内容和可用列表。 授权拒绝不会导致错误处理自身抛错；保存已成功时保持干净基线，单独重试重建不重复写正文。 重建返回的目录缺少当前编辑文件时明确报告失败，保留列表、项目配置及已保存基线；恢复后可独立重试目录刷新。

已有验证入口：[scripts/tests/call-paths.test.mjs](../scripts/tests/call-paths.test.mjs)、[scripts/tests/build.test.mjs](../scripts/tests/build.test.mjs)、[scripts/tests/editor-runtime.test.mjs](../scripts/tests/editor-runtime.test.mjs)、[scripts/tests/editor-index-refresh.test.mjs](../scripts/tests/editor-index-refresh.test.mjs)。

### 类型与模板

<a id="f23"></a>

#### F23 · 读取项目类型和模板

入口：顶部 / 设置 → 项目类型与模板。

[项目类型与模板窗口](#node-project_ui) → [浏览器请求层](#node-request) → [业务接口分发](#node-router) → [文档服务](#node-doc_service) → [项目配置与模板服务](#node-project_service) → [项目清单](#node-manifest) → [项目模板](#node-templates) → [项目类型与模板窗口](#node-project_ui)

加载类型、模板原文、字段规则、warnings 和 revision。 已有文档草稿或忙碌操作必须先结束；读取不保存模板，旧的无效默认目录显示问题并允许修正。 版本标记从生成响应所用的同一份清单计算，读取边界发生外部修改时不会把新标记配给旧类型或规则。

已有验证入口：[scripts/tests/project-engine.test.mjs](../scripts/tests/project-engine.test.mjs)、[scripts/tests/project-snapshot.test.mjs](../scripts/tests/project-snapshot.test.mjs)。

<a id="f24"></a>

#### F24 · 预览模板解析

入口：预览解析结果。

[项目类型与模板窗口](#node-project_ui) → [浏览器请求层](#node-request) → [业务接口分发](#node-router) → [项目配置与模板服务](#node-project_service) → [共享文档解析器](#node-parser) → [共享布局生成器](#node-layout) → [通用布局与内容渲染](#node-render)

使用与文档相同的解析器和布局生成器展示当前表单内容，同时按新建路径规则校验默认目录。 只读预览；保留原始模板的换行格式和 BOM，格式或默认目录错误保留表单并显示错误。 顶层列表、标量与空容器沿用正文的通用渲染；真实 HTTP 预览与保存重建后的布局保持一致。

已有验证入口：[scripts/tests/project-engine.test.mjs](../scripts/tests/project-engine.test.mjs)、[scripts/tests/editor-dialogs.test.mjs](../scripts/tests/editor-dialogs.test.mjs)、[scripts/tests/structured-values.test.mjs](../scripts/tests/structured-values.test.mjs)。

<a id="f25"></a>

#### F25 · 保存类型、模板与规则

入口：保存并应用。

[项目类型与模板窗口](#node-project_ui) → [浏览器请求层](#node-request) → [业务接口分发](#node-router) → [文档服务](#node-doc_service) → [项目配置与模板服务](#node-project_service) → [项目模板](#node-templates) → [项目清单](#node-manifest) → [标准化与索引重建编排](#node-rebuild) → [文档/素材/引用索引](#node-index) → [编辑器状态与导航](#node-editor)

revision、默认目录及新增标识校验 → 保留模板源格式 → 写指纹模板 → 原子更新清单 → 重建。 新增不能覆盖已有类型，失败保留草稿；正常编辑兼容旧调用。旧正文/UUID/归属不重写；重建失败给 indexWarning，返回时索引读取失败保留窗口供重试。 读取期间发生外部清单更新时，旧表单返回版本冲突，不写入模板；重新读取后可以保留外部规则继续保存。

已有验证入口：[scripts/tests/project-engine.test.mjs](../scripts/tests/project-engine.test.mjs)、[desktop/tests/native-smoke.py](../desktop/tests/native-smoke.py)、[scripts/tests/editor-dialogs.test.mjs](../scripts/tests/editor-dialogs.test.mjs)、[scripts/tests/editor-runtime.test.mjs](../scripts/tests/editor-runtime.test.mjs)、[scripts/tests/project-snapshot.test.mjs](../scripts/tests/project-snapshot.test.mjs)。

<a id="f26"></a>

#### F26 · 取消新增、放弃修改与返回

入口：取消新增 / 放弃修改 / 返回编辑器 / Esc。

[项目类型与模板窗口](#node-project_ui) → [当前窗口草稿与状态](#node-memory) → [项目类型与模板窗口](#node-project_ui) → [编辑器状态与导航](#node-editor)

取消新增回到上一个类型；放弃修改恢复最后保存内容；返回关闭窗口。 新增被拒后可改标识重试或取消；有未保存内容先确认，已保存配置保留。返回时等待新索引加载完成，期间保持编辑器忙碌。

已有验证入口：[desktop/tests/project_settings_navigation.py](../desktop/tests/project_settings_navigation.py)、[scripts/tests/editor-dialogs.test.mjs](../scripts/tests/editor-dialogs.test.mjs)。

### 素材

<a id="f27"></a>

#### F27 · 列出、筛选和复用素材

入口：插入素材 → 搜索或类型筛选。

[素材选择与草稿预览](#node-media_ui) → [浏览器请求层](#node-request) → [业务接口分发](#node-router) → [素材导入与清单](#node-media_service) → [文档与素材登记](#node-registry) → [素材元数据](#node-asset_meta) → [素材选择与草稿预览](#node-media_ui)

列出现有已登记图片、视频和音频，显示不可用状态并按类别筛选。 读取清单不等于重新登记；未引用的已导入文件仍属于作品素材。

已有验证入口：[scripts/tests/media.test.mjs](../scripts/tests/media.test.mjs)、[desktop/tests/native-smoke.py](../desktop/tests/native-smoke.py)。

<a id="f28"></a>

#### F28 · 导入、粘贴和拖入媒体

入口：从电脑导入 / 粘贴文件 / 拖入文件。

[素材选择与草稿预览](#node-media_ui) → [浏览器请求层](#node-request) → [业务接口分发](#node-router) → [素材导入与清单](#node-media_service) → [文档与素材登记](#node-registry) → [素材原文件](#node-assets) → [素材元数据](#node-asset_meta) → [素材选择与草稿预览](#node-media_ui)

流式上传 → 格式/体积检测 → SHA-256 去重 → UUID 位置 → 登记。 单文件上限 256 MiB；中断清理本次临时文件；取消也终止草稿补丁请求，已成功登记的素材保留在列表。 上传途中素材根变化时，持锁提交返回 409 并清理临时文件；重新导入使用当前素材根。 分块拖放优先捕获接收文件的文本框及其选择范围，不用其他段仍保留的焦点覆盖目标；无文本框目标时沿用当前编辑位置。取消后复用已导入素材仍保留该目标。 批量导入部分失败或取消后，直接合并已成功登记的摘要，按稳定 ID 去重并清除旧筛选、重置分页；恢复不再等待完整列表请求，立即解除忙碌状态。

已有验证入口：[scripts/tests/media.test.mjs](../scripts/tests/media.test.mjs)、[desktop/tests/native-smoke.py](../desktop/tests/native-smoke.py)、[scripts/tests/editor-dialogs.test.mjs](../scripts/tests/editor-dialogs.test.mjs)、[scripts/tests/request-lifecycle.test.mjs](../scripts/tests/request-lifecycle.test.mjs)、[scripts/tests/asset-binding.test.mjs](../scripts/tests/asset-binding.test.mjs)、[scripts/tests/media-drop.test.mjs](../scripts/tests/media-drop.test.mjs)、[scripts/tests/media-recovery.test.mjs](../scripts/tests/media-recovery.test.mjs)。

<a id="f29"></a>

#### F29 · 把媒体引用嵌入草稿

入口：选中已有素材 / 导入完成。

[素材选择与草稿预览](#node-media_ui) → [共享媒体引用格式](#node-media_format) → [结构化素材插入与预览](#node-media_insert) → [项目类型解析契约](#node-types) → [共享文档解析器](#node-parser) → [源码与区块草稿](#node-draft) → [当前窗口草稿与状态](#node-memory)

文本在光标写 ![] / !video[] / !audio[]；JSON/YAML 走源范围插入。 结构化插入保留缩进、BOM、注释、格式和值，支持缩进的行内列表及带指令/标记的空 YAML；显式数值、标签和锚点不覆盖。响应返回后重新核对取消状态和草稿，仍需保存正文。 素材窗口快速重开时，旧关闭事件不清除新目标或使新列表请求失效。实际编辑器与 HTTP 服务联合验证三类素材插入目标段、保存、重开和引用索引，保留其他段、BOM、CRLF 及素材字节。 部分导入或结构化插入准备失败时保持原草稿，允许重新选择已入库素材而无需再次上传。真实浏览器验证文件选择器、部分失败后复用、保存及重载；HTTP 回归核对唯一登记、原始字节和索引引用。 素材预览沿用同一通用解析器；JSON/YAML 解析失败返回格式错误，不作为成功的空素材结果。 插入后的预览保留嵌套字段和别名复用中的现有素材，用户 type: code 字段不作为代码示例过滤。

已有验证入口：[scripts/tests/media.test.mjs](../scripts/tests/media.test.mjs)、[scripts/tests/editor-dialogs.test.mjs](../scripts/tests/editor-dialogs.test.mjs)、[scripts/tests/media-drop.test.mjs](../scripts/tests/media-drop.test.mjs)、[scripts/tests/media-recovery.test.mjs](../scripts/tests/media-recovery.test.mjs)、[scripts/tests/media-preview-parsing.test.mjs](../scripts/tests/media-preview-parsing.test.mjs)、[scripts/tests/media-preview-content.test.mjs](../scripts/tests/media-preview-content.test.mjs)、[scripts/tests/structured-values.test.mjs](../scripts/tests/structured-values.test.mjs)。

<a id="f30"></a>

#### F30 · 草稿预览与播放

入口：读取原文 / 修改草稿或新建路径 / 播放、暂停、拖动进度。

[当前窗口草稿与状态](#node-memory) → [素材选择与草稿预览](#node-media_ui) → [浏览器请求层](#node-request) → [业务接口分发](#node-router) → [结构化素材插入与预览](#node-media_insert) → [共享文档解析器](#node-parser) → [素材选择与草稿预览](#node-media_ui) → [图片、视频与音频控件](#node-media_render) → [受限文件与素材服务](#node-static) → [素材原文件](#node-assets)

只从当前草稿提取媒体；本地 URL 提供图片或原生音视频播放与下载。 不自动播放；音频用 auto 预加载修复 Ogg 时长/跳转；离开/替换草稿预览会暂停播放器。 原文加载后自动刷新；忙碌期间也核对路径和类型，旧响应不覆盖当前预览；未变的媒体在源码/区块切换和保存时不重建。 手动修改新建路径也通知预览，按当前扩展名和类型重新解析，并使旧路径的响应失效。 保存自动补上的后缀也同步到预览上下文；创建被拒后仍按最终路径解析。 本地素材响应声明 no-store，避免网页响应缓存重复存放图片、音频和视频；继续支持分段请求，原文件不变。 失败素材可在原控件内重新加载，不改写脏草稿、光标或其他播放器；禁止自动循环重试和自动播放。真实浏览器验证 SVG/WAV/WebM 恢复、错误清除、保存及重载。 每次预览读取有独立取消信号；新输入先停止旧请求，再等待防抖。上传和结构化插入的取消互相隔离，临时失败保留已有播放器及草稿。实际 HTTP 和浏览器故障代理验证未完成响应关闭与后续恢复。 JSON/YAML/YML 不依赖原文关键字猜测：转义字段名正常解析，无效语法保留已有预览，合法删除引用才清空。真实 HTTP 和浏览器覆盖失败、修正、保存及重载。 有效说明按 caption → alt 与正文一致；嵌套自定义字段正常提取，仅过滤解析器代码块。YAML 别名按出现次数及顺序预览，只跳过递归环，最多显示前 100 项。真实浏览器验证嵌套别名的三处 SVG、说明修改及保存重载。

已有验证入口：[scripts/tests/media.test.mjs](../scripts/tests/media.test.mjs)、[desktop/tests/native-smoke.py](../desktop/tests/native-smoke.py)、[scripts/tests/editor-dialogs.test.mjs](../scripts/tests/editor-dialogs.test.mjs)、[scripts/tests/doc-api.test.mjs](../scripts/tests/doc-api.test.mjs)、[scripts/tests/media-loading.test.mjs](../scripts/tests/media-loading.test.mjs)、[scripts/tests/media-preview-requests.test.mjs](../scripts/tests/media-preview-requests.test.mjs)、[scripts/tests/media-preview-parsing.test.mjs](../scripts/tests/media-preview-parsing.test.mjs)、[scripts/tests/media-preview-content.test.mjs](../scripts/tests/media-preview-content.test.mjs)、[scripts/tests/structured-values.test.mjs](../scripts/tests/structured-values.test.mjs)。

<a id="f31"></a>

#### F31 · 稳定 ID 与元数据附件

入口：asset:UUID / assetBindings / 旧本地路径。

[共享媒体引用格式](#node-media_format) → [图片、视频与音频控件](#node-media_render) → [受限文件与素材服务](#node-static) → [文档与素材登记](#node-registry) → [素材元数据](#node-asset_meta) → [素材原文件](#node-assets)

稳定引用写法统一为小写 UUID 的 /asset-files/<UUID>，兼容 assets/ 与 legacyPaths；assetBindings 另进入登记、索引和导出附件清单。 裸 ID 与旧图片声明同时进入分享包；相对图片路径以原始正文目录为基准。 外置素材根由本机绑定解析；当前索引的附件图像补全只取 image，不能把绑定音视频视为正文自动播放器。 稳定 ID 与旧路径入口对普通读取、HEAD、条件请求和范围响应统一声明 no-store；内置与外置素材一致，普通程序模块仍保留验证缓存。 恢复仍请求原有的受限本地 URL，不重复上传或新增登记；真实 HTTP 验证文件缺失时连续 404，原文件恢复后 200，原始字节、登记、正文和索引保持完整。

已有验证入口：[scripts/tests/workspace-layout.test.mjs](../scripts/tests/workspace-layout.test.mjs)、[scripts/tests/media.test.mjs](../scripts/tests/media.test.mjs)、[scripts/tests/export.test.mjs](../scripts/tests/export.test.mjs)、[scripts/tests/doc-api.test.mjs](../scripts/tests/doc-api.test.mjs)、[scripts/tests/media-loading.test.mjs](../scripts/tests/media-loading.test.mjs)。

### 导出与迁移

<a id="f32"></a>

#### F32 · 导出文档阅读分享包

入口：导出 → 当前文档 → HTML / Markdown。

[编辑器导出窗口](#node-export_ui) → [浏览器请求层](#node-request) → [业务接口分发](#node-router) → [导出任务生命周期](#node-export_jobs) → [Node 导出规划与 ZIP](#node-export_pack) → [项目类型解析契约](#node-types) → [共享文档解析器](#node-parser) → [共享布局生成器](#node-layout) → [离线阅读格式](#node-export_render) → [导出暂存包](#node-export_cache) → [文档分享包](#node-share)

从已保存原文重新解析，递归携带附属文档、嵌入媒体、裸 ID、旧图片路径及附件素材；保留元数据、原始 sources 和故事章节层级，百分号名称与旧别名按索引规则解析。 不是完整项目恢复包；不把无关素材全部带入；未保存/新建草稿不能导出。 保存或重建忙碌时暂缓打开导出。 包内源路径按每层目录检查大小写/Unicode 及文件目录冲突。 未嵌入的引用列为关联素材，每篇文档按素材身份去重；未知 ID 或缺失文件失败后可修复重试。代码围栏与 YAML 注释仍排除。 ZIP 完成后的最后一次异步读取结束后，再检查取消状态才登记任务；取消的分享包立即清理，原文与素材保持不变。 取消或生成失败后若目录无法立即删除，保留已撤销的清理记录和名额，自动重试且不覆盖原来的取消/失败原因。 ZIP 写入使用统一停止状态，取消或写入失败后不接纳迟到的文件打开结果；已经开始的输入操作和实际关闭完成后才结束。 准备阶段将取消传入登记读取、目录扫描和正文读取；异步操作返回后先检查停止状态，迟到的坏正文不覆盖取消原因。 分享包通过多个成功分段收齐后，可在下一次导出时回收空闲任务；逐字节拼接和 ZIP 清单已回归核对。 嵌套媒体、alt 说明和别名复用与预览逐次对照；阅读内容保留重复出现，包内素材按身份去重，源文件和快照保持完整。 顶层及嵌套空对象、空列表明确保留为 {}、[]；Markdown 按正文规则转义，原始 sources 不改写。

已有验证入口：[scripts/tests/export.test.mjs](../scripts/tests/export.test.mjs)、[desktop/tests/native-smoke.py](../desktop/tests/native-smoke.py)、[scripts/tests/editor-dialogs.test.mjs](../scripts/tests/editor-dialogs.test.mjs)、[desktop/tests/native_export_workflow.py](../desktop/tests/native_export_workflow.py)、[scripts/tests/media.test.mjs](../scripts/tests/media.test.mjs)、[scripts/tests/export-cancellation.test.mjs](../scripts/tests/export-cancellation.test.mjs)、[scripts/tests/export-cleanup.test.mjs](../scripts/tests/export-cleanup.test.mjs)、[scripts/tests/export-streams.test.mjs](../scripts/tests/export-streams.test.mjs)、[scripts/tests/export-preparation.test.mjs](../scripts/tests/export-preparation.test.mjs)、[scripts/tests/export-downloads.test.mjs](../scripts/tests/export-downloads.test.mjs)、[scripts/tests/media-preview-content.test.mjs](../scripts/tests/media-preview-content.test.mjs)、[scripts/tests/structured-values.test.mjs](../scripts/tests/structured-values.test.mjs)。

<a id="f33"></a>

#### F33 · 编辑器导出完整项目包

入口：导出 → 完整项目包。

[编辑器导出窗口](#node-export_ui) → [浏览器请求层](#node-request) → [业务接口分发](#node-router) → [导出任务生命周期](#node-export_jobs) → [Node 导出规划与 ZIP](#node-export_pack) → [项目清单](#node-manifest) → [原始正文](#node-documents) → [项目模板](#node-templates) → [文档元数据](#node-document_meta) → [素材元数据](#node-asset_meta) → [素材原文件](#node-assets) → [导出暂存包](#node-export_cache) → [完整项目迁移包](#node-archive)

Node 生成与 Rust 导入兼容的 viento-archive，包含全部作品文件与外置素材；两端 v2/v3 往返逐文件核验。 独立于作品库 Rust 导出；本机配置/缓存排除，导出前后验证源快照。 保存或重建忙碌时暂缓打开导出。 每层目录及文件位置检查跨系统冲突。互通回归需显式配置原生归档测试二进制。 完整包同样在登记前核对取消；清理成功后释放相应暂存和名额。 b.3.8 发布已启用实际原生归档程序重跑 v2/v3 Node/Rust 往返，并核对两端登记契约、导入失败清理及合法共享背景的恢复和重建。 临时包清理失败时继续跟踪，不提前释放名额；原生成结果保留，清理恢复后可继续导出。 完整包记录可选目录和清单原本缺失的状态；首次新增素材、模板、元数据或恢复清单时，完成前报 409，重新生成才包含新增内容。缓存和无关文件不参与这项检查。 成功包也等待已开始的输入关闭；完整包和分享包共用停止状态、读取管线及关闭收尾。 素材递归扫描和最终复查支持取消；已经取消的创建在回收旧任务名额前退出，保留原来的已完成导出包。 完整项目包的分段下载同样累计成功区间，三个已收齐的任务不再阻塞下一次创建。

已有验证入口：[scripts/tests/export.test.mjs](../scripts/tests/export.test.mjs)、[desktop/tests/native-smoke.py](../desktop/tests/native-smoke.py)、[scripts/tests/editor-dialogs.test.mjs](../scripts/tests/editor-dialogs.test.mjs)、[desktop/tests/native_export_workflow.py](../desktop/tests/native_export_workflow.py)、[scripts/tests/export-cancellation.test.mjs](../scripts/tests/export-cancellation.test.mjs)、[scripts/tests/archive-registry.test.mjs](../scripts/tests/archive-registry.test.mjs)、[scripts/tests/export-cleanup.test.mjs](../scripts/tests/export-cleanup.test.mjs)、[scripts/tests/export-snapshot.test.mjs](../scripts/tests/export-snapshot.test.mjs)、[scripts/tests/export-streams.test.mjs](../scripts/tests/export-streams.test.mjs)、[scripts/tests/export-preparation.test.mjs](../scripts/tests/export-preparation.test.mjs)、[scripts/tests/export-downloads.test.mjs](../scripts/tests/export-downloads.test.mjs)。

<a id="f34"></a>

#### F34 · 下载与原生保存对话框

入口：导出完成 → 保存文件。

[编辑器导出窗口](#node-export_ui) → [桌面会话与事件桥](#node-session) → [Tauri 桌面宿主](#node-host) → [原生保存导出结果](#node-native_export) → [导出暂存包](#node-export_cache) → [文档分享包](#node-share)

桌面先按任务 ID 打开并持有已准备归档，再选择位置并复核、原子复制；网页直接 GET /api/export?id=… 下载。 保存窗口等待期间缓存路径被清理仍可完成当前保存；取消覆盖保留旧文件，普通保存错误可重选位置。明确过期的任务可在原窗口重新生成；编辑网页不获得任意原生文件访问。 多个网页下载持有同一包时，等最后一个读取结束才删除；删除故障不改变已完成的下载，也不覆盖读取中断原因。 每次保存生成独立请求标识，由桌面桥校验、宿主随成功/取消/错误结果回传；界面同时核对请求与导出包。断线后保存同一包时，旧回执不解除新等待，也不释放包。 成功 206 响应按实际 Content-Range 记录范围；重复/乱序合并，304、416、断开的响应不计入完成，不同任务相互隔离。 浏览器“下载文件”先通过现有 Range 接口核对一个字节，再创建临时下载链接；410 恢复重新生成，普通错误保留包供重试，核对不会缓冲整包或误判完整下载。

已有验证入口：[src-tauri/src/export.rs](../src-tauri/src/export.rs)、[desktop/tests/native-smoke.py](../desktop/tests/native-smoke.py)、[desktop/tests/native_export_workflow.py](../desktop/tests/native_export_workflow.py)、[scripts/tests/editor-dialogs.test.mjs](../scripts/tests/editor-dialogs.test.mjs)、[scripts/tests/export-cleanup.test.mjs](../scripts/tests/export-cleanup.test.mjs)、[scripts/tests/export-bridge.test.mjs](../scripts/tests/export-bridge.test.mjs)、[scripts/tests/export-downloads.test.mjs](../scripts/tests/export-downloads.test.mjs)、[scripts/tests/export-browser.test.mjs](../scripts/tests/export-browser.test.mjs)。

<a id="f35"></a>

#### F35 · 取消导出、释放与过期

入口：取消准备 / 关闭导出窗口 / 超时。

[编辑器导出窗口](#node-export_ui) → [浏览器请求层](#node-request) → [业务接口分发](#node-router) → [导出任务生命周期](#node-export_jobs) → [导出暂存包](#node-export_cache)

取消生成、释放或空闲过期可回收任务；已完整下载的闲置任务可让出额度，活动下载持有文件直至结束。 默认 15 分钟空闲过期；未完成、中断或活动下载不被额度回收。关闭重开时丢弃旧会话响应，迟到的旧包单独释放；原文与已保存备份保留。 原生保存持有已打开文件直到完成或取消；取消后再遇到 410 时清除失效任务，恢复生成入口。 写入器结束监听之后到任务登记之前的取消及 HTTP 断开也会清理暂存目录并解除生成锁，随后可重试生成、下载和释放。 删除成功后才移除任务并释放名额；并发释放等待同一次结果。临时删除失败时保留已撤销的任务，服务运行期间每 30 秒自动重试，也可主动重试。已撤销任务返回 410，三个名额包含待清理项，避免故障期间不断积累文件。 旧保存回执和旧 HTTP 确认不能结束新的原生保存等待；当前结果可以早于 HTTP 确认到达，监听器只结算一次并清理。 完整包快照冲突也走失败清理；真实 HTTP 验证清理后重试、下载包含新增文件及释放后的过期状态。 输出流失败并不代表源文件已关闭；跟踪等待中的解析、打开、查询、读取、关闭及最终快照检查，保留首次错误，收尾后才进入任务清理或发布成功。 最终复查使用写入器自身的停止信号，客户端未取消时的输出失败也会终止剩余登记读取；真实 HTTP 断线后可在收尾完成后重试。 已收齐所有区间仍要等活动读取者退出才可回收；缺段保持名额与文件，允许重试，清理与过期规则沿用。 浏览器核对支持取消，关闭/重开后迟到结果不再交出文件；既有下载已交接时，后续关闭继续保留包。真实浏览器两次落盘 ZIP 已核对摘要并清理。

已有验证入口：[scripts/tests/export.test.mjs](../scripts/tests/export.test.mjs)、[scripts/tests/editor-dialogs.test.mjs](../scripts/tests/editor-dialogs.test.mjs)、[desktop/tests/native_export_workflow.py](../desktop/tests/native_export_workflow.py)、[scripts/tests/export-cancellation.test.mjs](../scripts/tests/export-cancellation.test.mjs)、[scripts/tests/export-cleanup.test.mjs](../scripts/tests/export-cleanup.test.mjs)、[scripts/tests/export-bridge.test.mjs](../scripts/tests/export-bridge.test.mjs)、[scripts/tests/export-snapshot.test.mjs](../scripts/tests/export-snapshot.test.mjs)、[scripts/tests/export-streams.test.mjs](../scripts/tests/export-streams.test.mjs)、[scripts/tests/export-preparation.test.mjs](../scripts/tests/export-preparation.test.mjs)、[scripts/tests/export-downloads.test.mjs](../scripts/tests/export-downloads.test.mjs)、[scripts/tests/export-browser.test.mjs](../scripts/tests/export-browser.test.mjs)。

### 设置与语言

<a id="f36"></a>

#### F36 · 语言切换、记忆与跨窗口同步

入口：设置 → 简体中文 / English。

[语言与设置](#node-language_ui) → [桌面会话与事件桥](#node-session) → [Tauri 桌面宿主](#node-host) → [原生语言偏好](#node-native_language) → [本机配置与最近作品](#node-local_config) → [语言与设置](#node-language_ui) → [编辑器状态与导航](#node-editor) → [作品库首页](#node-library)

桌面首页直接 invoke，编辑器经 preferences 桥等待宿主结果；统一先订阅后读取，读写期间的新通知优先。网页按当前 localStorage 同步，支持删除和清空。 仅更新界面与本机偏好，保留草稿；无效值明确报错，保存超时中止未完成请求并允许重试。已提交选择以实际通知为准；状态提示随语言同步。 原生关闭确认的标题、正文和按钮同步采用应用语言。 设置控件及跨窗口通知均保持源码/区块草稿、光标、选区、滚动和版本，后续保存保留原始格式；目录请求和编辑按钮状态不被语言刷新覆盖。

已有验证入口：[scripts/tests/i18n.test.mjs](../scripts/tests/i18n.test.mjs)、[desktop/tests/native-smoke.py](../desktop/tests/native-smoke.py)、[scripts/tests/settings.test.mjs](../scripts/tests/settings.test.mjs)、[src-tauri/src/lib.rs](../src-tauri/src/lib.rs)、[scripts/tests/desktop-library.test.mjs](../scripts/tests/desktop-library.test.mjs)、[scripts/tests/editor-language.test.mjs](../scripts/tests/editor-language.test.mjs)。

### 解析与数据

<a id="f37"></a>

#### F37 · 标准化主链

入口：启动重建 / standardize-docs。

[标准化与索引重建编排](#node-rebuild) → [原文标准化](#node-standardize) → [原始正文](#node-documents) → [文档与素材登记](#node-registry) → [项目类型解析契约](#node-types) → [共享文档解析器](#node-parser) → [共享布局生成器](#node-layout) → [标准缓存与索引](#node-cache)

正文+稳定登记+项目规则 → 标准文档；文本/JSON/YAML 共用布局。 缓存以完整相对源路径的 SHA-256 存入 .entries/，避免长度与文件/目录形状冲突；旧缓存按记录的源路径迁移，局部重建保留其他范围。v2、v3 直接扫描正文根，普通子目录不套用程序目录排除表，原文不重写。

已有验证入口：[scripts/tests/parser.test.mjs](../scripts/tests/parser.test.mjs)、[scripts/tests/metadata-conversion.test.mjs](../scripts/tests/metadata-conversion.test.mjs)、[scripts/tests/build.test.mjs](../scripts/tests/build.test.mjs)、[scripts/tests/creation-workflow.test.mjs](../scripts/tests/creation-workflow.test.mjs)。

<a id="f38"></a>

#### F38 · 构建三份索引

入口：build-static-doc-site。

[文档/素材/引用索引](#node-index) → [文档与素材登记](#node-registry) → [标准缓存与索引](#node-cache) → [文档归属关系](#node-hierarchy) → [共享媒体引用格式](#node-media_format) → [旧图片与技能匹配](#node-legacy_images) → [文档/素材/引用索引](#node-index) → [标准缓存与索引](#node-cache)

生成 documents/assets/references 三份索引，共用 generation；统一提取图片、视频和音频的嵌套值、旧路径与稳定引用，跳过代码示例，保留裸 ID 声明和明确附件。 旧图片相对路径去掉虚拟预览前缀后按正文目录解析，缺失路径同样进入引用报告。 未知 ID 和路径保留为未解析引用；resolved 表示找到登记，在线状态见素材索引。原始正文和权威登记不是索引；/api/index 的轻量目录及其内存缓存是另一条链路。 统一读取器兼容新旧标准缓存；新缓存入口目录为链接时拒绝并保留已有索引。

已有验证入口：[scripts/tests/workspace-layout.test.mjs](../scripts/tests/workspace-layout.test.mjs)、[scripts/tests/call-paths.test.mjs](../scripts/tests/call-paths.test.mjs)、[scripts/tests/document-model.test.mjs](../scripts/tests/document-model.test.mjs)、[scripts/tests/creation-workflow.test.mjs](../scripts/tests/creation-workflow.test.mjs)、[scripts/tests/export.test.mjs](../scripts/tests/export.test.mjs)。

<a id="f39"></a>

#### F39 · 增量登记作品对象

入口：workspace register；桌面打开时自动调用。

[登记与迁移维护入口](#node-workspace_cli) → [文档与素材登记](#node-registry) → [项目清单](#node-manifest) → [原始正文](#node-documents) → [素材原文件](#node-assets) → [文档元数据](#node-document_meta) → [素材元数据](#node-asset_meta)

为未登记文档和素材创建稳定记录；保留已有 ID、绑定和归属。 已登记素材变更不会被自动接受为新的权威哈希；构建索引阶段可跳过素材扫描。 扫描也拒绝目录层级的大小写/Unicode 和文件目录冲突。 登记与素材根绑定、媒体入库共用锁。

已有验证入口：[scripts/tests/workspace-layout.test.mjs](../scripts/tests/workspace-layout.test.mjs)、[scripts/tests/generic-project.test.mjs](../scripts/tests/generic-project.test.mjs)、[scripts/tests/asset-binding.test.mjs](../scripts/tests/asset-binding.test.mjs)。

<a id="f40"></a>

#### F40 · 绑定外置素材根

入口：workspace bind-assets。

[登记与迁移维护入口](#node-workspace_cli) → [文档与素材登记](#node-registry) → [本机外置素材绑定](#node-asset_binding) → [程序、作品与缓存路径](#node-paths) → [素材原文件](#node-assets)

持登记锁更新 .viento/local.json 的 main 路径，保留其他有效本机字段；关闭编辑窗口后绑定，再重建并核验。 这是命令行入口；拒绝配置及父目录链接，失败保留旧绑定；所选目录别名解析为实际路径。只选择目录，不搬动文件或自动接受指纹，也不把绝对路径写进作品清单或迁移包。

已有验证入口：[scripts/tests/workspace-layout.test.mjs](../scripts/tests/workspace-layout.test.mjs)、[scripts/tests/media.test.mjs](../scripts/tests/media.test.mjs)、[scripts/tests/asset-binding.test.mjs](../scripts/tests/asset-binding.test.mjs)。

<a id="f41"></a>

#### F41 · 核验作品、素材和模板

入口：workspace verify / check-project。

[登记与迁移维护入口](#node-workspace_cli) → [文档与素材登记](#node-registry) → [文档元数据](#node-document_meta) → [素材元数据](#node-asset_meta) → [素材原文件](#node-assets) → [项目配置与模板服务](#node-project_service) → [项目模板](#node-templates)

检查登记唯一性、实际文件与逐层路径、素材指纹、文档关系和模板问题。 拒绝数据根内的链接及目录冒充文件，允许合法的双点开头文件名；只输出结果，不自动更改原文来迎合规则。

已有验证入口：[scripts/tests/workspace-layout.test.mjs](../scripts/tests/workspace-layout.test.mjs)、[scripts/tests/project-engine.test.mjs](../scripts/tests/project-engine.test.mjs)、[scripts/tests/asset-binding.test.mjs](../scripts/tests/asset-binding.test.mjs)。

<a id="f42"></a>

#### F42 · 旧背景归属迁移

入口：workspace migrate-documents [--write]。

[登记与迁移维护入口](#node-workspace_cli) → [文档归属关系](#node-hierarchy) → [文档与素材登记](#node-registry) → [文档元数据](#node-document_meta) → [文档/素材/引用索引](#node-index)

分析旧背景与角色关系，可按共享归属映射生成 part-of；写入留迁移记录。 默认只预览；需要 --write 才提交；旧故事独立文件不被吞进角色正文。 明确映射可修正已有或空的 part-of，保留其他关系及仍保留的归属备注；普通重跑不重排完整描述。使用共享登记锁和受保护日志路径，拒绝内部链接；每次日志使用独立 UUID 并禁止覆盖，写入失败回滚已替换描述。

已有验证入口：[scripts/tests/document-model.test.mjs](../scripts/tests/document-model.test.mjs)、[scripts/tests/document-migration.test.mjs](../scripts/tests/document-migration.test.mjs)。

<a id="f43"></a>

#### F43 · 采用官方示范项目定义

入口：workspace apply-definition [--write]。

[登记与迁移维护入口](#node-workspace_cli) → [官方示范定义与采用](#node-definition_tool) → [文档与素材登记](#node-registry) → [项目清单](#node-manifest) → [项目类型解析契约](#node-types) → [项目模板](#node-templates)

把轻量类型/字段规则定义应用到外部作品；官方示范有独立标记。 默认只检查；不把示范正文/素材打入程序；缺少既有类型/模板时拒绝。 无独立模板文件的类型也校验生成正文、默认目录与解析规则；旧配置仍可读取并修正。预览不发布配置，实际变更写独立 UUID 日志且禁止覆盖；清单写入失败保留原配置、释放锁并允许立即重试，重复应用不新增日志。

已有验证入口：[scripts/tests/project-engine.test.mjs](../scripts/tests/project-engine.test.mjs)、[scripts/tests/project-definition.test.mjs](../scripts/tests/project-definition.test.mjs)。

<a id="f50"></a>

#### F50 · 查询轻量文件目录

入口：直接 GET /api/index。

[业务接口分发](#node-router) → [文档服务](#node-doc_service) → [轻量文件目录索引](#node-editable_index) → [原始正文](#node-documents) → [文档与素材登记](#node-registry) → [文档服务](#node-doc_service)

扫描正文路径、登记类型、修改时间和图片关联，使用短期内存缓存及并发请求合并。 不解析正文、不读取展示缓存、不附加 part-of 归属；当前编辑器主加载路径没有调用它。

已有验证入口：[scripts/tests/doc-api.test.mjs](../scripts/tests/doc-api.test.mjs)、[scripts/tests/call-paths.test.mjs](../scripts/tests/call-paths.test.mjs)。

### 运维与兼容

<a id="f44"></a>

#### F44 · 命令行浏览/编辑启动

入口：npm start / npm run browse / start-doc-site.sh。

[浏览/编辑命令入口](#node-cli) → [校验与回归入口](#node-checks) → [标准化与索引重建编排](#node-rebuild) → [浏览 HTTP 服务](#node-browse_server) → [受限文件与素材服务](#node-static) → [编辑器状态与导航](#node-editor)

预检契约，可选标准化/构建；npm start 进入编辑服务，npm run browse 与 shell 默认进入浏览服务。 浏览服务只额外开放导出，不能编辑正文；不是桌面会话启动链路。

已有验证入口：[scripts/tests/build.test.mjs](../scripts/tests/build.test.mjs)、[scripts/tests/doc-api.test.mjs](../scripts/tests/doc-api.test.mjs)。

<a id="f45"></a>

#### F45 · 运行诊断与失败恢复

入口：加载/请求失败；health / metrics。

[业务接口分发](#node-router) → [请求诊断与恢复](#node-diagnostics) → [文档服务](#node-doc_service) → [浏览器请求层](#node-request) → [编辑器状态与导航](#node-editor)

后端统计真实响应状态（含导出 206、416 和断开）；前端收集上下文、去重/筛选和重试。 静态依赖图不能推断真实请求频率或性能；此处是现有诊断通道。 HTTP 401/403 先解析错误码再生成说明，保留请求 ID，避免诊断代码自身抛出未初始化变量错误。 原文读取错误在确认请求仍有效后才写入诊断；切换后的旧失败不会误报到当前窗口。

已有验证入口：[scripts/tests/call-paths.test.mjs](../scripts/tests/call-paths.test.mjs)、[scripts/tests/request-lifecycle.test.mjs](../scripts/tests/request-lifecycle.test.mjs)、[scripts/tests/editor-runtime.test.mjs](../scripts/tests/editor-runtime.test.mjs)。

<a id="f46"></a>

#### F46 · 自动检查与原生回归

入口：npm run check；desktop:test；native-smoke.py。

[校验与回归入口](#node-checks) → [项目类型解析契约](#node-types) → [共享文档解析器](#node-parser) → [共享布局生成器](#node-layout) → [文档与素材登记](#node-registry) → [编辑器状态与导航](#node-editor) → [Tauri 桌面宿主](#node-host)

检查版本、JavaScript 语法、API 契约、临时测试；可另校验当前作品。 --app-only 不依赖日常作品；测试入口存在不等于本轮已重新执行全部测试。

已有验证入口：[scripts/check-project.mjs](../scripts/check-project.mjs)、[desktop/tests/native-smoke.py](../desktop/tests/native-smoke.py)、[desktop/tests/project_settings_navigation.py](../desktop/tests/project_settings_navigation.py)、[src-tauri/tests/glib_variant_iter.rs](../src-tauri/tests/glib_variant_iter.rs)。

<a id="f47"></a>

#### F47 · 打包与交付

入口：desktop:prepare / desktop:build / package-source.py。

[桌面与源码打包](#node-packaging) → [语言与设置](#node-language_ui) → [应用安装包](#node-app_bundle) → [应用源码归档](#node-source_archive)

准备内置 Node 和运行资源，同步桌面语言字典，按发布版本生成平台包和可重建源码归档。 不携带具体作品数据；CI 手动构建 Linux/Windows/macOS 构件，不自动发布或安装。 glib 使用本地安全修复副本，源码归档必须包含 vendor；Linux 桌面回归对 glib 启用优化。

已有验证入口：[scripts/tests/version.test.mjs](../scripts/tests/version.test.mjs)、[scripts/tests/build-cleanup.test.mjs](../scripts/tests/build-cleanup.test.mjs)、[src-tauri/tests/glib_variant_iter.rs](../src-tauri/tests/glib_variant_iter.rs)。

<a id="f48"></a>

#### F48 · 清理构建缓存

入口：npm run clean [-- --dry-run]。

[构建目录清理](#node-cleanup) → [程序、作品与缓存路径](#node-paths) → [应用安装包](#node-app_bundle)

验证清理计划后只删除生成的编译、资源准备目录。 保留 dist、项目内容、本机数据和 Git；不会清理正在创作的作品来节省空间。

已有验证入口：[scripts/tests/build-cleanup.test.mjs](../scripts/tests/build-cleanup.test.mjs)。

<a id="f49"></a>

#### F49 · 历史专用维护工具

入口：单独执行 normalize / fill / generate / sync 脚本。

[历史素材与文本工具](#node-maintenance) → [旧作品记法兼容](#node-legacy_parser) → [原始正文](#node-documents) → [素材原文件](#node-assets)

文本重排、旧技能类型补全、占位素材生成、资源对照表；供旧作品维护。 不被普通保存/重建自动执行；各脚本写入默认不同，应先看参数而非视为统一只读检查。

已有验证入口：[scripts/tests/metadata-conversion.test.mjs](../scripts/tests/metadata-conversion.test.mjs)。

## 5. 功能节点与实现位置

### 界面

| 节点 | 职责 | 代码依据 |
| --- | --- | --- |
| <a id="node-library"></a>作品库首页 `library` | 列出最近作品，创建、打开、导入、备份及返回编辑窗口。 | [renderLibrary](../desktop/ui/app.js#L47) |
| <a id="node-editor"></a>编辑器状态与导航 `editor` | 浏览、搜索、选择、读写、新建和未保存草稿的主协调器。 | [initApp](../web/modules/app-runtime.js#L4991)<br>[web/modules/app-state.js](../web/modules/app-state.js#L1)<br>[handleSaveConflict](../web/modules/app-runtime.js#L1659)<br>[enterEditMode](../web/modules/app-runtime.js#L3541)<br>[setMode](../web/modules/app-runtime.js#L1812)<br>[resetDocEditorState](../web/modules/app-runtime.js#L2680)<br>[loadCreateTypeTemplate](../web/modules/app-runtime.js#L2100)<br>[setCreateTypeState](../web/modules/app-runtime.js#L2159)<br>[updateCreatePathValidation](../web/modules/app-runtime.js#L2277)<br>[saveNewDoc](../web/modules/app-runtime.js#L3613)<br>[saveExistingDoc](../web/modules/app-runtime.js#L3713)<br>[syncDocEditorSource](../web/modules/app-runtime.js#L3963)<br>[selectDoc](../web/modules/app-runtime.js#L4680)<br>[loadData](../web/modules/app-runtime.js#L4859)<br>[renderFilteredDocs](../web/modules/app-runtime.js#L4569)<br>[renderIndexLoadView](../web/modules/app-runtime.js#L882)<br>[syncModeButtons](../web/modules/app-runtime.js#L1485)<br>[createDocButton](../web/modules/app-helpers.js#L1289) |
| <a id="node-draft"></a>源码与区块草稿 `draft` | 从当前源码切分区块并按修改片段还原；保留 BOM、换行和未修改文本。 | [createBlockDraft](../web/modules/app-editor-draft.js#L29)<br>[serializeSourceDraft](../web/modules/app-editor-draft.js#L4)<br>[setEditInputMode](../web/modules/app-runtime.js#L2568) |
| <a id="node-project_ui"></a>项目类型与模板窗口 `project_ui` | 定义类型、规则、模板和字段分组，预览、保存、取消新增及返回编辑器。 | [setupProjectSettings](../web/modules/app-project-settings.js#L6)<br>[cancelChanges](../web/modules/app-project-settings.js#L119) |
| <a id="node-media_ui"></a>素材选择与草稿预览 `media_ui` | 筛选、导入、复用、粘贴、拖入图片/视频/音频；维护异步草稿预览。 拖放优先使用目标文本框；快速重开不受旧关闭事件影响。 部分导入失败后立即展示已登记素材，解除忙碌并允许复用。 失效预览读取即时取消，独立于主动素材导入和插入。 结构化草稿交给通用解析器，转义字段名不漏判，错误期间保留有效预览。 | [setupMediaEditor](../web/modules/app-media-editor.js#L6)<br>[schedulePreview](../web/modules/app-media-editor.js#L42) |
| <a id="node-export_ui"></a>编辑器导出窗口 `export_ui` | 选择文档分享或整库迁移，准备导出、保存、取消与释放临时包。 原生保存按独立请求标识匹配回执，断线重试隔离旧结果。 浏览器下载按钮先核对可用性；过期恢复生成，网络错误保留重试，关闭后的旧结果不再下载。 | [setupExport](../web/modules/app-export.js#L12)<br>[exportAvailability](../web/modules/app-export.js#L5)<br>[nativeSave](../web/modules/app-export.js#L53)<br>[saveNative](../web/modules/app-export.js#L76) |
| <a id="node-language_ui"></a>语言与设置 `language_ui` | 中文/English 字典与设置同步；先订阅后读取，保留新通知；只翻译界面，保留创作内容。 | [applyLanguage](../web/i18n/index.js#L38)<br>[setupSettings](../web/i18n/settings.js#L5)<br>[refreshLanguageUi](../web/modules/app-runtime.js#L747) |
| <a id="node-request"></a>浏览器请求层 `request` | 统一索引、源文档、模板、素材、项目与导出请求，处理超时和错误。 模板路径逐段编码，文本读取保留 UTF-8 BOM。 | [web/modules/app-doc-service.js](../web/modules/app-doc-service.js#L1)<br>[web/modules/app-services.js](../web/modules/app-services.js#L1)<br>[loadTemplateContent](../web/modules/app-doc-service.js#L337)<br>[fetchTextApiRequest](../web/modules/app-services.js#L227) |
| <a id="node-render"></a>通用布局与内容渲染 `render` | 消费 viento-layout-v1、字段与内容块，数组/对象/0/false/null 保持类型。 封面与旧技能卡片使用同一图片回退链。 顶层结构化值与嵌套字段统一渲染，列表内媒体正常展示，空对象/空列表明确可见。 | [renderDocumentLayout](../web/modules/app-document-layout.js#L60)<br>[renderStructuredBlocks](../web/modules/app-structured.js#L18)<br>[buildCommonCards](../web/modules/app-render.js#L706)<br>[renderHeroBanner](../web/modules/app-render.js#L621)<br>[buildHeroSkillCards](../web/modules/app-runtime.js#L3024) |
| <a id="node-media_render"></a>图片、视频与音频控件 `media_render` | 解析本地素材 URL，呈现图片或原生播放器、字幕说明和下载链接。 展示索引中的本地图片文件名逐段编码，合法的连续点名称可用；候选耗尽后显示名称头像。 失败时可单独重试当前素材，成功加载后清除错误，不自动播放。 | [renderMedia](../web/modules/app-media-render.js#L4)<br>[renderMediaText](../web/modules/app-media-render.js#L75)<br>[resolveImageUrl](../web/modules/app-helpers.js#L589)<br>[applyImageFallbackChain](../web/modules/app-helpers.js#L655)<br>[renderGallery](../web/modules/app-runtime.js#L3212) |

### 兼容

| 节点 | 职责 | 代码依据 |
| --- | --- | --- |
| <a id="node-legacy_ui"></a>旧类别卡片与模板回退 `legacy_ui` | 旧作品未提供通用布局或项目模板时保留英雄等专用卡片/模板分支。 | [web/modules/app-type-templates.js](../web/modules/app-type-templates.js#L1)<br>[web/modules/app-render.js](../web/modules/app-render.js#L1)<br>[renderHeroSkillCards](../web/modules/app-runtime.js#L3129) |
| <a id="node-legacy_parser"></a>旧作品记法兼容 `legacy_parser` | 未显式声明通用项目规则时，旧路径和 legacy-hero 等 profile 仍提供默认规则。 | [scripts/standardize-docs/legacy-profile.mjs](../scripts/standardize-docs/legacy-profile.mjs#L1)<br>[scripts/lib/category.mjs](../scripts/lib/category.mjs#L1)<br>[legacyDocumentDefaults](../scripts/lib/document-model.mjs#L6) |
| <a id="node-legacy_images"></a>旧图片与技能匹配 `legacy_images` | 旧图片路径按原始正文目录解析，兼容预览前缀；无稳定登记等分支仍保留按名字/旧目录归集图像及英雄技能信息。 | [buildAssetImageCatalog](../scripts/lib/image-index.mjs#L75)<br>[collectHeroSkillsFromSections](../scripts/build-static-hero-skills.mjs#L301)<br>[collectAssetImageRefs](../scripts/lib/image-index.mjs#L128) |
| <a id="node-maintenance"></a>历史素材与文本工具 `maintenance` | 单独运行的格式整理、技能类型补全、占位资源生成和资源对照表工具；不属于日常编辑自动流程。 | [scripts/reorder-source-metadata-fields.mjs](../scripts/reorder-source-metadata-fields.mjs#L1)<br>[scripts/normalize_docs.mjs](../scripts/normalize_docs.mjs#L1)<br>[scripts/fill-hero-skill-types.mjs](../scripts/fill-hero-skill-types.mjs#L1)<br>[scripts/generate-data-placeholders.mjs](../scripts/generate-data-placeholders.mjs#L1)<br>[scripts/sync_hero_image_resources.mjs](../scripts/sync_hero_image_resources.mjs#L1) |

### 桌面

| 节点 | 职责 | 代码依据 |
| --- | --- | --- |
| <a id="node-host"></a>Tauri 桌面宿主 `host` | 11 个首页命令；在文件选择和写入前检查活动编辑窗口，按请求 ID 管理关闭确认、操作互斥和引擎退出。 | [run](../src-tauri/src/lib.rs#L893)<br>[start_editor](../src-tauri/src/lib.rs#L686)<br>[request_close](../src-tauri/src/lib.rs#L621)<br>[CloseState](../src-tauri/src/close_state.rs#L4)<br>[stop_engine](../src-tauri/src/lib.rs#L476)<br>[require_closed_editor](../src-tauri/src/lib.rs#L74)<br>[VariantStrIter::impl_get](../src-tauri/vendor/glib/src/variant_iter.rs#L118) |
| <a id="node-native_workspace"></a>原生作品与归档 `native_workspace` | 创建兼容作品；Rust 流式备份与恢复，校验文件树、正文/素材登记及指纹，核对快照后发布。 备份/恢复发布前按编辑器契约校验文档关系与循环归属、素材字段及旧路径别名。 | [create_workspace](../src-tauri/src/workspace.rs#L772)<br>[export_workspace](../src-tauri/src/workspace.rs#L899)<br>[import_workspace](../src-tauri/src/workspace.rs#L1019)<br>[validate_archive_registry](../src-tauri/src/workspace.rs#L490)<br>[validate_file_tree](../src-tauri/src/workspace.rs#L168)<br>[validate_document_models](../src-tauri/src/workspace.rs#L419) |
| <a id="node-native_export"></a>原生保存导出结果 `native_export` | 按任务 ID 在选择保存位置前持有实际归档文件，缓存过期不影响当前保存；复核后原子发布，取消或失败保留旧目标。 回传导出包和当前保存请求的双重身份，覆盖成功、取消与错误。 | [save_editor_export](../src-tauri/src/lib.rs#L395)<br>[save_prepared_export](../src-tauri/src/export.rs#L55)<br>[prepare_export](../src-tauri/src/export.rs#L18) |
| <a id="node-native_language"></a>原生语言偏好 `native_language` | 读写本机语言配置，并同步作品库与编辑窗口。 | [src-tauri/src/preferences.rs](../src-tauri/src/preferences.rs#L1)<br>[update_language](../src-tauri/src/lib.rs#L120) |

### 服务

| 节点 | 职责 | 代码依据 |
| --- | --- | --- |
| <a id="node-boot"></a>桌面内置服务启动 `boot` | 登记 v2/v3 数据、重建并启动服务；启动前监听宿主，退出时回收索引进程并禁止下一阶段启动。 | [scripts/desktop-server.mjs](../scripts/desktop-server.mjs#L1)<br>[stopRunningCommands](../scripts/lib/process.mjs#L8) |
| <a id="node-edit_server"></a>编辑 HTTP 服务 `edit_server` | 桌面会话守卫 → 业务路由 → 静态路由。桌面使用随机本机端口。 | [scripts/doc-site-server.mjs](../scripts/doc-site-server.mjs#L1) |
| <a id="node-browse_server"></a>浏览 HTTP 服务 `browse_server` | 只读作品文件和静态索引；额外允许导出接口写临时导出缓存。 | [scripts/browse-server.mjs](../scripts/browse-server.mjs#L1) |
| <a id="node-session"></a>桌面会话与事件桥 `session` | 验证 Host/Origin 和 Cookie；桥接首页、语言、导出，以及带请求 ID 的关闭状态报告。 | [createDesktopSession](../scripts/lib/desktop-session.mjs#L10)<br>[web/modules/desktop-bridge.js](../web/modules/desktop-bridge.js#L1) |
| <a id="node-router"></a>业务接口分发 `router` | 16 种方法/路径组合；鉴权、限流、请求格式和响应信封。 | [handleApiRequest](../scripts/lib/doc-server-routes.mjs#L489)<br>[scripts/lib/doc-api-contract.mjs](../scripts/lib/doc-api-contract.mjs#L1) |
| <a id="node-doc_service"></a>文档服务 `doc_service` | 读原文、内容版本校验、写入、文档索引缓存、重建互斥，以及其他业务服务的入口。 | [createDocumentService](../scripts/lib/doc-api-service.mjs#L53) |
| <a id="node-file_store"></a>文档文件事务 `file_store` | 同文档串行读写，按实际字节生成内容版本，使用独立短临时文件名原子替换或独占创建，保留原权限与正文格式。 | [withDocumentTransaction](../scripts/lib/doc-file-store.mjs#L8)<br>[writeDocumentAtomically](../scripts/lib/doc-file-store.mjs#L40)<br>[documentContentVersion](../scripts/lib/doc-file-store.mjs#L25)<br>[readDocumentSnapshot](../scripts/lib/doc-file-store.mjs#L29) |
| <a id="node-create_doc"></a>新文档身份登记 `create_doc` | 新建时先登记所选类型与 UUID，再发布源文件；失败只回滚本次新登记。 | [createRegisteredDocument](../scripts/lib/project-documents.mjs#L41) |
| <a id="node-project_service"></a>项目配置与模板服务 `project_service` | 校验新增标识、默认目录和 revision，先写模板再切换清单，防止重复新增和过时覆盖。 版本标记与响应使用同一份清单，防止并发读取混用新旧配置。 | [readProjectConfiguration](../scripts/lib/project-service.mjs#L46)<br>[previewProjectTemplate](../scripts/lib/project-service.mjs#L35)<br>[saveProjectTemplate](../scripts/lib/project-service.mjs#L79) |
| <a id="node-media_service"></a>素材导入与清单 `media_service` | 扩展名/内容特征与体积校验、流式上传、哈希去重、稳定 ID 登记；持锁提交时核对素材根未改变。 | [importMediaAsset](../scripts/lib/media-assets.mjs#L53)<br>[listMediaAssets](../scripts/lib/media-assets.mjs#L38) |
| <a id="node-media_insert"></a>结构化素材插入与预览 `media_insert` | JSON/YAML 按源范围插入媒体，保留行内列表的缩进及空文档标记；预览从当前草稿解析媒体。 解析失败返回格式错误，与合法的空素材列表区分。 按正文规则保留 caption/alt 说明；仅排除解析器代码块，嵌套字段与 YAML 复用按出现顺序提取，循环路径跳过且最多 100 项。 | [insertStructuredMedia](../scripts/lib/media-insertion.mjs#L12)<br>[prepareMediaInsertion](../scripts/lib/media-insertion.mjs#L95) |
| <a id="node-export_jobs"></a>导出任务生命周期 `export_jobs` | 串行生成，最多 3 个任务；额度满时回收已完整下载且空闲的旧任务，下载期间暂停过期和文件清理。登记前核对取消；取消/失败任务先撤销访问，清理成功后才释放名额，清理异常自动重试，并发释放共享结果。 已取消请求在回收名额和准备前退出，保留旧的已完成导出包。 分段响应按任务合并成功字节范围，全部收齐后可回收空闲任务；重叠不重复计数，缺段和中断仍保留重试。 | [createExportService](../scripts/lib/export-service.mjs#L31)<br>[create](../scripts/lib/export-service.mjs#L85)<br>[release](../scripts/lib/export-service.mjs#L39)<br>[download](../scripts/lib/export-service.mjs#L71) |
| <a id="node-export_pack"></a>Node 导出规划与 ZIP `export_pack` | 分享携带嵌入、裸 ID、旧图片路径和附件引用；与索引共用提取规则，校验路径、登记指纹及源快照，缺失内容拒绝成功。整库打包保持原格式。 完整包同时复查原本缺失的目录和清单，防止首次新增内容被遗漏。 统一停止状态阻止迟到输入，等待在途操作与实际文件关闭后结束，保留首次错误。 准备与最终复查贯穿取消，停止剩余目录、登记及正文读取；迟到正文保留取消结果。 | [planExport](../scripts/lib/export-package.mjs#L37)<br>[writeExportZip](../scripts/lib/export-package.mjs#L221)<br>[validateSnapshot](../scripts/lib/export-package.mjs#L83) |
| <a id="node-rebuild"></a>标准化与索引重建编排 `rebuild` | 先运行标准化子脚本，再构建文档/素材/引用索引；支持指定源范围。 | [rebuildIndex](../scripts/lib/rebuild-workflow.mjs#L70) |
| <a id="node-static"></a>受限文件与素材服务 `static` | 允许列表、路径映射和链接边界；支持 GET/HEAD 与范围响应。 本地素材声明 no-store，避免持久 HTTP 副本；保留范围读取与文件校验。 | [handleStaticRequest](../scripts/lib/doc-server-static-routes.mjs#L179)<br>[sendFile](../scripts/lib/doc-server.mjs#L510)<br>[resolveProjectFilePath](../scripts/lib/doc-server.mjs#L623) |
| <a id="node-editable_index"></a>轻量文件目录索引 `editable_index` | /api/index 独立扫描源文件与登记，仅含名称、类型、时间和素材关联；不生成 layout 或归属树。 | [buildEditableDocIndex](../scripts/lib/doc-server.mjs#L333)<br>[createDocumentService](../scripts/lib/doc-api-service.mjs#L53) |
| <a id="node-diagnostics"></a>请求诊断与恢复 `diagnostics` | 请求 ID、时长/状态码统计，以及前端重试、错误去重和诊断面板。 | [createApiMetrics](../scripts/lib/doc-api-metrics.mjs#L32)<br>[logRuntimeError](../web/modules/app-runtime.js#L1111)<br>[retryLoadData](../web/modules/app-runtime.js#L899)<br>[getFriendlyRequestError](../web/modules/app-runtime.js#L992)<br>[fetchEditableSource](../web/modules/app-runtime.js#L3499) |

### 引擎

| 节点 | 职责 | 代码依据 |
| --- | --- | --- |
| <a id="node-export_render"></a>离线阅读格式 `export_render` | 共享布局生成 HTML 或 Markdown，保留故事层级和包内素材路径；每篇文档的关联素材按身份去重，原文与附件角色保持完整。 空对象和空列表在两种格式中保留明确表示，媒体与类型值继续按原结构展示。 | [renderExport](../scripts/lib/export-render.mjs#L9) |
| <a id="node-paths"></a>程序、作品与缓存路径 `paths` | 程序资源与作品分离，解析配置选择、v2/v3 目录与外置素材。 | [scripts/lib/paths.mjs](../scripts/lib/paths.mjs#L1)<br>[resolveWorkspaceRoot](../scripts/lib/app-storage.mjs#L49) |
| <a id="node-types"></a>项目类型解析契约 `types` | 稳定 documentType 对应项目模板、解析规则和字段分组；已有登记优先于目录猜测。 | [resolveDocumentDefinition](../scripts/lib/project-layout.mjs#L72)<br>[validateProjectTypes](../scripts/lib/project-layout.mjs#L37) |
| <a id="node-registry"></a>文档与素材登记 `registry` | 读取身份登记，增量添加新对象，维护内容指纹、唯一性、共享登记锁和素材索引；核验登记文件及路径。 归属迁移复用登记锁和路径检查，写入独立恢复日志。 | [registerWorkspace](../scripts/lib/workspace.mjs#L284)<br>[readRegistry](../scripts/lib/workspace.mjs#L170)<br>[resolveAssetRequest](../scripts/lib/workspace.mjs#L66)<br>[assertPortableFileTree](../scripts/lib/workspace.mjs#L119)<br>[withRegistryLock](../scripts/lib/workspace.mjs#L253)<br>[verifyWorkspace](../scripts/lib/workspace.mjs#L360)<br>[updateDocumentModels](../scripts/lib/workspace.mjs#L392) |
| <a id="node-hierarchy"></a>文档归属关系 `hierarchy` | 验证 part-of 关系并构建 owners/ownedDocuments；独立故事仍是独立文档。 明确映射只更新指定文档的归属，保留其他关系与仍有效的备注。 | [validateDocumentModels](../scripts/lib/document-model.mjs#L23)<br>[attachDocumentHierarchy](../scripts/lib/document-model.mjs#L99)<br>[planLegacyDocumentModels](../scripts/lib/document-model.mjs#L55) |
| <a id="node-standardize"></a>原文标准化 `standardize` | 正文根内扫描 → 项目定义 → 通用解析 → 标准对象；以相对源路径哈希定位缓存，按源范围更新、迁移和清理。 | [scripts/standardize-docs.mjs](../scripts/standardize-docs.mjs#L1)<br>[buildStandardCatalog](../scripts/standardize-docs/catalog.mjs#L18)<br>[scripts/standardize-docs/sources.mjs](../scripts/standardize-docs/sources.mjs#L1)<br>[buildStandardOutputPath](../scripts/lib/standard-cache.mjs#L9) |
| <a id="node-parser"></a>共享文档解析器 `parser` | 按扩展名解析文本/Markdown、JSON、YAML，保留字段类型、正文、代码、表格及错误原文。 | [parseSourceContent](../scripts/standardize-docs/doc-factory.mjs#L10)<br>[scripts/standardize-docs/parser.mjs](../scripts/standardize-docs/parser.mjs#L1) |
| <a id="node-layout"></a>共享布局生成器 `layout` | 由标题、分区、字段和块生成 viento-layout-v1；按项目 fieldGroups 调整展示分组。 顶层空对象保留为值块，不因字段展开而丢失。 | [buildDocumentLayout](../scripts/standardize-docs/layout.mjs#L7)<br>[scripts/lib/document-values.mjs](../scripts/lib/document-values.mjs#L1) |
| <a id="node-index"></a>文档/素材/引用索引 `index` | 兼容镜像目录与新 .entries 缓存，生成文档、素材和引用索引，附加归属导航及未解析引用，共用 generation。 | [scripts/build-static-doc-site.mjs](../scripts/build-static-doc-site.mjs#L1)<br>[buildStandardIndex](../scripts/lib/static-index.mjs#L526)<br>[buildRegistryIndexes](../scripts/lib/workspace.mjs#L444)<br>[collectStandardPaths](../scripts/lib/standard-cache.mjs#L16) |
| <a id="node-media_format"></a>共享媒体引用格式 `media_format` | image/video/audio、扩展名和稳定 URL 语法由前后端共用；从解析后的文档值提取引用，跳过代码块。 | [scripts/lib/media-format.mjs](../scripts/lib/media-format.mjs#L1)<br>[collectDocumentMedia](../scripts/lib/media-format.mjs#L51) |

### 工具

| 节点 | 职责 | 代码依据 |
| --- | --- | --- |
| <a id="node-cli"></a>浏览/编辑命令入口 `cli` | 解析 npm/脚本参数，预检契约，可选重建，然后选择浏览或编辑服务。 | [scripts/ops/site.mjs](../scripts/ops/site.mjs#L1)<br>[launchDocSite](../scripts/lib/site-launcher.mjs#L42)<br>[scripts/lib/site-options.mjs](../scripts/lib/site-options.mjs#L1) |
| <a id="node-workspace_cli"></a>登记与迁移维护入口 `workspace_cli` | paths、register、verify、migrate-documents、check-project、apply-definition、bind-assets。 | [scripts/workspace.mjs](../scripts/workspace.mjs#L1) |
| <a id="node-definition_tool"></a>官方示范定义与采用 `definition_tool` | 把轻量类型/规则示范应用到独立旧作品，保留 UUID、正文、附件与归属。 生成模板与文件模板使用同一预览校验，实际变更保留独立恢复日志。 | [applyProjectDefinition](../scripts/lib/project-definition.mjs#L11)<br>[docs/examples/epic-of-viento-line.project.json](../docs/examples/epic-of-viento-line.project.json#L1) |
| <a id="node-checks"></a>校验与回归入口 `checks` | 版本、语法、接口契约、数据格式/模板对齐、Node/Rust/桌面原生工作流。 | [scripts/check-project.mjs](../scripts/check-project.mjs#L1)<br>[scripts/validate-standard-docs.mjs](../scripts/validate-standard-docs.mjs#L1)<br>[scripts/validate-data-template-alignment.mjs](../scripts/validate-data-template-alignment.mjs#L1)<br>[desktop/tests/native-smoke.py](../desktop/tests/native-smoke.py#L1)<br>[src-tauri/tests/glib_variant_iter.rs](../src-tauri/tests/glib_variant_iter.rs#L1) |
| <a id="node-packaging"></a>桌面与源码打包 `packaging` | 统一版本，准备 Node/资源/语言字典，构建平台包与独立源码归档；CI 手动触发。 通过本地覆盖统一 GTK/WebKit 的 glib 修复副本，源码包携带完整依赖补丁。 | [desktop/version.mjs](../desktop/version.mjs#L1)<br>[desktop/prepare.mjs](../desktop/prepare.mjs#L1)<br>[desktop/build.mjs](../desktop/build.mjs#L1)<br>[desktop/package-source.py](../desktop/package-source.py#L1)<br>[.github/workflows/desktop.yml](../.github/workflows/desktop.yml#L1)<br>[[patch.crates-io]](../src-tauri/Cargo.toml#L36) |
| <a id="node-cleanup"></a>构建目录清理 `cleanup` | 只清理已知构建目录，先检查与作品/素材位置是否重叠。 | [cleanBuilds](../desktop/clean.mjs#L12) |

### 数据

| 节点 | 职责 | 代码依据 |
| --- | --- | --- |
| <a id="node-manifest"></a>项目清单 `manifest` | 项目身份、类型、模板引用、解析规则、示范标记。 | [scripts/lib/project-layout.mjs](../scripts/lib/project-layout.mjs#L1) |
| <a id="node-templates"></a>项目模板 `templates` | 文档起始内容；界面保存的版本按内容指纹存放。 | [scripts/lib/project-service.mjs](../scripts/lib/project-service.mjs#L1) |
| <a id="node-documents"></a>原始正文 `documents` | 创作内容的权威来源，不是标准化 JSON 的还原产物。 | [scripts/lib/doc-file-store.mjs](../scripts/lib/doc-file-store.mjs#L1) |
| <a id="node-document_meta"></a>文档元数据 `document_meta` | UUID、sourcePath、documentType、relations、assetBindings。 | [scripts/lib/document-model.mjs](../scripts/lib/document-model.mjs#L1) |
| <a id="node-asset_meta"></a>素材元数据 `asset_meta` | UUID、kind、存储位置、原始内容指纹、旧路径。 | [scripts/lib/workspace.mjs](../scripts/lib/workspace.mjs#L1) |
| <a id="node-assets"></a>素材原文件 `assets` | 图片、视频、音频和已有其他素材；导入不进行格式转码。 | [scripts/lib/media-assets.mjs](../scripts/lib/media-assets.mjs#L1) |
| <a id="node-cache"></a>标准缓存与索引 `cache` | 可重建的 .entries/<相对源路径 SHA-256>.json 标准文档与三份索引；局部重建保留范围外旧缓存。 | [scripts/lib/paths.mjs](../scripts/lib/paths.mjs#L1) |
| <a id="node-export_cache"></a>导出暂存包 `export_cache` | 任务释放、失败或过期时清理；最后一个活动下载结束后再删除，删除失败继续跟踪与重试，不属于作品备份内容。 | [scripts/lib/export-service.mjs](../scripts/lib/export-service.mjs#L1) |
| <a id="node-local_config"></a>本机配置与最近作品 `local_config` | 默认作品、最近记录、语言偏好；不进入项目迁移包。 | [scripts/lib/app-storage.mjs](../scripts/lib/app-storage.mjs#L1) |
| <a id="node-asset_binding"></a>本机外置素材绑定 `asset_binding` | 持登记锁更新当前机器的 main 素材根，保留其他本机字段并拒绝配置路径链接；包内恢复为相对 assets/。 | [resolveAssetRoot](../scripts/lib/workspace.mjs#L60)<br>[bindWorkspaceAssets](../scripts/lib/workspace.mjs#L271) |
| <a id="node-memory"></a>当前窗口草稿与状态 `memory` | 源码/区块/新建路径/项目类型表单及异步请求状态；未实现磁盘草稿恢复。 | [web/modules/app-state.js](../web/modules/app-state.js#L1) |
| <a id="node-share"></a>文档分享包 `share` | HTML 或 Markdown、原始 sources、选中文档及附属文档、使用到的素材和元数据。 | [scripts/lib/export-package.mjs](../scripts/lib/export-package.mjs#L1) |
| <a id="node-archive"></a>完整项目迁移包 `archive` | 公共清单、正文、模板、全部素材、登记及兼容标记；含逐文件大小/SHA-256。 | [export_workspace](../src-tauri/src/workspace.rs#L899) |
| <a id="node-app_bundle"></a>应用安装包 `app_bundle` | 运行程序、Node、web/scripts/schemas、依赖；具体作品不打入包。 | [desktop/prepare.mjs](../desktop/prepare.mjs#L1) |
| <a id="node-source_archive"></a>应用源码归档 `source_archive` | 包含当前未提交的程序源码/测试/说明，不包含作品和构建缓存。 | [desktop/package-source.py](../desktop/package-source.py#L1) |

## 6. 边界入口清单

### 6.1 业务 HTTP：11 个路径、16 个方法组合

编辑服务处理下表全部接口；浏览服务仅处理 `/api/export`。桌面会话校验位于业务路由之前。鉴权、请求 ID、限流及请求格式由路由层处理，业务层再验证版本、路径和数据。

| 方法 | 路径 | 用途 | 服务 | 路由位置 |
| --- | --- | --- | --- | --- |
| GET | `/api/project` | 读取类型/模板和 revision | 编辑 | [handleProject](../scripts/lib/doc-server-routes.mjs#L497) |
| POST | `/api/project` | 保存类型/模板并重建 | 编辑 | [handleProject](../scripts/lib/doc-server-routes.mjs#L498) |
| POST | `/api/project/preview` | 预览当前模板 | 编辑 | [handleProject](../scripts/lib/doc-server-routes.mjs#L501) |
| GET | `/api/export` | 下载已准备的任务 ZIP | 编辑、浏览 | [handleExport](../scripts/lib/doc-server-routes.mjs#L504) |
| POST | `/api/export` | 创建任务，或 action=release 释放任务 | 编辑、浏览 | [handleExport](../scripts/lib/doc-server-routes.mjs#L505) |
| POST | `/api/assets/insert` | JSON/YAML 嵌入或当前草稿媒体预览 | 编辑 | [handleMediaInsertion](../scripts/lib/doc-server-routes.mjs#L508) |
| GET | `/api/assets` | 列出登记媒体 | 编辑 | [handleApiAssets](../scripts/lib/doc-server-routes.mjs#L511) |
| POST | `/api/assets` | 上传二进制素材；?name=文件名 | 编辑 | [handleApiAssets](../scripts/lib/doc-server-routes.mjs#L512) |
| GET | `/api/index` | 扫描轻量文件目录；不是界面使用的完整展示索引 | 编辑 | [handleApiIndex](../scripts/lib/doc-server-routes.mjs#L515) |
| GET | `/api/capabilities` | 探测可编辑能力 | 编辑 | [handleApiCapabilities](../scripts/lib/doc-server-routes.mjs#L518) |
| GET | `/api/health` | 服务健康与重建状态 | 编辑 | [handleApiHealth](../scripts/lib/doc-server-routes.mjs#L521) |
| GET | `/api/metrics` | 请求统计 | 编辑 | [handleApiMetrics](../scripts/lib/doc-server-routes.mjs#L524) |
| GET | `/api/doc` | 读取原文与版本；?path=路径 | 编辑 | [handleApiDocGet](../scripts/lib/doc-server-routes.mjs#L527) |
| POST | `/api/doc` | 保存或 create=true 新建 | 编辑 | [handleApiDocWrite](../scripts/lib/doc-server-routes.mjs#L528) |
| PUT | `/api/doc` | 保存/新建的兼容写法 | 编辑 | [handleApiDocWrite](../scripts/lib/doc-server-routes.mjs#L529) |
| POST | `/api/rebuild` | 全量或局部标准化后构建索引 | 编辑 | [handleApiRebuild](../scripts/lib/doc-server-routes.mjs#L532) |

`GET /api/export` 使用任务 ID 下载；`POST /api/export` 同时承担创建与 `action=release`，所以“方法组合数”不等于所有动作数。素材上传使用二进制正文；其他业务请求按接口约定使用 JSON。

能力声明现已完整列出 11 个业务路径，包括 `/api/project` 与 `/api/project/preview`，并提供 `project` 能力标记。遗漏问题与验证过程见[修复记录 N06](NETWORK_BUGFIX_b.2.8.1.md)。

### 6.2 桌面 HTTP 桥：5 个路径、6 个方法组合

| 方法 | 路径 | 交接动作 | 代码 |
| --- | --- | --- | --- |
| GET | `/__desktop/session/<token>` | 换取会话 Cookie 并跳转编辑器 | [desktop-session](../scripts/lib/desktop-session.mjs#L22) |
| POST | `/__desktop/library` | 显示作品库、保留编辑窗口 | [desktop-session](../scripts/lib/desktop-session.mjs#L29) |
| GET | `/__desktop/preferences` | 读取本机语言；缺失默认，无效报错 | [desktop-session](../scripts/lib/desktop-session.mjs#L32) |
| POST | `/__desktop/preferences` | 通知宿主保存语言并回传结果 | [desktop-session](../scripts/lib/desktop-session.mjs#L32) |
| POST | `/__desktop/export` | 校验独立保存请求标识并通知宿主，回传关联结果 | [desktop-session](../scripts/lib/desktop-session.mjs#L57) |
| POST | `/__desktop/close-response` | 上报关闭请求 ID、忙碌与草稿状态 | [desktop-session](../scripts/lib/desktop-session.mjs#L68) |

### 6.3 首页原生命令：11 个

原生命令都检查调用窗口为 `main`。编辑窗口不直接取得这些命令权限；相关动作走上一节的会话桥。

| 命令 | 用途 | 代码 |
| --- | --- | --- |
| `library_state` | 最近作品、版本、活动窗口和示范标记 | [library_state](../src-tauri/src/lib.rs#L215) |
| `get_language` | 读取语言偏好 | [get_language](../src-tauri/src/lib.rs#L128) |
| `set_language` | 写入语言并同步窗口 | [set_language](../src-tauri/src/lib.rs#L133) |
| `choose_workspace` | 原生选文件夹并登记 | [choose_workspace](../src-tauri/src/lib.rs#L248) |
| `new_workspace` | 原生选择位置并创建空白 v3 项目 | [new_workspace](../src-tauri/src/lib.rs#L269) |
| `restore_workspace` | 选择迁移包及目标目录并恢复 | [restore_workspace](../src-tauri/src/lib.rs#L299) |
| `backup_workspace` | Rust 导出完整项目 | [backup_workspace](../src-tauri/src/lib.rs#L343) |
| `launch_workspace` | 为已登记作品启动编辑会话 | [launch_workspace](../src-tauri/src/lib.rs#L886) |
| `reveal_workspace` | 系统文件管理器打开已登记位置 | [reveal_workspace](../src-tauri/src/lib.rs#L378) |
| `resume_editor` | 显示原有编辑窗口 | [resume_editor](../src-tauri/src/lib.rs#L670) |
| `close_editor` | 请求草稿保护后的关闭 | [close_editor](../src-tauri/src/lib.rs#L680) |

### 6.4 静态读取通道

| 访问路径 | 实际资源 |
| --- | --- |
| `/`、`/index.html`、`/web`、`/web/` | 编辑器入口 |
| `/web/*`、favicon、`/data/*` | 程序静态资源及兼容数据路径 |
| `/web/data/index.json` | `INDEX_OUTPUT`，v2/v3 作品为 `.viento/cache/indexes/documents.json` |
| `/documents/*`、`/templates/*` | 当前作品正文与模板；旧项目保留 `design-data/`、`data-template/` 通道 |
| `/docs-standard/*` | 作品标准化缓存的兼容 URL |
| `/assets/*`、`/asset-files/<UUID>` | 当前素材根，含外置绑定与稳定 ID 解析 |
| `/scripts/lib/doc-api-contract.mjs`、`media-format.mjs`、`document-values.mjs` | 前后端共享的三个允许公开模块 |

这些路径受静态路由的允许范围及目录包含检查约束；媒体支持范围读取。它们不是任意文件浏览接口。路径别名用于兼容，不能据此判断文件实际在程序仓库。

### 6.5 命令行、打包与历史维护

`npm run workspace -- <命令>` 统一由 [scripts/workspace.mjs](../scripts/workspace.mjs) 分发：

| 命令 | 动作 / 写入条件 |
| --- | --- |
| `paths` | 显示本机路径和解析到的作品根 |
| `register` | 增量登记作品、文档和素材，创建/更新登记数据 |
| `verify` | 校验文件、ID、素材指纹、关系等 |
| `check-project` | 读取项目模板问题并核验登记 |
| `migrate-documents` | 预览旧文档归属迁移；`--write` 才写入 |
| `apply-definition` | 检查采用项目定义；`--definition` 指定定义，`--write` 才写入 |
| `bind-assets` | 将 `--directory` 写入当前作品的 `.viento/local.json` |

所有维护命令可用 `--root` 明确作品根。原生归档另有 [workspace-archive 示例 CLI](../src-tauri/examples/workspace-archive.rs) 的 `create / export / import / verify`；其中 verify 使用临时恢复来验证包。

| 日常 / 开发入口 | 调用主线 |
| --- | --- |
| `npm start` | `ops/site` → 参数和契约预检 → 可选重建 → 编辑服务 |
| `npm run browse` | 同一启动器 → 浏览服务 |
| `scripts/start-doc-site*.sh` | 兼容 shell 入口 → 同一启动器 |
| `npm run rebuild` | 标准化 → 静态文档 / 素材 / 引用索引 |
| `npm test` | `scripts/tests/*.test.mjs`，Node 测试 |
| `npm run check` | 版本、语法、契约、作品校验及 Node 回归；`--app-only` 跳过日常作品依赖 |
| `npm run desktop:test` | Rust 单元测试 |
| `desktop/tests/native-smoke.py` | 原生桌面工作流；含语言、媒体、导出及类型返回等场景 |
| `desktop/tests/native-library.py` | 首页真实目录/文件选择、新建、备份、恢复、取消与重试；可启用编辑器原生导出扩展 |
| `desktop:prepare / desktop:dev / desktop:build` | 准备运行环境与字典 → Tauri 开发 / 平台包 |
| `desktop/package-source.py` | 当前源代码、测试和文档归档 |
| `.github/workflows/desktop.yml` | 手动触发三平台构建及构件上传 |
| `npm run clean` | 受保护的已知构建目录清理，可 `--dry-run` |

历史 `normalize* / fill-hero-skill-types / reorder-source-metadata-fields / generate-data-placeholders / sync_hero_image_resources` 等工具单独运行，未接入普通编辑保存主线。各脚本写入默认不同；例如 `normalize_docs.mjs` 与 `fill-hero-skill-types.mjs` 需要 `--dry-run` 才只预览，不能把所有维护脚本当作只读检查。`build-static-hero-skills.mjs` 仍被旧文档技能索引使用。

## 7. 数据落点与迁移边界

以下 `<作品>` 指独立作品根；程序包不内置该作品内容。表中的标准路径按 v3，v2 保留旧目录，v1/未登记项目仍有兼容分支。

| 数据 | 位置 | 生命周期 / 迁移 |
| --- | --- | --- |
| 项目清单 | &lt;作品&gt;/workspace.json | 权威配置；进入完整迁移包。 |
| 项目模板 | &lt;作品&gt;/templates/；v2 为 data-template/ | 权威起始内容；进入完整包。 |
| 原始正文 | &lt;作品&gt;/documents/；v2 为 design-data/ | 权威原文；完整包全部携带，分享包携带选中范围。 |
| 文档元数据 | &lt;作品&gt;/metadata/documents/&lt;UUID&gt;.json | 权威身份与关系；完整包全部携带，分享包携带相关登记。 |
| 素材元数据 | &lt;作品&gt;/metadata/assets/&lt;UUID&gt;.json | 权威素材登记与指纹；随对应范围导出。 |
| 素材原文件 | 当前 main 素材根；默认 &lt;作品&gt;/assets/；新导入 media/&lt;kind&gt;/&lt;UUID&gt;.&lt;ext&gt; | 权威文件；完整包带全部素材，分享包带使用到的素材。 |
| 标准缓存与索引 | &lt;作品&gt;/.viento/cache/docs-standard/、indexes/{documents,assets,references}.json | 可重建；不进入迁移包。 |
| 导出暂存包 | &lt;作品&gt;/.viento/cache/exports/&lt;job UUID&gt;/payload.zip | 临时；释放/失败/过期清理。 |
| 本机配置与最近作品 | &lt;应用配置&gt;/viento.config.json、preferences.json；&lt;应用数据&gt;/library.json | 本机偏好；不进入作品迁移包。 |
| 本机外置素材绑定 | &lt;作品&gt;/.viento/local.json | 本机路径；导出归一为包内 assets，不带机器绝对路径。 |
| 当前窗口草稿与状态 | 浏览器内存；部分界面偏好另使用 localStorage | 未保存状态；关闭丢弃后不提供磁盘恢复。 |
| 文档分享包 | 用户选择的 *.zip | 阅读交付物；不能作为完整项目恢复。 |
| 完整项目迁移包 | 用户选择的 *.viento.zip；作品库默认建议 &lt;应用数据&gt;/backups/ | 恢复交付物；含大小/哈希清单。 |
| 应用安装包 | 构建目录 → dist/current/ 或 CI artifacts | 程序分发物；不包含具体作品。 |
| 应用源码归档 | dist/current/Viento-Studio_&lt;VERSION&gt;_source.tar.gz | 程序源码交付物；不包含具体作品。 |

Linux 默认配置根为 `~/.config/io.viento.studio/`，数据根为 `~/.local/share/io.viento.studio/`，遵循 XDG 覆盖。Windows、macOS 由平台应用目录映射。默认作品选择顺序为：显式 `VIENTO_WORKSPACE_ROOT` → 当前目录中的作品 → 旧程序选择配置 → 本机选择配置 → 最近有效作品 → 默认作品目录。路径表描述代码规则，不是本次访问或搬迁了这些目录。

会话锁位于作品 `.viento/session.lock`；上传暂存位于 `.viento/uploads/`；导出暂存位于 `.viento/cache/exports/`。它们都不是权威创作内容。标准化缓存位于 `.entries/<相对源路径的 SHA-256>.json`，旧命名随重建按源范围迁移。标准索引与登记必须区分：删除索引可以重建，删除稳定 ID 元数据会丢失身份和关系。

## 8. 真实模块依赖与当前集中点

JSON 保留逐条本地 ESM 导入语句、命名导入和行号；同一对文件可以出现多条语句。`desktop/ui/i18n/*` 是准备阶段复制的生成文件，图中指向 `web/i18n/*` 的源文件，并保留 `generatedPath` 注记。内置及第三方导入另列 `externalImports`；不展开第三方内部。

下表统计不同的直接导入文件（包含测试），适合判断改动的影响范围，不表示运行频率：

| 模块 | 直接导入方数量 |
| --- | ---: |
| [scripts/lib/workspace.mjs](../scripts/lib/workspace.mjs) | 43 |
| [scripts/tests/helpers.mjs](../scripts/tests/helpers.mjs) | 35 |
| [scripts/lib/paths.mjs](../scripts/lib/paths.mjs) | 33 |
| [scripts/lib/project-layout.mjs](../scripts/lib/project-layout.mjs) | 33 |
| [scripts/tests/editor-harness.mjs](../scripts/tests/editor-harness.mjs) | 24 |
| [scripts/lib/doc-api-contract.mjs](../scripts/lib/doc-api-contract.mjs) | 20 |
| [scripts/lib/media-format.mjs](../scripts/lib/media-format.mjs) | 20 |
| [web/i18n/index.js](../web/i18n/index.js) | 20 |
| [scripts/lib/process.mjs](../scripts/lib/process.mjs) | 18 |
| [scripts/standardize-docs/doc-factory.mjs](../scripts/standardize-docs/doc-factory.mjs) | 15 |

当前本地导入图有一个包含多个文件的强连通组：`app-document-layout.js`、`app-render.js`、`app-structured.js`。它们互相依赖；这是需要留意的渲染层耦合，不能仅凭循环导入就认定运行时有 bug。

`app-runtime.js` 仍承担列表、选择、编辑状态和刷新等主协调工作。类型解析、路径选择、稳定登记、共享媒体语法是多条业务的共同依赖；改动这些模块时应沿图检查正文、预览、导出及桌面打开链路。

## 9. 已确认的现状边界

- 通用项目规则和布局是主通道；旧 hero 等解析 profile、类别卡片及无登记时的图像匹配仍有条件回退，尚未全部移除。
- 旧背景通过 `part-of` 归属角色，可导航和编辑原文件；目前没有专门的图形关系编辑器。
- 两套完整归档实现必须保持相互兼容；文档分享、完整迁移、本机绑定和未保存草稿的范围不同。
- UI 使用完整静态索引，轻量 `/api/index` 独立存在；能力声明遗漏项目接口的问题已修复。
- 本次未找到面向用户的正文重命名/删除工作流、持久化自动草稿恢复或导入后未引用素材自动清理入口。
- 音视频在正文中通过嵌入引用播放；仅增加元数据绑定不保证当前编辑器自动出现播放器。

上述职责区别和兼容边界继续保留；已修复的具体缺陷按 N01–N120 记在[连续修复记录](NETWORK_BUGFIX_b.2.8.1.md)。

## 10. 快照结构与后续更新

`function-network.json` 含 `metadata`、`nodes`、`edges`、`workflows`、`api`、`desktopBridge`、`nativeCommands`、`workspaceCli`、`moduleImports`、`externalImports`、`sourceInventory`、`eventBindings`、`testDeclarations`、`moduleHubs` 与 `moduleImportCycles`。

本次使用本机 Acorn 解析 ESM 声明、字面量动态导入、显式事件绑定及路由对象，再人工核对关键业务调用与文件读写。模块统计不包含 HTML/CSS 的资源链接、Rust 的 crate 内部依赖、计算出的动态导入或内联属性事件；Python、Rust 和 shell 记录源码指纹及人工确认的入口。已有测试声明可能来自参数化模板，不能用声明数量推断实际测试用例数。

修订 63 保留 170 份代码指纹、181 处节点源码引用、499 条本地导入及 388 个测试声明，并登记 10 份发布文件的版本变更。四十五轮修复和历史发布证据保留，交互页内嵌数据与 JSON 一致。本次收录 32 个新增场景，发布全量 586 项通过；生产归档模块 13 通过、1 项真实大体积迁移忽略。三轮浏览器记录和源码连续性已复核，详见[发布记录](RELEASE_b.4.3.md)及[最新排查报告](STRUCTURED_VALUES_BUGFIX_b.4.2.md)。本轮未重跑完整 Tauri 宿主、音视频播放及原生窗口；功能图页面本身的浏览器交互实测仍未完成。

此文件组是版本快照，不会随应用自动更新。下次更新时：先按 `sourceInventory.sha256` 确认变更范围；重新检查路由表、原生命令注册及本地导入；沿受影响的业务链核对读写和失败分支；保留稳定节点 ID / F 编号，再同步 JSON、本文、HTML 和总图。增加日期或版本，并明确实际运行了哪些验证。交互页内嵌快照供离线打开，无需启动作品服务。
