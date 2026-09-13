# glib 字符串迭代安全修复 · b.2.9

2026-09-13。对应 GitHub Dependabot 告警 [#1](https://github.com/chiharu-kiryu/epic-of-viento-line/security/dependabot/1)、[RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html) / GHSA-wrw7-89jp-8q8g。

## 原因与修复

项目的 Linux 桌面依赖链通过 Tauri 2.11.5、GTK3 和 WebKitGTK 引入 `glib 0.18.5`。其中 `VariantStrIter::impl_get` 把不可变指针引用 `&p` 交给会写入该指针的 C 函数，违反 Rust 的可变性规则；优化后可能仍使用初始空指针，导致崩溃。上游公告的修复版本为 glib 0.20.0 及以上。

当前 [Tauri 的 GTK3 依赖](https://github.com/tauri-apps/tauri/blob/tauri-v2.11.5/crates/tauri/Cargo.toml) 要求 0.18 系列，直接添加新 glib 不会替换旧依赖。因此在 `src-tauri/vendor/glib` 保留经过原始 crates.io 包校验的 0.18.5 源码，回移 [上游 #1343](https://github.com/gtk-rs/gtk-rs-core/pull/1343) 的两行修复：声明 `let mut p`，并传入 `&mut p`。

`[patch.crates-io]` 统一替换整条依赖链的 glib，锁文件不再从注册表获取未修复的 glib。包名、版本和接口仍为 0.18.5；没有把旧接口改标为 0.20，也没有加入扫描忽略规则。121 个原始文件中只修改了 `src/variant_iter.rs`，其余 120 个文件逐字节匹配原包，MIT 许可与版权文件完整保留。来源、文件指纹和具体差异见 [本地依赖说明](../src-tauri/vendor/README.md)、[原始清单](../src-tauri/vendor/glib-upstream.json) 和 [补丁](../src-tauri/vendor/glib-variant-iter.patch)。

## 复现与验证

- 使用 Rust 1.95.0、Linux x86_64；测试配置只对 glib 启用 `opt-level = 3`，其余仍使用普通测试配置。测试无需显示服务器或用户作品。
- 原始 0.18.5 在字符串迭代回归中触发空指针前置条件检查，进程以 SIGABRT 退出，测试命令退出码 101。复现时禁用 core dump，未改动全局 Cargo 缓存或系统库。
- 回移修复后，5 项同组回归全部通过，覆盖前向/反向迭代、`nth` / `nth_back`、`last`、空数组、越界、空字符串和 Unicode。
- 完整 Rust 测试通过 28 项（核心 22、启动 1、安全回归 5）；原有 1 项需要真实大体积作品的迁移测试继续忽略。
- 使用内置 Node v24.20.0 完成应用检查：195 项通过，无失败或跳过；包括 v2/v3 Node/Rust 归档互通。版本、117 个 JavaScript 文件语法和接口契约预检通过。
- Cargo 解析结果只包含一个 glib，来源为本地修复目录；所有解析到的 GTK/WebKit 消费者使用这份源码。安全回归纳入现有 `npm run desktop:test`，CI 的 Linux 构建会自动执行。
- 实际生成并逐文件校验 383 份文件的源码包，确认补丁、121 份依赖源码及许可均包含；解压到独立目录后，离线锁定依赖解析仍只使用包内的 glib 修复副本。验证后删除临时归档。

原始失败、修复后测试与应用回归保存在 [验证记录](test-results/glib-security-2026-09-13/results.json)。这次未重跑原生窗口交互或三端安装包测试，也未替换已安装的应用；旧程序需要重新构建、安装后才包含修复。

## 维护边界

只按版本号匹配的扫描器仍可能把本地 0.18.5 副本识别为受影响版本，应核对路径覆盖、补丁和回归证据。后续升级 GTK/WebKit 依赖链时，确认它整体使用上游修复版本后再删除本地覆盖。源码归档必须保留 `src-tauri/vendor`，确保其他机器构建时采用相同补丁。
