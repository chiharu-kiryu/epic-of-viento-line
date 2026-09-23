# Viento Studio 桌面版

当前发布版本 **b.3.4**，内部安装版本 **0.3.4**；测试版 `b.X.Y` 对应 `0.X.Y`，X、Y 均为 0–9，`b.9.9` 的下一版为正式版 `1.0.0`。更新内容、历史安装包编号兼容说明与统一命名见 [发布记录与版本规则](../docs/RELEASE_b.3.4.md)。

Linux GTK/WebKit 使用仓库内的 glib 安全修复副本，构建及源码迁移需要完整保留 `src-tauri/vendor`。补丁来源、兼容原因和优化回归见 [安全修复记录](../docs/SECURITY_GLIB_b.2.9.md)。

桌面版使用 Tauri 2。安装后从应用图标启动，在作品库首页新建、打开或导入作品，然后进入现有文档编辑器。Node.js 24.20.0 与转换器随应用提供，使用者无需安装 Node.js、Python、Rust 或手动启动服务。

## 作品与数据

当前桌面版新建通用 v3 项目，正文、模板、元数据和素材分别保存，项目清单定义类型和模板。本机作品默认保存在系统应用数据目录的 `io.viento.studio/workspaces/`，完整备份放在同级 `backups/`。旧 v1、v2 项目原位兼容。详见 [通用项目结构](../docs/GENERIC_PROJECTS.md) 和 [本机数据目录](../docs/LOCAL_DATA_STORAGE.md)。

- **打开已有文件夹**：选择含 `workspace.json` 的作品目录；无清单的旧 `design-data/` 目录也可登记。
- **新建作品库**：选择名称和保存位置，创建 v3 项目：`documents/`、`templates/`、`metadata/`、`assets/` 和 `.viento/`。正文为空，提供档案、角色、故事、地点、组织与设定六份可修改模板。文件选择器默认进入应用的 `workspaces/`，应用不内置具体作品的数据。
- **导出备份**：生成标准 ZIP 格式的 `.viento.zip`，携带公共清单、正文、模板、元数据和完整素材，逐文件记录大小与 SHA-256。外置素材在包内归入默认 `assets/`。
- **导入迁移包**：在新文件夹中恢复并校验全部内容，不覆盖已有作品。v1、v2、v3 包均支持；损坏或不一致时回滚本次导入。
- **移动作品库**：关闭编辑窗口后移动作品文件夹，再从首页打开。单独绑定的外置素材需要另行连接，或使用完整备份一并迁移。

缓存集中在 `.viento/cache/`，可在退出应用后删除再重建。本机绑定位于 `.viento/local.json`，不进入迁移包。`.viento/workspace.json` 是 v2、v3 的旧版拒绝标记，会进入迁移包；旧安装包因此无法打开作品并生成漏掉元数据的备份。素材离线或已登记文件缺失时，完整备份会报错保留旧备份。

作品库最近记录位于系统应用数据目录下的 `io.viento.studio/library.json`。一次桌面会话打开一个作品库；返回首页保留编辑草稿，切换作品前需保存并关闭当前编辑窗口。

详细的目录、登记命令和已实现边界见 [作品库布局](../docs/WORKSPACE_LAYOUT.md)。本机的 `dist/current/` 保存已构建的 Linux x86_64 便携包、源码归档和校验记录，具体版本以交付文件名和校验记录为准。作品迁移包保存到应用数据目录的 `backups/`；修复内容见 [故障记录](../docs/BUGFIX_0.2.1.md)。旧版程序在新包验证后删除。

## 开发和打包

构建机需要 Node.js、Rust 稳定版及 [Tauri 系统依赖](https://v2.tauri.app/start/prerequisites/)。

```sh
npm ci
npm run desktop:dev
```

生成当前系统的安装包：

```sh
npm run desktop:build
```

构建前会自动准备应用资源并下载官方 Node.js 二进制。运行时及许可文本的 SHA-256 固定在 `desktop/node-runtime.json`。下载支持重试，校验后的缓存位于 `desktop/.cache`；只有脚本、前端、通用格式定义与 YAML 依赖进入 `desktop/resources`，约 3 GB 的大型素材无需随每次应用升级重新分发。

输出位于 `src-tauri/target/release/bundle`，构建脚本将完成的安装包改为 `VERSION` 中的发布编号，例如 `Viento-Studio_b.3.4_amd64.AppImage`。Linux 可指定 `--bundles deb,appimage`，Windows 使用 `--bundles nsis`，macOS 使用 `--bundles dmg`。跨平台发行应分别在目标系统构建；仓库中的 **Build desktop installers** 工作流可手动生成三端产物，仅上传工作流构件，不自动发布版本。

每次 Linux 打包前会重建生成用的 `.AppDir` 目录，避免 GTK 打包插件因旧链接残留而使第二次构建失败。Rust 编译缓存、已生成的安装包及作品库不在此清理范围内。

若 AppImage 工具报 `Failed to download runtime`，可从 [AppImage 官方运行时](https://github.com/AppImage/type2-runtime/releases) 下载对应架构的文件，再用 `LDAI_RUNTIME_FILE=/绝对路径/runtime-x86_64 npm run desktop:build -- --bundles appimage` 指定本地文件。运行时可以保存在 `desktop/.cache/appimage-runtime-x86_64` 中供后续构建复用。

macOS 公共发行还需要开发者签名与公证，Windows 公共发行建议配置代码签名。当前工程可以生成未签名的测试安装包；签名凭据由发行者单独配置，不存入仓库。Linux 安装包的最低系统要求取决于构建环境，CI 使用 Ubuntu 22.04；在更新系统本机构建的包可能要求更新的系统库。

内置 Node.js 24 要求 Windows 10 或更新版本、macOS 13.5 或更新版本；macOS 安装包已同步设置最低版本。[Node.js 24 支持平台](https://github.com/nodejs/node/blob/v24.20.0/BUILDING.md#platform-list)

## 交付与清理

交付目录使用 `dist/current/`。程序便携包可以单独分发；整库迁移包是当前作品的一份完整备份，更新程序不必重新复制素材。迁移到另一台机器时，复制程序交付目录，并携带应用数据目录 `backups/` 中的作品迁移包及校验文件；分别核对 `SHA256SUMS`，再启动程序并导入 `.viento.zip`。此目录不另套一层包含全部文件的大压缩包，避免重复占用素材空间。

本机保留一种 Linux 发行格式 AppImage（约 124 MB），以及应用数据目录中一份约 3.16 GB 的完整作品 ZIP；源码仓库内没有作品数据副本。源码归档仅含程序、测试、说明、构建配置与依赖锁文件，可独立重新构建；不重复包含作品、Git 对象库、依赖安装目录或生成文件。`dist/current/README.md` 提供启动、恢复和开发恢复步骤。

生成源码归档（开发机需要 Python 3.9+）：

```sh
python3 desktop/package-source.py
```

脚本包括当前未提交的新代码，逐文件回读验证后才替换已有源码归档。原有 `dist/current/` 的程序和本机应用目录内的作品包不受影响。应用构建完成后，将需要交付的安装包复制到 `dist/current/`，完成验证再清理中间产物：

```sh
npm run clean -- --dry-run
npm run clean
```

`clean` 只删除 `src-tauri/target/`、`src-tauri/binaries/`、`src-tauri/gen/schemas/`、`desktop/resources/` 和 `desktop/.cache/`。它检查父路径链接以及默认作品、外置素材与构建目录的重叠；作品、现用索引、迁移包、源代码、`node_modules/` 和 Git 历史均保留。执行前退出桌面应用并等待构建结束；下次桌面启动或构建会重新准备资源和编译。

需要在命令行操作归档时，可调用与桌面界面相同的 Rust 导入导出实现：

```sh
npm run desktop:prepare
cargo run --manifest-path src-tauri/Cargo.toml --release --example workspace-archive -- create /已有父目录 我的作品
cargo run --manifest-path src-tauri/Cargo.toml --release --example workspace-archive -- export /作品目录 /输出位置/作品.viento.zip
cargo run --manifest-path src-tauri/Cargo.toml --release --example workspace-archive -- verify /输出位置/作品.viento.zip
cargo run --manifest-path src-tauri/Cargo.toml --release --example workspace-archive -- import /输出位置/作品.viento.zip /已有父目录
```

`verify` 会实际导入到临时目录，校验后自动删除恢复副本，需要额外的展开空间。`import` 返回新作品路径，保留恢复结果。导出会原子替换指定的旧备份，失败时保留旧文件；不会自动积累多份备份。

导出和导入都会核对登记的正文、素材绑定与已有素材指纹；不能用包自身的校验和掩盖不一致的登记。路径按每层目录检查大小写、Unicode 等价写法及文件/目录冲突，冲突时保留原文件并报错。原生备份在写入前记录文件快照，发布前再次核对文件、项目清单与外置素材根。

编译好 `workspace-archive` 后，可设置 `VIENTO_TEST_ARCHIVE_BINARY=/完整路径/workspace-archive` 运行 `npm run check -- --app-only`，补齐 v2/v3 包在 Node 与 Rust 间的往返验证；未设置时该互通测试会明确跳过。全部测试样本使用临时目录。

## 验证

本次升版前的 Linux 原生窗口实测过程、截图及覆盖边界见 [b.2.8.1 开发阶段桌面实测](../docs/NATIVE_WORKFLOW_TEST_b.2.8.1.md)；报告保留实测时的版本和指纹，相关修复统一收录于 b.2.9。

作品库首页的原生目录选择、备份和恢复另见 [作品库实测](../docs/NATIVE_LIBRARY_TEST_b.2.8.1.md)。已有编辑窗口时，新建、打开其他作品和导入入口会禁用；宿主也在显示文件选择器和写入前检查，避免先创建或恢复作品再拒绝切换。当前作品仍可继续编辑或备份已保存内容。

关闭编辑器时，宿主按请求 ID 读取正文和模板的草稿、忙碌状态。读取期间暂停页面输入；有草稿时由原生窗口确认，取消后恢复编辑。状态读取超过 5 秒或界面不完整时，提供可取消的原生恢复确认；等待用户决定本身没有超时。关闭确认期间不启动其他文件操作。

确认关闭后，宿主先通知引擎退出并等待终止，再释放作品会话锁。引擎在启动重建前就监听宿主输入管道，退出时停止并回收正在运行的索引进程，禁止继续启动下一阶段。引擎无响应时仍有 5 秒的强制结束兜底。

```sh
npm run check -- --app-only
npm run desktop:prepare
npm run desktop:test
```

测试使用独立的临时样例，不读取日常作品的模板和素材。已有本机作品可另用 `npm run rebuild` 和 `npm run check` 验证完整转换链。现有编辑器与转换器测试继续运行。桌面专项测试覆盖安装目录与数据目录分离、原始字节保留、保存和重建、会话鉴权，以及备份恢复的二进制文件、空文件、中文路径、损坏清单和失败回滚。

Linux 原生窗口流程使用 [Tauri WebDriver](https://v2.tauri.app/develop/tests/webdriver/)。准备 `tauri-driver`、与系统 WebKitGTK 相同版本的 `WebKitWebDriver`、`xvfb-run`、`dbus-run-session`、`xdotool` 和可生成 PNG、VP8、H.264 测试素材的 `ffmpeg` 后执行。`xdotool` 用于独立测试显示器中的原生关闭确认，也可通过 `VIENTO_TEST_XDOTOOL` 指定位置：

```sh
npm run desktop:build -- --debug --no-bundle
python3 desktop/tests/native-smoke.py /path/to/tauri-driver /path/to/WebKitWebDriver
```

此测试使用临时作品库与独立应用设置，验证真实窗口中的版本显示、异常请求恢复、库外链接隔离、打开、编辑、源文/块转换、保存、返回作品库、取消关闭、确认丢弃及子进程退出，不读写日常作品。配置、缓存和 XDG 运行目录均独立；退出时通过 `fusermount3` 清理测试目录内可能残留的门户挂载。可添加第三个参数指定安装包主程序或 AppImage；AppImage 会在该次测试的临时目录内解包后运行，无需 FUSE。解包文件与测试截图在结束时自动删除；需要保留截图与驱动日志时显式设置 `VIENTO_TEST_SCREENSHOT_DIR=/截图保存目录`。

媒体流程覆盖实际图片与视频导入、素材复用、粘贴和拖入、草稿预览、播放与跳转、窄窗口以及保存后重新打开。AppImage 启动时自动补充系统 GStreamer 插件目录；验证便携包时无需手工设置 `GST_PLUGIN_PATH_1_0`。

新项目流程复用同一测试；先构建 `workspace-archive` 示例，再设置 `VIENTO_TEST_GENERIC_CREATE=/完整路径/workspace-archive` 运行。它使用与桌面文件选择器相同的新建实现，并在原生编辑窗口验证空白项目、六个默认类型、自定义 YAML 模板、角色背景及图片视频、指定目录后类型保留，最后调用桌面归档实现逐字节验证完整备份恢复。

首页文件选择流程使用独立测试，另需 `xclip` 向测试显示器粘贴中文路径；不会访问日常桌面的剪贴板：

```sh
python3 desktop/tests/native-library.py /path/to/tauri-driver /path/to/WebKitWebDriver /path/to/viento-studio
```

测试点选真实 GTK 目录、文件和保存窗口，覆盖取消、无效名称和目录、活动编辑窗口限制、备份目的地保护、损坏包回滚及恢复重试。它在新建的临时作品中放入带 BOM/CRLF 的正文、中文及 `#%` 文件名、图片、音频和空文件，逐字节比较归档与恢复结果。截图保留方式与前述测试相同。

设置 `VIENTO_TEST_EDITOR_EXPORT=1` 继续执行编辑器导出的原生保存流程，另需 `xprop` 识别 GTK 覆盖确认与保存窗口的父子关系：

```sh
VIENTO_TEST_EDITOR_EXPORT=1 python3 desktop/tests/native-library.py /path/to/tauri-driver /path/to/WebKitWebDriver /path/to/viento-studio
```

该流程用真实释放接口触发与过期相同的缓存清理，验证保存窗口等待期间仍能保存、取消后过期可重新生成、非法位置可重试，以及覆盖确认的取消与替换。正文分享包和完整项目包都核对实际 ZIP 条目与文件字节，见[导出实测报告](../docs/NATIVE_EXPORT_TEST_b.2.8.1.md)。

完整素材迁移是可选的较慢测试，需要额外磁盘空间保存迁移包与恢复副本：

```sh
VIENTO_TEST_SOURCE_ROOT="/完整路径/作品库" cargo test --manifest-path src-tauri/Cargo.toml full_project_migration_roundtrip -- --ignored --nocapture
```

测试可用 `VIENTO_TEST_ARCHIVE_DIR` 将临时归档放在另一文件系统，恢复副本仍在系统临时目录；测试完成后自动清理。

## 实现边界

Tauri 负责窗口、系统文件选择、作品库管理与进程生命周期；随附的 Node.js 运行既有转换器和编辑服务。处理服务仅绑定本机随机端口，使用每次启动独立的会话密钥与 HttpOnly Cookie，并验证访问来源。编辑 WebView 无原生文件或 Shell 权限；原生数据管理命令只接受来自内置作品库窗口的调用。

这种组织方式复用现有编辑器行为，转换器逻辑无需在首次桌面化时重写。应用资源与作品数据分离，也方便之后逐步替换处理引擎。
