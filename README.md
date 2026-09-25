# Viento Studio

通用 OC 设计 IDE，用于整理原创角色、世界观、故事与设定。类型、模板、字段和展示分组由作品定义；程序与作品数据分别保存，更新应用无需搬动素材。

当前版本 **b.4.6**（内部安装版本 **0.4.6**）。[发布记录](docs/RELEASE_b.4.6.md) · [文档中心](docs/README.md) · [验证状态](docs/TESTING.md)

## 可以做什么

- 用 Markdown、文本、JSON 或 YAML 编写档案，在源码、分段和字段表之间切换。字段表支持直接修改数值、文字和开关，并保留未修改的正文与格式。
- 为项目定义文档类型、起始模板、解析规则和字段分组；用稳定 ID 关联文档、所属故事与素材。
- 插入图片、视频和音频，导出离线网页或 Markdown 分享包；使用完整项目包备份、迁移并继续编辑。
- 在设置中切换简体中文、English、日本語。界面语言与作者的正文、字段名称分别处理，切换时保留草稿。

各平台的接入范围不同：

| 能力 | 桌面版 | 本地浏览器（编辑服务） | Android 预览版 |
| --- | --- | --- | --- |
| 源码、分段、字段编辑与三语设置 | 支持 | 支持 | 支持 |
| 自定义类型与模板配置 | 支持 | 编辑服务支持 | 按导入定义解析；配置界面未接入 |
| 图片、视频、音频的访问与插入 | 支持 | 支持 | 未接入；项目包保留文件 |
| HTML / Markdown 文档分享 | 支持 | 支持 | 未接入 |
| 完整项目导入 / 导出 | 作品库及原生选择器 | 导出；导入使用桌面版 | 系统文件选择器，v2 / v3 包 |
| 作品位置 | 独立文件夹，可绑定外置素材 | 使用已选本机作品 | 应用私有目录 |

桌面版支持 Linux、Windows、macOS 构建。当前原生交互实测覆盖 Linux；Android 已在 API 35 模拟器验证，仍处于功能预览阶段。可构建的平台不等于已经完成设备验收，详见 [测试覆盖与剩余事项](docs/TESTING.md)。

## 从源码启动

准备 Node.js 24、Rust 稳定版及 [Tauri 系统依赖](https://v2.tauri.app/start/prerequisites/)：

```sh
git clone --depth 1 https://github.com/chiharu-kiryu/epic-of-viento-line.git
cd epic-of-viento-line
npm ci
npm run desktop:dev
```

在作品库首页选择 **新建作品库**，填写名称和位置；也可打开已有作品文件夹或导入 `.viento.zip`。首次启动需要准备内置运行环境并编译宿主。已构建的桌面安装包内置 Node.js，使用者无需安装开发工具。构建、系统要求和清理步骤见 [桌面版说明](desktop/README.md)。

只检查程序可运行 `npm run check -- --app-only`，无需真实作品。浏览器入口 `npm start -- --no-open` 需要先选定作品，配置方式见 [脚本与本地服务](scripts/README.md)。Android 的 JDK、SDK、构建和数据限制见 [移动端说明](mobile/README.md)。

## 作品与文档

新项目使用 `workspace.json`、`documents/`、`templates/`、`metadata/`、`assets/`；缓存单独保存在 `.viento/cache/`。旧项目保留原有结构。完整迁移包携带正文、模板、元数据及素材，排除本机设置和可重建缓存。

- [项目工作流](docs/PROJECT_WORKFLOW.md)：新建、模板、编辑、保存与迁移。
- [字段编辑](docs/FIELD_EDITING.md)：属性表、模式切换与内容保护。
- [素材与音频](docs/AUDIO_RESOURCES.md)、[导出](docs/EXPORT.md)、[三语设置](docs/LANGUAGES.md)。
- [通用项目结构](docs/GENERIC_PROJECTS.md)、[文档归属模型](docs/OC_DOCUMENT_MODEL.md)、[本机数据位置](docs/LOCAL_DATA_STORAGE.md)。
- [架构](docs/ARCHITECTURE.md)、[可移植引擎](engine/README.md)、[验证指南](docs/TESTING.md)。

原作品 **Epic of Viento Line** 作为独立的 [官方示范](docs/examples/README.md)，不作为新项目的默认类型，也不进入应用安装包。

## 公开开发

仓库保留程序和原作品的完整 Git 历史，早期提交包含作品正文与素材。浅克隆只下载当前版本；需要完整历史时可运行 `git fetch --unshallow`。当前目录和安装包采用程序与作品分离的结构。

欢迎通过 [Issues](https://github.com/chiharu-kiryu/epic-of-viento-line/issues) 反馈问题，通过 Pull Request 参与开发。请先阅读 [贡献指南](.github/CONTRIBUTING.md)；安全问题使用 [私密报告说明](.github/SECURITY.md)。程序许可证见 [LICENSE](LICENSE)，第三方组件保留各自的许可声明。

`main` 推送与 Pull Request 自动执行应用检查；三端安装包通过 **Build desktop installers** 工作流手动构建，产物作为工作流构件保存，不自动发布。测试版编号为 `b.X.Y`，X、Y 均为 0–9；`b.9.9` 后进入 `1.0.0`。
