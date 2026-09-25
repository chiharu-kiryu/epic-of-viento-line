use crate::mobile_storage::{MobileLibrary, SaveRequest, StorageError};
use serde_json::Value;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, WebviewWindow};

pub(crate) struct MobileState(pub(crate) Mutex<MobileLibrary>);

// Only the packaged local window has this command. Native validation remains
// authoritative even when callers bypass the shared JavaScript workflow.
#[tauri::command]
async fn mobile_storage(
    app: AppHandle,
    window: WebviewWindow,
    action: String,
    workspace_id: Option<String>,
    path: Option<String>,
    payload: Option<Value>,
) -> Result<Value, StorageError> {
    let failure = || StorageError {
        status_code: 400,
        message: "bad request".into(),
        error_code: "bad request".into(),
        payload: serde_json::json!({}),
    };
    if window.label() != "main" {
        return Err(failure());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<MobileState>();
        let library = state.0.lock().map_err(|_| failure())?;
        let id = workspace_id.as_deref().unwrap_or("");
        let path = path.as_deref().unwrap_or("");
        match action.as_str() {
            "list" => library.list(),
            "create" => library.create(
                payload
                    .as_ref()
                    .and_then(|p| p["name"].as_str())
                    .ok_or_else(failure)?,
            ),
            "context" => library.context(id),
            "resolve" => library.resolve(id, path),
            "read" => library
                .read(id, path, false)
                .map(|value| serde_json::to_value(value).unwrap()),
            "template" => library
                .read(id, path, true)
                .map(|value| serde_json::to_value(value).unwrap()),
            "save" => library
                .save(
                    id,
                    serde_json::from_value::<SaveRequest>(payload.ok_or_else(failure)?)
                        .map_err(|_| failure())?,
                )
                .map(|value| serde_json::to_value(value).unwrap()),
            _ => Err(failure()),
        }
    })
    .await
    .map_err(|_| failure())?
}

pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "android")]
    let builder = builder
        .plugin(crate::mobile_transfer::plugin())
        .invoke_handler(tauri::generate_handler![
            mobile_storage,
            crate::mobile_transfer::mobile_archive
        ]);
    #[cfg(not(target_os = "android"))]
    let builder = builder.invoke_handler(tauri::generate_handler![mobile_storage]);
    builder
        .setup(|app| {
            let root = app.path().app_data_dir()?.join("workspaces");
            let library = MobileLibrary::new(root).map_err(|e| std::io::Error::other(e.message))?;
            app.manage(MobileState(Mutex::new(library)));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("无法初始化 Viento Studio");
}
