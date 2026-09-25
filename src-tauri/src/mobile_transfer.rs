//! System document picker bridge. Paths never cross the frontend IPC boundary.
use crate::mobile_host::MobileState;
use crate::mobile_storage::{error, StorageError};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{fs, path::PathBuf, sync::Mutex};
use tauri::{plugin::PluginHandle, AppHandle, Manager, WebviewWindow, Wry};

struct TransferState {
    native: PluginHandle<Wry>,
    cache: PathBuf,
    busy: Mutex<()>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TransferReply {
    #[serde(default)]
    cancelled: bool,
    error: Option<String>,
}

fn checked(reply: TransferReply) -> Result<bool, StorageError> {
    match reply.error.as_deref() {
        None => Ok(!reply.cancelled),
        Some("busy") => Err(error(409, "另一项迁移正在进行，请稍候")),
        Some("tooLarge") => Err(error(413, "移动端项目包最多 1 GiB，展开后最多 4 GiB")),
        Some("noSpace") => Err(error(507, "磁盘空间不足，无法导入项目包")),
        Some("write") => Err(error(
            500,
            "项目包未完整导出，请删除目标位置的未完成文件后重试",
        )),
        Some("read") => Err(error(400, "无法读取所选项目包，请检查文件授权后重试")),
        _ => Err(error(500, "无法打开系统文件选择器，请重试")),
    }
}

#[tauri::command]
pub async fn mobile_archive(
    app: AppHandle,
    window: WebviewWindow,
    action: String,
    workspace_id: Option<String>,
) -> Result<Value, StorageError> {
    if window.label() != "main" || !["import", "export"].contains(&action.as_str()) {
        return Err(error(400, "bad request"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let transfer = app.state::<TransferState>();
        let _busy = transfer
            .busy
            .try_lock()
            .map_err(|_| error(409, "另一项迁移正在进行，请稍候"))?;
        let stage = tempfile::tempdir_in(&transfer.cache)
            .map_err(|_| error(500, "无法访问本机作品数据"))?;
        let archive = stage.path().join("archive.zip");
        let state = app.state::<MobileState>();
        let lock = || {
            state
                .0
                .lock()
                .map_err(|_| error(500, "无法访问本机作品数据"))
        };
        let invoke_error = |_| error(500, "无法打开系统文件选择器，请重试");
        if action == "import" {
            let reply = transfer
                .native
                .run_mobile_plugin("importArchive", json!({"path":archive}))
                .map_err(invoke_error)?;
            if !checked(reply)? {
                return Ok(json!({"cancelled":true}));
            }
            let workspace = lock()?.import_archive(&archive)?;
            Ok(json!({"workspace":workspace}))
        } else {
            // Finish and verify the archive before creating a user-visible file.
            let result = lock()?.export_archive(workspace_id.as_deref().unwrap_or(""), &archive)?;
            let name = result["workspace"]["name"].as_str().unwrap_or("Viento");
            let reply = transfer
                .native
                .run_mobile_plugin(
                    "exportArchive",
                    json!({"path":archive,"name":format!("{name}.viento.zip")}),
                )
                .map_err(invoke_error)?;
            if !checked(reply)? {
                return Ok(json!({"cancelled":true}));
            }
            Ok(result)
        }
        // TempDir removes staged ZIP bytes on success, failure and cancellation.
    })
    .await
    .map_err(|_| error(500, "无法访问本机作品数据"))?
}

pub fn plugin() -> tauri::plugin::TauriPlugin<Wry> {
    tauri::plugin::Builder::new("archive-transfer")
        .setup(|app, api| {
            let native =
                api.register_android_plugin("io.viento.studio", "ArchiveTransferPlugin")?;
            let cache = app.path().app_cache_dir()?.join("viento-transfer");
            if cache.try_exists()? {
                let stat = fs::symlink_metadata(&cache)?;
                if !stat.is_dir() || stat.file_type().is_symlink() {
                    return Err(std::io::Error::other("invalid transfer cache").into());
                }
                fs::remove_dir_all(&cache)?;
            }
            fs::create_dir(&cache)?;
            app.manage(TransferState {
                native,
                cache,
                busy: Mutex::new(()),
            });
            Ok(())
        })
        // No JavaScript plugin permissions/commands: only Rust invokes Kotlin.
        .build()
}
