# 本机数据目录

作品、备份和应用偏好与程序分开保存。下文描述当前桌面 / 浏览器的默认位置；Android 使用应用私有目录，见末节。旧作品的实际搬迁与字节校验记录保存在 [结构迁移记录](STRUCTURE_MIGRATION.md)，不作为新安装必须执行的步骤。

## 桌面路径

Linux 默认布局支持绝对路径的 `XDG_CONFIG_HOME`、`XDG_DATA_HOME`：

```text
~/.config/io.viento.studio/
├── viento.config.json             开发命令默认作品选择
└── preferences.json               桌面界面语言

~/.local/share/io.viento.studio/
├── library.json                   最近作品记录
├── workspaces/                    新建和打开作品的默认位置
│   └── <作品>/
│       ├── workspace.json
│       ├── documents/             旧作品可使用 design-data/
│       ├── templates/             旧作品可使用 data-template/
│       ├── metadata/
│       ├── assets/
│       └── .viento/               兼容标记、本机绑定、锁和 cache/
└── backups/                       迁移包默认位置
```

macOS 配置与数据均位于 `~/Library/Application Support/io.viento.studio/`；Windows 使用 `%APPDATA%/io.viento.studio/`。路径解析与 Tauri 的应用配置 / 数据目录对应。作品和备份仍可选择其他磁盘，外置素材通过作品本机绑定定位。

运行 `npm run workspace -- paths` 查看当前路径。新环境不附带旧作品、迁移包、校验清单或本机选择；在作品库新建、打开文件夹，或导入完整包后再使用编辑器。

## 开发命令选择作品

在本机 `viento.config.json` 中填写：

```json
{ "version": 1, "workspace": "/完整路径/作品库" }
```

也可只为当前命令选择作品：

```sh
VIENTO_WORKSPACE_ROOT=/完整路径/作品库 npm start -- --no-open
```

选择顺序为显式环境变量、当前工作目录中的作品、旧源码包的显式选择文件、本机配置、最近可用作品。未配置时定位到应用数据目录的 `workspaces/default`，不回退到程序目录保存数据；这不等于已经创建了可编辑作品。显式指定的位置失效时不会静默切换其他作品。

`npm run rebuild` 与 `npm run check` 使用所选作品。仅验证程序时使用 `npm run check -- --app-only`，无需本机作品，也不需要示范素材。

## 备份、迁移与清理

- 完整 `.viento.zip` 包包含清单、正文、模板、元数据及素材，外置素材也会收进包；缓存、本机绑定及应用偏好不进入包。导出前先保存草稿，详见 [导出](EXPORT.md)。
- 直接移动文件夹前关闭编辑窗口，移动后从桌面首页重新打开。外置素材需重新绑定，或使用完整包一并迁移。
- `.viento/cache/` 可退出应用后清理并重建；不能把整个 `.viento/` 当缓存删除，兼容标记、本机绑定、恢复意图与迁移记录各有用途。
- 应用数据中的 `WebKitCache/` 是可再生成的响应副本；`workspaces/`、`backups/`、`localstorage/` 与其他浏览器存储不能一起删除。网页缓存范围见 [磁盘优化记录](DISK_OPTIMIZATION_2026-09-24.md)。
- `npm run clean` 只清理项目中列明的可重建产物，保护作品、外置素材和应用数据；先用 `-- --dry-run` 查看。它不清理 Git 历史、`dist/` 或任意外部编译目录。

作品包与安装包各自独立，可在不复制整份素材的情况下更新程序。当前源码树不保存日常作品；仓库历史中仍保留早期作品记录。

## Android

作品保存在 `app_data_dir()/workspaces/`，应用负责选择和读写，前端仅使用作品 UUID 及逻辑路径。导入先暂存校验，再发布到私有作品库；同一作品不覆盖。当前没有桌面式任意文件夹长期绑定入口。

恢复草稿和语言偏好位于 WebView 本机存储，不进入项目包。覆盖安装已验证保留数据；卸载或清除应用数据会移除私有作品与恢复副本。迁移应通过作品库的系统文件选择器导出完整包，容量与设备限制见 [Android 说明](../mobile/README.md)。
