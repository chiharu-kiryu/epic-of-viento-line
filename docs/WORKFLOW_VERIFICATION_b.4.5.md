# b.4.5 功能链路补测与修复

2026-09-25。基于发布提交 `ef1d703f9dcd0418cbad1326a5674729d516cda4`，完成导出 409 排查、当前 Linux 原生工作流回归和 Android 设备环境补测。修复三个实际问题；测试时版本为 **b.4.5 / 0.4.5**；修复现已收录于 [b.4.6](RELEASE_b.4.6.md)。本报告保留测试当时的版本、日志和源码指纹。全部使用隔离的测试作品和配置，日常作品及已安装桌面程序未修改。

## 结果

| 链路 | 本轮验证 |
| --- | --- |
| 完整下载 → 释放导出名额 → 再次导出 | 定位并修复；两项确定性回归修复前失败、修复后通过 |
| 程序回归 | 内置 Node 24.20.0；191 份 JavaScript 语法检查、648 项测试通过，0 失败、0 跳过 |
| Linux 原生桌面 | 旧 v2、通用 v3、作品库、字段与三语，共四组工作流通过 |
| Android 导入 → 字段编辑 → 保存 → 导出 → 桌面恢复 | 实际 APK、原生文件选择器与存储；18 份文件逐字节核对通过 |
| Android 更新与中断恢复 | 覆盖安装保留作品；已有文档和新建文档的未保存草稿均恢复 |
| Android 软键盘与边界 | 修复状态栏重叠、键盘及固定工具栏遮挡；实际数字／英文键盘输入通过 |
| Android 取消、错误与重试 | 修复取消后卡住；两组连续交替取消共 20 次通过；重复包和损坏包不覆盖作品 |

[汇总与源码指纹](test-results/workflow-b.4.5/results.json) · [清理记录](test-results/workflow-b.4.5/cleanup.json)

## 下载完成后仍占用导出名额

旧实现对完整文件流没有指定读取终点。HTTP 客户端收到 `Content-Length` 指定的全部字节后即可关闭连接，此时服务端可能仍在等待额外一次磁盘读取来确认 EOF；结果被记录为中途断开，完整下载没有释放名额，后续导出返回 409。

普通重复及并发压力运行没有稳定触发这一时序，因此增加了确定性回归：只阻塞多余的 EOF 读取，使用实际 HTTP 客户端完成接收并关闭连接。文档导出和完整项目导出在旧代码下均返回 409，在修复后均能创建下一份导出，并回收旧任务。

`sendFile` 现在对完整响应和范围响应都限定读取终点，空文件直接结束响应。真正中断、重叠范围、多读者和空文件的保护保持有效。[Node 文件流文档](https://nodejs.org/api/fs.html#filehandlecreatereadstreamoptions)说明了 `start` / `end` 的边界语义。

证据：[修复前](test-results/export-finish-b.4.5/before-regression.log)、[修复后](test-results/export-finish-b.4.5/after-regression.log)、[58 项定向回归](test-results/export-finish-b.4.5/focused.log)、[648 项完整程序回归](test-results/export-finish-b.4.5/application.log)。新增回归保存在 `scripts/tests/export-downloads.test.mjs`；空文件检查位于 `scripts/tests/doc-api.test.mjs`。

## 当前 Linux 原生工作流

环境为 Ubuntu 24.04 x86_64、WebKitGTK 2.52.6、tauri-driver 2.0.6。重新构建 Tauri 调试程序，独立配置、会话总线、显示器及临时作品；运行资源 385 份文件与准备目录逐字节一致，包含修复后的下载服务。

- **旧 v2 编辑**：属性分组、英雄所属背景、归属导航、修改／保存／搜索／返回、源码与分段切换、未保存保护、取消及确认关闭。
- **通用 v3**：空项目、自有类型及模板、YAML 预览与保存、新增类型的取消／返回、指定目录创建文档、重开与完整迁移。
- **作品库和导出**：真实 GTK 创建／打开／导入／保存窗口，取消、非法位置、损坏包、重试；离线文档和完整 ZIP 导出；恢复后正文、模板、元数据及素材字节一致。
- **字段和语言**：新增原生字段回归，把 YAML 数值 2 改为 9；中英日切换保留字段输入，源码／字段往返后保存，仅修改目标值，元数据不变。英语与日语设置通过完整应用重启保持，日语保存窗口和取消／重试通过。
- **媒体**：WAV、MP3、Ogg、Opus、FLAC、M4A、AAC、WebM 和 MP4 实际解码、播放进度、暂停、跳转；插入、复用、粘贴、拖入和保存重开保持稳定素材 ID。播放测试静音，不代表实体扬声器测试。

[四组详细步骤](test-results/native-b.4.5/workflow-milestones.json) · [运行资源核对](test-results/native-b.4.5/runtime-proof.json) · [原生字段截图](test-results/native-b.4.5/generic-fields/desktop-native-fields.png)

新增字段检查由 `desktop/tests/native-smoke.py` 的 `VIENTO_TEST_FIELDS=1` 启用，与通用项目和语言回归一起运行。四组日志分别是 [legacy](test-results/native-b.4.5/legacy.log)、[generic](test-results/native-b.4.5/generic.log)、[library](test-results/native-b.4.5/library.log) 和 [generic-fields](test-results/native-b.4.5/generic-fields.log)。

## Android 原生补测

使用新建、隔离的 Android 15 / API 35 模拟器，Pixel 2 屏幕配置、1080×1920、WebView 124。先安装已发布 ARM64 调试 APK（模拟器原生桥接运行），随后覆盖安装本轮 x86_64 调试构建。应用仍通过真实 Tauri IPC 和 Rust 私有存储工作；WebView 调试接口操作 DOM，系统文件选择器、返回键和软键盘通过实际 Android 输入操作，没有替换原生存储实现。

### 键盘和状态栏

原版内容延伸到系统状态栏；键盘打开后视口仍为 732 像素高，字段被盖住。原生窗口现在消费系统栏、刘海和 IME 边界，通知 WebView 已处理的边界为零，避免重复留白。移动写作界面改为整页滚动，固定的工具栏不再挤掉输入区域。相关依据见 [Android WebView 窗口边界文档](https://developer.android.com/develop/ui/views/layout/webapps/understand-window-insets)。

实际数字键盘打开时视口从 684 缩至 420，字段顶部约 310、底部约 354；命中检测确认字段没有被其他元素盖住。输入 222 和 200、隐藏键盘恢复高度、保存均通过。新文档源码在英文键盘打开后的 376 高度内也可见，实际输入 `fromAndroid` 被保留。

[修复前截图](test-results/android-device-b.4.5/fields-keyboard.png) · [修复后截图](test-results/android-device-b.4.5/fields-keyboard-fixed.png) · [字段可见性](test-results/android-device-b.4.5/keyboard-visibility.json)

### 选择器取消后的回执

连续取消导入／导出时，观察到原生暂存目录已清理，界面却仍处于忙碌状态；额外一次只读原生查询会让滞留的取消回执一并到达。旧实现直接在选择器结果回调中返回，而这个回调可能先于窗口恢复。[Android Activity 文档](https://developer.android.com/reference/android/app/Activity#onActivityResult(int,int,android.content.Intent))说明了该生命周期顺序。

迁移插件现在等待 Activity 恢复，再在主线程下一次调度交付结果；Activity 销毁时也释放原生请求。没有增加固定延迟、伪造取消结果或自动重复迁移。修复后两批连续交替取消共 20 次全部恢复按钮，损坏包后的“重试 → 系统选择器 → 取消”也通过。

[修复前连续操作](test-results/android-device-b.4.5/picker-sequence-baseline.json) · [诊断](test-results/android-device-b.4.5/picker-resume-diagnostic.json) · [首批 8 次](test-results/android-device-b.4.5/picker-sequence-after.json) · [第二批 12 次](test-results/android-device-b.4.5/picker-sequence-repeat.json)

### 数据、草稿和桌面往返

1. 桌面创建包含角色、所属背景、模板、登记及三种素材文件的 v3 包，经 Android DocumentsUI 选取并导入。
2. 保存字段 175，覆盖安装后 18 份作品文件的大小和 SHA-256 完全一致。保留草稿 222，Home 后强制结束进程，再覆盖安装并重开，恢复 222，而保存文件仍为 175。
3. 实际键盘把字段改为 200 并保存，BOM 与 CRLF 保留，其他 17 份文件不变。
4. 通过真实保存选择器更改导出文件名，导出项目；桌面原生归档程序导入后核对全部 18 份文件，仅包含预期的数值修改。作品 UUID、所属故事关系、模板和素材字节一致。
5. 重新导入最初包含 100 的同一作品包被拒绝，不覆盖当前 200；损坏 ZIP 明确报错并可重试，两个现有作品保持不变。最终迁移暂存目录为空。
6. Android 新建第二个空作品和文档，输入中文／日文内容及英文键盘文本；系统 Back 退出后重开，路径和新建草稿恢复。中英日界面切换保留草稿；字段 300 改为 301 后创建成功，已保存文档的分段／源码往返保持原文，只有一份文档登记。

[覆盖安装文件核对](test-results/android-device-b.4.5/after-upgrade-files.json) · [恢复草稿](test-results/android-device-b.4.5/restored-draft.json) · [最终桌面往返](test-results/android-device-b.4.5/final-desktop-roundtrip.json) · [数据保护](test-results/android-device-b.4.5/final-data-proof.json) · [新建草稿恢复](test-results/android-device-b.4.5/new-document-recovered.json) · [最终 APK 指纹](test-results/android-device-b.4.5/final-apk.json)

本轮测试操作中有页面初始化／退出时过早读取、文案大小写及导入父目录前置条件的纠正，均按实际状态重跑；没有把这些操作错误计为产品缺陷。最初一次保存回执中断后，恢复的草稿保留旧修订号，触发正常冲突提示；加载已保存版本后继续验证，未覆盖更新的文件。

## 仍未覆盖的范围

- Android 实体手机、不同厂商及 API 26 / 36，中文／日文输入法候选词与组合输入；系统低内存自动回收、复制中途杀进程、存储耗尽、云盘／外置存储提供方和授权撤回。
- 真实大体积作品与接近移动导入容量上限的端到端迁移；本轮使用小型自建作品。
- Windows / macOS 原生宿主和安装升级；本轮 Linux 使用隔离调试构建，没有替换日常安装。
- 实体扬声器、麦克风／蓝牙及外置设备断连重连；Android 素材采用少量任意二进制字节验证搬运，不代表手机媒体解码验证。
- 历史维护命令没有在本轮逐个重新执行。功能网络图仍保留 b.4.3 快照，本报告补充当前 b.4.5 的实测证据。

移动端素材访问／插入、项目类型与模板配置、文档分享导出仍未接入，属于尚未实现的预览功能，不能记作已测试通过。测试结束后清理本轮模拟器、临时工具、构建与测试作品，保留日志、截图和校验记录；原有 SDK、用户模拟器、发布产物及日常数据保留。
