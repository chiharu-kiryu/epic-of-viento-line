# 作品库格式定义

- `workspace-v3.schema.json`：新通用项目的公共清单，使用 `documents`、`templates`、`metadata` 和一个 `main` 素材存储；项目可定义文档类型、目录、解析方式和模板。
- `workspace-v2.schema.json`：旧项目公共清单，继续使用 `design-data`、`data-template` 与独立元数据。
- `asset-v1.schema.json`：素材身份、类型、位置、内容指纹和旧路径。
- `document-v1.schema.json`：文档身份、源文件位置和附件关联。

这些是通用格式定义，随应用分发。具体作品记录保存在作品库内的 `workspace.json` 与 `metadata/`。

JSON Schema 描述字段结构。运行时还会检查文件名与 ID 一致性、身份和位置唯一性、路径可移植性及链接边界。正文中已有的业务字段不复制到登记文件。规则实现位于 `scripts/lib/workspace.mjs`，归档与 v1 兼容实现位于 `src-tauri/src/workspace.rs`。
