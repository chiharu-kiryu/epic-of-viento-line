# 参与 Viento Studio 开发

欢迎使用中文或 English 报告问题和提交改进。Viento Studio 是通用 OC 设计 IDE：类型、模板和字段布局由作品定义，程序代码应避免绑定某一部作品的角色或设定。

## 开始开发

使用 Node.js 24。仅修改编辑器或转换器时，不需要安装 Rust 或提供真实作品：

```sh
npm ci
npm run check -- --app-only
```

完整桌面工作流需要 Rust 稳定版与 [Tauri 系统依赖](https://v2.tauri.app/start/prerequisites/)。运行 `npm run desktop:dev`，在首页创建临时作品，即可检查编辑、素材引用、导出和迁移。构建与原生测试步骤见 [桌面版说明](../desktop/README.md)。

仓库保留早期作品的完整历史；只开发当前程序时可使用 `git clone --depth 1`，节省下载和磁盘空间。

## 修改与验证

- 为故障提供尽量小的复现样例；涉及正文、模板或素材时，优先使用新建的测试作品。
- 保持已有作品、稳定 ID、元数据关系和原始文件的兼容性。迁移与备份的改动需要验证失败回滚和恢复后的内容一致性。
- 新增界面文字同步更新简体中文、English 和日本語；参考 [多语言支持](../docs/LANGUAGES.md)。
- 对行为变化添加能复现故障的回归测试，运行 `npm run check -- --app-only`。它覆盖语法、版本一致性、接口契约和程序测试；未提供原生归档工具时，两组跨语言归档测试会明确跳过。
- 修改桌面宿主时，再运行 `npm run desktop:prepare` 和 `npm run desktop:test`。原生归档往返测试与界面实测见 [桌面验证说明](../desktop/README.md#验证)。
- 不提交真实作品、本机选择配置、依赖安装目录或构建产物。历史中已有的作品记录保留；新增测试使用独立临时目录。

Pull Request 请说明遇到的问题、修改后的行为、验证方式以及尚未验证的平台。相关流程变化同步更新 [项目工作流](../docs/PROJECT_WORKFLOW.md) 或对应文档。一般修复无需自行增加版本号，发布时统一处理。

## 报告问题

普通故障在 [Issues](https://github.com/chiharu-kiryu/epic-of-viento-line/issues) 提交，包含应用版本、系统、复现步骤、期望和实际结果。截图、日志及样例中请去除私人作品和凭据。涉及安全的问题请遵循 [安全报告说明](SECURITY.md)。

程序许可证见 [LICENSE](../LICENSE)；提交改进时保留第三方代码已有的来源和许可声明。
