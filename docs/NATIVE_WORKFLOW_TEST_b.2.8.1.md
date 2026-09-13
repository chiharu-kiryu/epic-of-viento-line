# b.2.8.1 原生桌面工作流实测

2026-09-13，针对当前工作树重新构建 Linux Tauri 桌面程序，使用真实 WebKitGTK 窗口、GTK 保存与关闭弹窗进行验证。应用版本仍为 b.2.8.1，内部版本为 2.8.1。此次使用测试构建，日常安装包未替换。

## 环境和结果

Ubuntu 24.04 x86_64，WebKitGTK / WebKitWebDriver 2.52.6，tauri-driver 2.0.6，内置 Node.js 24.20.0。使用独立 Xvfb 显示器、会话总线、配置、缓存和运行目录，所有正文和媒体均为临时生成的测试样本。

| 验证 | 结果 |
| --- | --- |
| 旧 v2 项目：真实窗口编辑、保存、媒体、语言、取消关闭与确认关闭 | 通过 |
| 通用 v3 项目：类型、模板、新建文档、导出与恢复 | 通过 |
| 应用回归，启用 Node / Rust 归档互通 | 188 通过，0 失败，0 跳过 |
| Rust 原生库回归 | 20 通过，0 失败；原有 1 项真实大体积迁移测试忽略 |

关闭桥专项另复核 3 项通过；Python 测试脚本语法检查通过。最终两组窗口流程都正常退出，未出现断连重试。保留的[运行记录与构建指纹](test-results/native-2026-09-13/results.json)、[旧项目日志](test-results/native-2026-09-13/legacy-complete.log)及[通用项目日志](test-results/native-2026-09-13/generic-complete.log)可独立核对。

## 已验证的操作

- **打开与内容归属**：作品库进入编辑器；角色持有背景故事，背景下还有子故事；进入、返回、搜索背景内容都能定位到所属角色。物品的三个属性分别显示，220px 窄卡片不溢出，数值 0 保留。
- **编辑与保存**：原文编辑、分段编辑来回切换；保存并重建索引；返回作品库再继续编辑；取消放弃时草稿保留。原有 BOM、CRLF 和正文原始字节得到核对，未保存草稿不会混进磁盘上的正文。
- **媒体**：PNG、WebM、MP4 和 WAV、MP3、Ogg、Opus、FLAC、M4A、AAC 的导入、草稿预览、播放状态、暂停、进度跳转；素材复用、粘贴、拖入、保存后重新打开，稳定 ID 不重复登记。退出编辑时隐藏的音频停止播放。
- **语言**：设置从中文切换到英文，完整重启后仍保留；作品库和编辑器互相同步，切换期间正文、分段表单、路径和未保存状态不丢失。
- **项目类型**：新类型取消、Escape、返回编辑器、切换类型时的保留与丢弃；恢复原类型；中英文切换不重建草稿；1280×900 和 760×600 窗口中导航和保存按钮保持可见。取消前后逐文件比较，项目清单、模板、正文、登记及素材不变。
- **模板与新文档**：空白 v3 项目使用项目自己的类型和模板；修改 YAML 模板并预览 false/null；新增事件类型；在自选子目录保存种族档案后，类型和媒体引用保持正确。
- **两种导出**：编辑器生成文档分享包和完整项目包；真实 GTK 保存窗口取消后重试；分享 HTML 带图片、视频和音频；逐文件核对归档大小和 SHA-256。完整项目迁移到新目录后，正文、模板、元数据和素材字节一致，暂存导出文件清理完成。
- **关闭**：中文“继续编辑”保留草稿并恢复页面输入；切换英文后“Discard and close”确认关闭，未保存修改丢弃，本地引擎端口随后停止服务。

## 实测发现和修复

**N42：关闭确认按钮没有跟随应用语言。** 原先只翻译标题和正文，标准按钮仍由系统语言决定，中文设置下实际出现 Cancel / OK。现在使用明确的“继续编辑 / 关闭并丢弃”，英文为“Keep editing / Discard and close”；恢复确认使用“关闭窗口 / Close window”。同时兼容 GTK 返回的标准确认结果和其他原生后端返回的自定义按钮名称，只有确认选项能批准关闭。

测试工具也作了修正：GTK 的可选择文本可能取得焦点，回车并不等于点击确定，现改为实际点击按钮；配置以外的运行目录也独立隔离；处理桌面门户退出时的 FUSE 卸载竞态；WebDriver 的顺序命令改用持久连接。通信失败会终止该次验证，不自动重放编辑或保存操作。

早期运行出现过驱动侧连接重置，页面和草稿仍可读取。独立对比两种连接方式各 2,000 次状态查询都未复现，因此底层触发原因尚未确定，不把它归为应用引擎故障，也不宣称已根除驱动问题；最终以完整流程重新执行的结果为准。

## 复现

准备 `tauri-driver`、匹配系统版本的 `WebKitWebDriver`、`xdotool`、`xvfb-run`、`dbus-run-session`、`fusermount3` 和支持上述媒体编码的 `ffmpeg`。工具可以安装到临时目录，无需修改系统安装。

```sh
npm run desktop:build -- --debug --no-bundle
cargo build --manifest-path src-tauri/Cargo.toml --example workspace-archive

VIENTO_EXPECT_APP_VERSION=b.2.8.1 VIENTO_EXPECT_BUILD_VERSION=2.8.1 \
VIENTO_TEST_LANGUAGE=1 VIENTO_TEST_XDOTOOL=/path/to/xdotool \
VIENTO_TEST_SCREENSHOT_DIR=/path/to/legacy-results \
python3 desktop/tests/native-smoke.py /path/to/tauri-driver /path/to/WebKitWebDriver

VIENTO_EXPECT_APP_VERSION=b.2.8.1 VIENTO_EXPECT_BUILD_VERSION=2.8.1 \
VIENTO_TEST_LANGUAGE=1 VIENTO_TEST_XDOTOOL=/path/to/xdotool \
VIENTO_TEST_GENERIC_CREATE=/absolute/path/to/src-tauri/target/debug/examples/workspace-archive \
VIENTO_TEST_SCREENSHOT_DIR=/path/to/generic-results \
python3 desktop/tests/native-smoke.py /path/to/tauri-driver /path/to/WebKitWebDriver
```

第三个位置参数可指定应用程序；本次实际设置临时 `CARGO_TARGET_DIR`，没有将编译产物留在项目中。显式设置截图目录时，截图和该次驱动日志会保留；否则随测试样本一起清理。

## 实测截图

| 场景 | 截图 |
| --- | --- |
| 中文继续编辑 / 英文丢弃并关闭 | [中文](test-results/native-2026-09-13/desktop-close-zh-CN-cancel.png) · [英文](test-results/native-2026-09-13/desktop-close-en-accept.png) |
| 媒体编辑预览 / 英文分段编辑 | [媒体](test-results/native-2026-09-13/desktop-media-editor.png) · [英文编辑](test-results/native-2026-09-13/desktop-editor-en.png) |
| 窄窗取消新增 / 模板预览 | [760px 窄窗](test-results/native-2026-09-13/desktop-type-cancel-narrow.png) · [模板](test-results/native-2026-09-13/desktop-project-template-preview.png) |
| 自定义种族类型 / 完整项目导出 | [种族](test-results/native-2026-09-13/desktop-generic-species.png) · [导出](test-results/native-2026-09-13/desktop-export-workspace.png) |

## 边界

本次验证 Linux 测试构建，未生成新的 AppImage，也未验证 Windows / macOS。音频以静音方式验证解码、播放状态和跳转，没有人工评价声音输出。新项目创建及整库导入恢复调用与桌面共用的原生 Rust 入口；首页对应的系统目录选择器未逐项点击。媒体文件通过真实上传事件交给编辑器，没有手动操作系统的媒体文件选择器。原有需要真实大体积作品的迁移测试继续忽略，实际作品与素材未改动。

功能网络仍是静态业务图；本次补充的是上述操作的运行验证，不是完整的逐函数运行轨迹。

后续第九轮已补齐首页的实际目录选择、备份与导入流程，结果单独保存在[作品库原生实测](NATIVE_LIBRARY_TEST_b.2.8.1.md)，不改写本轮的历史覆盖边界。

本轮结束后清理了约 2.01 GiB 的临时构建、驱动、样本与生成资源；未留下本轮测试进程或挂载。保留的截图与日志约 0.8 MiB。
