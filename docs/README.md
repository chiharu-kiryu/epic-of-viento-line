# 文档中心

当前文档对应 **b.4.6**。使用指南描述当前行为；带版本号的发布与测试记录保留当时的环境、结果和限制，不随升版改写。

## 使用与迁移

| 需要做什么 | 文档 |
| --- | --- |
| 从源码启动或构建桌面安装包 | [桌面版](../desktop/README.md) |
| 体验 Android，了解设备与数据限制 | [Android 预览版](../mobile/README.md) |
| 新建项目、定义类型和模板、编辑保存 | [项目工作流](PROJECT_WORKFLOW.md) |
| 在属性表中修改字段 | [字段编辑](FIELD_EDITING.md) |
| 引用图片、视频与音频 | [素材与音频引用](AUDIO_RESOURCES.md) |
| 分享文档或完整备份作品 | [导出](EXPORT.md) |
| 切换中英日界面 | [界面语言](LANGUAGES.md) |
| 定位本机作品、备份与设置 | [本机数据目录](LOCAL_DATA_STORAGE.md) |

## 项目格式与开发

| 主题 | 文档 |
| --- | --- |
| 新项目目录与兼容规则 | [通用项目结构](GENERIC_PROJECTS.md)、[作品库布局](WORKSPACE_LAYOUT.md) |
| 文档身份、背景故事归属和引用 | [OC 文档模型](OC_DOCUMENT_MODEL.md) |
| 素材身份、目录与迁移 | [作品库与素材布局](WORKSPACE_LAYOUT.md) |
| 清单及登记格式 | [Schemas](../schemas/README.md) |
| 桌面、浏览器、Android 的调用路径 | [系统架构](ARCHITECTURE.md) |
| 可复用解析和存储契约 | [引擎说明](../engine/README.md) |
| 本地服务、转换及维护命令 | [脚本说明](../scripts/README.md) |
| 开发约定、测试、发布检查 | [贡献指南](../.github/CONTRIBUTING.md)、[验证指南](TESTING.md) |
| 官方示范的定义与使用范围 | [Epic of Viento Line](examples/README.md) |

## 发布与验证记录

- [b.4.6 发布记录](RELEASE_b.4.6.md)：下载完成判定、Android 键盘与选择器修复，以及文档整理。
- [当前验证状态与待测链路](TESTING.md)：区分自动回归、原生交互、未验证环境和未实现能力。
- [b.4.5 开发阶段链路补测](WORKFLOW_VERIFICATION_b.4.5.md)：本版修复的复现、四组 Linux 工作流、Android 模拟器和逐文件迁移证据。
- [b.4.5 发布记录](RELEASE_b.4.5.md)：通用引擎和 Android 预览宿主；[b.4.4 发布记录](RELEASE_b.4.4.md)：字段编辑与翻译。
- [功能链路网络](FUNCTION_NETWORK.md)、[离线交互图](function-network.html)、[JSON](function-network.json)：b.4.3 历史枚举快照，适合追踪原有桌面链路；Android 与后续变化以当前架构和验证指南为准。

`test-results/` 保存对应报告引用的日志、截图和摘要。记录中的测试版本、源码指纹和失败复现均应保留；通过数只适用于记录的环境，不能推导其他平台已经通过。
