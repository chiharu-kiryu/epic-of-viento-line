# Epic of Viento Line

`Epic of Viento Line` 当前是一个以游戏策划资料为核心的内容仓库，主体资料位于 [design-data/README.md](/Users/Shared/chroot/dev/epic-of-viento-line/design-data/README.md) 所覆盖的设计目录中。

## 仓库结构

- `design-data/`：核心策划文档，包含英雄、背景故事、装备、规则、场景、召唤师技能、单位与模板。
- `assets/`：文档配套资源，包含角色原画、技能图、视频与文本素材。
- `temps/`：临时整理资料。

## 文档规范

- 默认使用 UTF-8 编码与 LF 换行。
- 保持中文字段名统一，优先使用全角冒号 `：`。
- 同类文档尽量遵循相同字段顺序，避免同义字段混写。
- 不轻易修改既有文件名与目录层级，优先通过补充说明文档来提升可读性与可维护性。

## 资料维护建议

1. 新增策划文档前，先阅读 [design-data/README.md](/Users/Shared/chroot/dev/epic-of-viento-line/design-data/README.md)。
2. 新增英雄或单位资料时，优先参考 [design-data/design-template/README.md](/Users/Shared/chroot/dev/epic-of-viento-line/design-data/design-template/README.md) 与现有模板文件。
3. 资源素材尽量与策划命名保持一致，方便按名称互相检索。

## 文档网页化预览（HTML5）

新增了纯静态文档仓库站点，主页面位于 [web/index.html](/Users/Shared/chroot/dev/epic-of-viento-line/web/index.html)。

启动步骤：
1. 运行一键启动脚本：`./scripts/start-doc-site.sh`
2. 默认会先标准化全部文档到 [docs-standard](/Users/Shared/chroot/dev/epic-of-viento-line/docs-standard)（不改动原文件），再生成清单并启动本地服务。
3. 浏览器自动打开 `http://127.0.0.1:4173/web/`
4. 命令参数可选：
   - `./scripts/start-doc-site.sh --port 8080`
   - `./scripts/start-doc-site.sh --no-build`（保留现有 `web/data/index.json`，不重新构建）
   - `./scripts/start-doc-site.sh --no-standardize`（只构建索引，不重建标准化数据）
   - `./scripts/start-doc-site.sh --no-open`

标准化脚本可单独运行：
- `node scripts/standardize-docs.mjs`
- 生成文件位于 [docs-standard](/Users/Shared/chroot/dev/epic-of-viento-line/docs-standard)
- 原始文件与现有目录保持不变，适合用于版本化存档和后续站点接入。
