# 本机数据目录

2026-09-09，b.2.8。正文、模板、元数据、素材和完整作品备份已从源码仓库移动到系统应用数据目录。本机路径配置留在应用配置目录，源码和安装包都不保存日常作品。

## 路径

Linux 默认布局（支持绝对路径的 `XDG_CONFIG_HOME`、`XDG_DATA_HOME`）：

```text
~/.config/io.viento.studio/
└── viento.config.json                 开发命令默认打开的作品

~/.local/share/io.viento.studio/
├── library.json                       桌面最近作品记录
├── workspaces/
│   └── epic-of-viento-line/            原作品完整目录
│       ├── workspace.json
│       ├── design-data/
│       ├── data-template/
│       ├── metadata/
│       ├── assets/
│       └── .viento/                    缓存及必要的兼容标记
├── backups/
│   ├── epic-of-viento-line.viento.zip   唯一保留的完整迁移包
│   └── SHA256SUMS
└── audits/workspace-relocation.json    本机搬迁校验记录
```

macOS 的配置与数据均位于 `~/Library/Application Support/io.viento.studio/`；Windows 使用 `%APPDATA%/io.viento.studio/`。Node 路径解析与 Tauri 的 `app_config_dir`、`app_data_dir` 保持一致。

运行 `npm run workspace -- paths` 查看当前实际路径。桌面打开、新建与导入作品的文件选择器默认进入应用的 `workspaces/`，导入和导出备份默认进入 `backups/`；仍可选择其他磁盘或外置作品。

## 启动与切换

当前本机配置已指向移动后的作品，`npm start -- --no-open`、`npm run rebuild` 和 `npm run check` 沿用原命令。桌面最近记录也已更新，无需重新导入同一份数据。

选择其他默认作品时，编辑上面的本机 `viento.config.json`：

```json
{ "version": 1, "workspace": "/完整路径/作品库" }
```

临时切换可用 `VIENTO_WORKSPACE_ROOT=/完整路径/作品库 npm start -- --no-open`。选择顺序为显式环境变量、当前工作目录中的作品、旧源码包的显式选择文件、本机配置、桌面最近可用作品；未配置时使用应用数据目录下的 `workspaces/default`，不回退到程序目录保存数据。显式指定的位置失效时不会静默切换到其他作品。

新源码包不包含 `viento.config.json` 或 `workspaces/`。在未安装日常作品的机器上，执行 `npm ci`、`npm run check -- --app-only` 即可检查程序和临时样例测试，CI 使用同一流程。`npm run check` 另检查当前作品的转换结果与模板，需要先配置作品并运行 `npm run rebuild`。

## 完整性与迁移

本次在同一文件系统内移动整个作品目录及现有 ZIP，未重新复制大型素材。迁移后，4,095 个作品文件、3,161,480,502 字节与原迁移包逐文件 SHA-256 一致。兼容标记、元数据 ID、原文、大纲和素材均保留；ZIP 的 SHA-256 仍为 `6c6d8133e31137700fccf90cdc27a3965b1eeb3458535b36fe95b23f98d55971`。

源码仓库的 `dist/current/` 只保存程序、源码、使用说明和验证记录。完整迁移时另外携带上述 `backups/` 中的 ZIP 与 `SHA256SUMS`；在目标机器核验后，从桌面首页导入。也可以退出编辑器后移动整个作品目录，再更新本机选择与桌面最近记录。无需在源码仓库创建指向素材的目录链接。

`npm run clean` 继续只清理固定的构建输出，同时保护本机配置、应用数据、已选作品与外置素材。Git 历史保留原样；当前文件树不再包含作品及素材备份。最终程序、测试与交付校验见 `dist/current/verification.json`。
