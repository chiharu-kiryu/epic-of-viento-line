# Android 预览宿主

当前复用 Viento Studio b.4.5 的编辑器与通用引擎，已接入应用私有目录中的作品库。支持新建作品、新建文档、源码/分段/字段编辑、保存及重新打开，并提供中英日设置和编辑草稿恢复。

作品库已支持通过系统文件选择器导入、导出与桌面兼容的完整项目包，保留正文、模板、登记、故事归属及图片/视频/音频字节。同一作品已存在时拒绝覆盖。请先保存编辑草稿再导出。

这是功能预览：素材访问与管理、项目类型与模板配置尚未接入。请先使用测试作品体验。作品存储在 Android 应用私有目录；卸载应用或清除应用数据会移除这些内容，请事先导出项目包。真机上的软键盘、系统返回、进程回收、文件授权和设备兼容性仍需验证。

## 架构与数据

```text
mobile/index.html                 本机作品库
mobile/editor.js                  复用 web/ 编辑器，安装原生请求桥与恢复草稿
mobile/platform.mjs               API 契约适配、内存索引、模板及字段解析
engine/                           与桌面相同的解析/布局/字段修改/冲突流程
Tauri mobile_storage              主窗口命令，后台线程执行，共享互斥锁
src-tauri/src/mobile_storage.rs    应用私有目录、原子写入、登记、版本核对
src-tauri/src/mobile_archive.rs    桌面归档复用、移动限制、暂存校验后发布
src-tauri/src/mobile_transfer.rs   原生迁移锁、私有缓存、系统文件选择器调用
ArchiveTransferPlugin.kt           Android 文档选择与后台流式复制
```

Android 不启动 Node，不运行本地 HTTP 服务，不把作品打进安装包。`app_data_dir()/workspaces/` 中每份作品使用现有 v3 格式：`workspace.json`、`documents/`、`templates/`、`metadata/`、`assets/`。路径在正文和元数据中仍是相对路径，文档用稳定 UUID 登记。前端只能传作品 ID 和逻辑源路径，不能任意指定磁盘目录。

项目包支持已登记的 v2 / v3 作品；v1 需先在桌面升级。ZIP 最多 1 GiB、展开后最多 4 GiB、归档条目最多 50,000 个，正文和元数据合计分别最多 32 MiB，单个正文/元数据文件最多 1 MiB。取消或校验失败不会覆盖原作品。导出时保持应用打开；外部位置若留下未完成文件，须删除后重试。实现及验证边界见 [迁移记录](../docs/ANDROID_TRANSFER_b.4.4.md)。

保存使用 SHA-256 修订检查、同目录临时文件和原子替换；新建独占写入并登记，普通写入失败会撤回新登记。新建前将正文和登记写入 `.viento/mobile-create/` 恢复意图；进程中断后下次打开会完成同一份创建，成功后清除意图。已有不同内容的文件不会被恢复过程覆盖。原生层再次核对旧修订号，避免绕过前端检查覆盖新内容。读写拒绝符号链接、路径穿越及不可迁移的文件名。当前单个文本上限 1 MiB，单作品最多 20,000 份登记文档。

恢复草稿按作品 UUID 隔离，保存在 WebView 本机存储中，每次修改更新，隐藏/离开页面时补存。源码、分段及字段编辑都序列化成原文草稿，保留原始修订号；重开后继续使用正常的保存冲突处理。损坏或写入失败的恢复记录不会被自动清空。恢复副本不是作品备份。

## 构建

需要 Node、Rust、**完整 JDK 17（包含 javac，JRE 不够）**、Android SDK Platform 36、相应 Build Tools、Android NDK 和 `aarch64-linux-android` Rust 目标。使用 `JAVA_HOME`、`ANDROID_HOME`、`NDK_HOME` 指向本机安装；不把 SDK、NDK、JDK 或绝对目录提交进仓库。

仓库已包含 `src-tauri/gen/android/` 的 Android 源工程。一般直接：

```sh
npm ci
npm run mobile:prepare
npm run android:build -- --debug --ci
```

默认只生成 ARM64 APK；其他目标通过 Tauri Android 命令指定。发布签名尚未配置，调试包不能当作正式商店发行包。只有需要重新生成 Android 源工程时才运行 `npm run android:init`，重建后须复核本项目的 Gradle npm 启动方式及原生配置。

`tauri.android.conf.json` 覆盖桌面配置：使用 `mobile/dist/`，不包含桌面资源映射和 Node sidecar。浏览器 YAML 依赖随应用离线打包，不加载 CDN。Android 原生依赖不包含 GTK 文件选择器、桌面 shell/opener 或单实例插件。

若网络需要代理，Gradle/JVM 的代理属性需要单独配置；它们不会自动沿用所有终端代理变量。请采用本机代理设置，勿把代理地址或凭据写进项目。SDK 的许可由开发者按实际环境处理。

## 验证与清理

```sh
npm run check -- --app-only
# Linux 原生测试仍需桌面 Rust 依赖；测试配置移除桌面安装包资源要求。
TAURI_CONFIG='{"bundle":{"externalBin":[],"resources":null}}' cargo test --manifest-path src-tauri/Cargo.toml --lib
TAURI_CONFIG='{"bundle":{"externalBin":[],"resources":null}}' cargo build --manifest-path src-tauri/Cargo.toml --example mobile-storage
VIENTO_MOBILE_STORE_BIN=/absolute/path/to/mobile-storage node --test scripts/tests/mobile-platform.test.mjs
```

`mobile-storage` 是只用于联调的 JSON-lines 入口，调用同一份 Rust 存储代码；不会打进 APK。`scripts/tests/mobile-browser.mjs` 用临时目录把原生存储连接到真实浏览器，便于验证编辑流程。它替代的是 IPC 传输，不是 Android 设备测试：运行时必须设置 `VIENTO_MOBILE_STORE_BIN` 和 `VIENTO_MOBILE_TEST_ROOT`。

`npm run clean -- --dry-run` 查看生成目录；`npm run clean` 清除前端产物、Rust/Gradle 项目构建缓存，保留 Android 源工程、`dist/` 交付物与作品数据。源码打包包括移动端源码与 Android 工程，排除本机路径配置、构建缓存、密钥和私有数据。
