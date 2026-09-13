# 本地依赖修复

## glib 0.18.5

这里保存 crates.io 发布的 `glib 0.18.5`，用于回移 [RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html) 的上游修复。Tauri 2.11.5 的 Linux GTK3/WebKit 依赖仍要求 glib 0.18；直接添加 glib 0.20 不会替换这条依赖链。

- 原始包：`https://static.crates.io/crates/glib/glib-0.18.5.crate`
- 包 SHA-256：`233daaf6e83ae6a12a52055f568f9d7cf4671dabb78ff9560ab6da230ce00ee5`
- 原始源码提交：`42b9caf98e03ded086362d9653ca58fe94dc8658`
- 上游修复：[gtk-rs-core #1343](https://github.com/gtk-rs/gtk-rs-core/pull/1343)，提交 `b5a4071e439bef2b5eea76c3aa25e5ae84839e34`。
- 原始 121 个文件的指纹见 [glib-upstream.json](glib-upstream.json)。原包的 MIT 许可、版权、测试和清单完整保留。

本地补丁只改 `glib/src/variant_iter.rs` 两行：输出指针声明为可变，并把 `&mut p` 传给会写入指针的 C 函数。版本继续保留 0.18.5，以维持 GTK3 类型兼容；不会把旧接口改标为上游 0.20。

`.gitattributes` 对此原包目录和补丁保留原始字节，包括许可证末尾空行和统一差异的空白上下文标记，确保不同系统检出后仍可核对上游指纹。

应用根清单通过 `[patch.crates-io]` 把所有 glib 消费者统一指向此目录。正常桌面测试会运行 [字符串迭代回归](../tests/glib_variant_iter.rs)；测试配置对 glib 启用 `opt-level = 3`，覆盖 `next`、`next_back`、`nth`、`nth_back`、`last`，以及空数组、空字符串和 Unicode。CI 的 `npm run desktop:test` 会自动包含这组 Linux 测试。

更新此目录时，应从校验通过的原始包开始，比对文件指纹和上游补丁，再确认 `cargo tree -i glib` 只解析到本地副本，并运行优化后的回归。只有 GTK/WebKit 依赖链整体采用上游修复版本后，才能移除覆盖；不要只删除路径覆盖或手改锁文件版本。源码归档会包含此目录，脱离原开发机仍可构建。
