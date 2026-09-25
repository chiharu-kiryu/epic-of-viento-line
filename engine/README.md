# 可移植引擎

`index.mjs` 是不依赖 Node、HTTP 服务、Tauri 或本机配置的入口。输入是正文字符串、项目定义、登记记录和稳定素材引用；输出是解析结果、布局、字段范围或修改后的正文。唯一运行依赖是 `yaml`，浏览器宿主使用该包的 browser 发行文件，或由打包器解析其 browser/default 入口。

桌面服务和网页编辑器已经复用这里的实现。旧的 `scripts/lib/`、`scripts/standardize-docs/` 和 `web/modules/` 入口保留转发，避免同时改变调用方与公共资源路径。核心不能反向导入这些入口。

## 数据与解析

- `parseSourceContent(content, sourcePath, descriptor)`：Markdown、文本、JSON、YAML 解析，服从文档所属类型的规则。
- `buildDocumentLayout(parsed)`：通用章节、字段分组和内容块布局。
- `createDocumentFieldDraft` / `serializeFieldDraft`：依据当前正文范围编辑字段，保留未修改字节、BOM、换行和注释。应用层负责用 `fieldValueValid` 阻止非法输入。
- `prepareMediaDraft`：插入和收集图片、视频、音频引用。宿主须先确认素材已登记，再传入 `{ type, src: 'asset:<UUID>', caption }`；此函数不导入素材文件。
- `createProjectModel(defaults)`：注入默认类型与模板后，解析项目路径、定义及文档类型。默认数据的唯一来源仍是 `scripts/lib/project-defaults.json`，宿主负责装载，核心不读取文件。
- `document-model.mjs`：登记记录的归属关系、旧模型兼容与层级组装。
- `document-contract.mjs`：现有前后端共享的数据约定。接口能力声明不代表引擎已经实现某个平台宿主。

`sourcePath` 是项目内以 `/` 分隔的逻辑路径，例如 `documents/characters/旅人.md`，不是磁盘绝对路径或 Android 的 `content://` URI。逻辑路径和 `asset:<UUID>` 应写入作品；平台句柄只存在于适配层。

## 文档存储接口

`createDocumentStore({ storage, editablePrefixes, onWrite })` 返回 `getDocByPath(path)` 与 `writeDoc(payload)`，沿用编辑器的读写响应和冲突错误。`editablePrefixes` 由宿主的已验证项目配置提供，前缀包含末尾 `/`；不能直接采用请求中的目录值。`onWrite` 是保存成功后的缓存失效通知。

宿主提供以下异步操作：

| 操作 | 输入 / 输出与职责 |
| --- | --- |
| `transaction(path, operation)` | 对同一逻辑文档及其兼容别名串行执行 `operation`，异常后必须释放锁。不同服务实例访问同一作品时也须共享锁。 |
| `resolve(path, { create })` | 检查目录边界与授权，返回 `null` 或 `{ path, exists, handle }`。`path` 为规范逻辑路径，`handle` 是宿主私有定位信息。允许创建时可返回尚不存在的目标。 |
| `read(reference)` | 返回同一读取快照的 `{ content, version, lastModified, writeState }`。修改时间为 ISO 字符串；版本使用现有 `sha256:<64位小写十六进制>` 或十进制修订号约定，不能仅依赖修改时间。`writeState` 可携带平台写入所需状态。 |
| `write(reference, content, { create, previous, documentType })` | 持久化并返回 `{ version, lastModified }`。`previous` 是上述读取快照；创建必须独占，失败须保留原文件；创建文档还须正确登记类型和稳定 ID。 |

核心不解析 `handle`、`writeState`，不假设文件系统可以执行重命名。平台必须兑现写入和登记的一致性要求；内存测试适配器只用来验证接口，不是 Android 的持久化实现。

平台错误可携带现有 `statusCode / errorCode / payload`；缺失文件用 `ENOENT`、独占创建冲突用 `EEXIST`，工作流会映射为既有接口错误。原始宿主错误不会成为保存失败时的用户可见文件路径。

桌面实现位于 `scripts/adapters/node-document-storage.mjs`，继续使用已有的目录校验、共享事务队列、内容指纹、原子替换和登记锁。媒体文件访问、索引落盘、完整项目导入导出、本机偏好仍属于桌面平台层。

## 验证与下一步

`scripts/tests/portable-engine.test.mjs` 在没有 Node 全局对象的隔离环境中加载引擎及 YAML 浏览器版本，执行跨格式编辑、媒体引用和存储冲突场景，同时检查依赖方向。`portable-engine-scenarios.mjs` 也可通过静态测试页面在真实浏览器中运行，不需要应用 API。

Android 预览宿主已接入：`mobile/platform.mjs` 在 WebView 中复用本引擎，`src-tauri/src/mobile_storage.rs` 在应用私有目录执行原生读写。移动端索引即时生成，不需要 Node 或后台 HTTP 服务。编辑器保留按作品隔离的恢复草稿，恢复时沿用旧版本指纹，避免覆盖应用关闭期间发生的修改。

移动宿主已复用桌面项目包格式，通过系统文件选择器导入、导出。后续仍需媒体访问、模板配置和真机验证，见 [移动端说明](../mobile/README.md)。不要为了兼容宿主而改变现有作品格式或在正文中保存设备绝对路径。
