# 项目工作流与模板契约

## 日常工作流

1. 在作品库新建空白项目，或导入完整 `.viento.zip` 项目包。应用与作品放在不同目录。
2. 在编辑器顶部或 **设置 → 项目类型与模板** 定义类型。名称用于展示，标识保持稳定，默认子目录只是新建建议位置。
3. 编写 Markdown / 文本 / JSON / YAML 模板，点击 **预览解析结果**。标题形成默认分区；字段可以使用任意语言。需要时展开“字段解析与展示规则”，配置精确字段名。
4. 保存并应用。新建文档会使用项目自己的模板；已写好的正文和元数据保持原样。解析规则或展示分组的修改会更新同类型文档的展示。
5. 编辑内容、嵌入图片和视频，保存后更新预览。角色的背景可直接写在角色档案中；独立长篇背景通过稳定文档 ID 的 `part-of` 关系归属角色，共享背景可归属多个角色。当前归属登记仍通过元数据维护，见 [文档模型](OC_DOCUMENT_MODEL.md)。
6. 文档分享使用 HTML / Markdown ZIP；备份、换电脑、继续编辑使用完整项目包。完整包携带项目定义、模板、正文、元数据和素材，导入后重建缓存。

调整项目模板前先保存或结束当前正文草稿。模板窗口自身也有未保存提示；预览不写入项目。只读浏览模式不提供项目配置写入。

## 项目类型的声明

`workspace.json` 的 `documentTypes` 是引擎的类型注册表。每份已登记文档使用其 `documentType` 选择规则，文件名和目录不会覆盖这个选择。

```json
{
  "id": "species",
  "label": "种族",
  "directory": "species",
  "parserProfile": "structured",
  "template": "species.yaml",
  "parserOptions": { "titleField": "名称" },
  "fieldGroups": [
    { "title": "生命特征", "fields": ["灵魂数量", "可繁衍"] }
  ]
}
```

相应的 `templates/species.yaml`：

```yaml
名称: 新建种族
灵魂数量: 0
可繁衍: false
关系: []
补充: null
```

- `structured` 识别字段与通用内容块；`prose` 保留对白中的冒号，仅识别 `allowedFieldKeys` 中明确列出的字段（缺省为 `_header`）。
- `titleField` 使用顶层标量字段作为展示标题；对象和数组不会被误当作标题。
- `multilineFieldKeys` 允许长字段值包含有冒号的子内容；遇到下一长字段、`boundaryFieldKeys` 中的字段或普通块边界时结束。
- `fieldGroups` 只按精确字段名分组。数组、对象、0、false、null、重复字段，以及未选择的内容块仍然保留。没有分组时按源文件顺序展示。
- 模板是起始正文，不是必填字段检查表，不会限制之后增加的内容。模板不执行脚本，也不替换正文变量。

类型数量上限 100，模板管理窗口接受最多 1 MB 正文。规则中的字段名称上限 120 个 UTF-16 单元，每类规则最多 200 项；展示分组最多 50 组，字段不能跨组重复。详见 [类型 schema](../schemas/project-type-v1.schema.json)。

通过界面保存的模板位于 `templates/types/<类型标识>/<内容指纹>.<扩展名>`。先完整写入模板，再原子切换项目清单，因此中断不会让清单指向半份模板。成功后仅清理这次替换的、未修改且未被引用的旧自动模板；原有手写或导入模板保留。模板属于项目，随完整迁移包携带。

配置版本同时包含清单与模板内容。另一个窗口或外部编辑器修改后，旧保存请求会返回冲突；重新打开模板窗口再编辑。HTTP 接口沿用文档服务的会话及写入认证。

## 统一调用路径

```text
项目清单 + 稳定文档登记
          ↓ resolveDocumentDefinition
类型、解析方式、字段规则、展示分组
          ↓ parseSourceContent
标题、原始类型值、有序内容块
          ↓ buildDocumentLayout
          ├── 编辑器展示
          ├── 模板预览
          └── HTML / Markdown 导出
```

素材草稿预览也经过同一类型解析。标准化和索引是派生步骤，不把模板内容覆盖进旧正文。旧 `legacy-hero` 登记只作为未配置项目的兼容入口；显式项目定义优先。

## 校验与已有项目采用定义

```sh
npm run workspace -- check-project --root /绝对路径/作品
npm run workspace -- apply-definition --root /绝对路径/作品 --definition /绝对路径/项目定义.json
npm run workspace -- apply-definition --root /绝对路径/作品 --definition /绝对路径/项目定义.json --write
```

`check-project` 检查源文件、素材指纹、类型与模板。`apply-definition` 默认只检查；加 `--write` 才应用，记录清单变更日志到 `.viento/migrations/`。它不会搬动数据或重写 UUID、关系和素材绑定；缺少现有类型或模板不完整时拒绝应用。示范定义见 [官方示范](examples/README.md)。

当前支持 v3 通用目录和 v2 兼容目录。旧作品采用声明式类型即可使用同一工作流，不要求为更新解析器搬动几 GB 素材。缓存始终可重新构建，`.viento/local.json` 只描述本机外置素材位置。
