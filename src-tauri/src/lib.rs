mod export;
mod preferences;
pub mod workspace;

use fs2::FileExt;
use preferences::Language;
use serde::Serialize;
use std::{
    fs,
    future::Future,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use tauri::{
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};
use tokio::sync::oneshot;
use uuid::Uuid;
use workspace::{Recent, Result};

fn release_version() -> &'static str {
    include_str!("../../VERSION").trim()
}

struct Engine {
    id: String,
    child: CommandChild,
    workspace: Recent,
    _lock: fs::File,
}

#[derive(Default)]
struct DesktopState {
    engine: Mutex<Option<Engine>>,
    settings_lock: Mutex<()>,
    operation_active: AtomicBool,
    engine_alive: AtomicBool,
    close_pending: AtomicBool,
    exit_after_close: AtomicBool,
}

struct Operation<'a>(&'a AtomicBool);
impl Drop for Operation<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}
fn operation(state: &DesktopState) -> Result<Operation<'_>> {
    state
        .operation_active
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .map_err(|_| "正在处理另一项操作，请稍候")?;
    Ok(Operation(&state.operation_active))
}
fn home_only(window: &WebviewWindow) -> Result<()> {
    if window.label() != "main" {
        return Err("此操作仅限作品库窗口".into());
    }
    Ok(())
}
fn settings_path(app: &AppHandle) -> Result<PathBuf> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("library.json"))
}
fn preferences_path(app: &AppHandle) -> Result<PathBuf> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("preferences.json"))
}
fn language(app: &AppHandle) -> Language {
    preferences_path(app)
        .and_then(|file| preferences::read(&file))
        .map(|value| value.language)
        .unwrap_or_default()
}
fn notify_language(app: &AppHandle, language: Language) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.set_title(&format!(
            "Viento Studio {} · {}",
            release_version(),
            language.text("作品库", "Library")
        ));
    }
    let _ = app.emit_to("main", "language-changed", language);
    if let Some(editor) = app.get_webview_window("editor") {
        let detail = serde_json::json!({ "language": language });
        let _ = editor.eval(&format!("window.dispatchEvent(new CustomEvent('viento-language-changed', {{detail: {detail}}}));"));
    }
}
fn update_language(app: &AppHandle, language: Language) -> Result<()> {
    let state = app.state::<DesktopState>();
    let _lock = state.settings_lock.lock().map_err(|e| e.to_string())?;
    preferences::save_language(&preferences_path(app)?, language)?;
    notify_language(app, language);
    Ok(())
}
#[tauri::command]
fn get_language(app: AppHandle, window: WebviewWindow) -> Result<Language> {
    home_only(&window)?;
    Ok(preferences::read(&preferences_path(&app)?)?.language)
}
#[tauri::command]
fn set_language(app: AppHandle, window: WebviewWindow, language: Language) -> Result<()> {
    home_only(&window)?;
    update_language(&app, language)
}
fn runtime_root(app: &AppHandle) -> Result<PathBuf> {
    Ok(app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("runtime"))
}

fn storage_directory(app: &AppHandle, name: &str) -> Result<PathBuf> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join(name);
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    Ok(root)
}

fn remember(app: &AppHandle, root: &Path) -> Result<Recent> {
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let workspace = workspace::ensure_workspace(&root)?;
    let recent = Recent {
        path: root
            .to_str()
            .ok_or("文件夹路径必须是有效的 Unicode")?
            .into(),
        name: workspace.name,
        id: workspace.id,
        last_opened: workspace::now(),
    };
    let state = app.state::<DesktopState>();
    let _lock = state.settings_lock.lock().map_err(|e| e.to_string())?;
    let file = settings_path(app)?;
    let mut settings = workspace::read_settings(&file)?;
    settings.recent.retain(|item| item.path != recent.path);
    settings.recent.insert(0, recent.clone());
    settings.recent.truncate(30);
    workspace::write_json(&file, &settings)?;
    Ok(recent)
}
fn registered(app: &AppHandle, path: &str) -> Result<PathBuf> {
    let settings = workspace::read_settings(&settings_path(app)?)?;
    if !settings.recent.iter().any(|item| item.path == path) {
        return Err("请先通过作品库选择这个文件夹".into());
    }
    Path::new(path)
        .canonicalize()
        .map_err(|e| format!("作品库位置不可用，请重新选择：{e}"))
}

// Keep native pickers on the Rust side: the dialog plugin replaces synchronous
// window.confirm with a Promise, breaking the editor's unsaved-change guards.
async fn select_path<F, T>(app: &AppHandle, create_dialog: F) -> Result<Option<PathBuf>>
where
    F: FnOnce() -> T + Send + 'static,
    T: Future<Output = Option<rfd::FileHandle>> + Send + 'static,
{
    let (sender, receiver) = oneshot::channel();
    app.run_on_main_thread(move || {
        let dialog = create_dialog();
        tauri::async_runtime::spawn(async move {
            let _ = sender.send(dialog.await.map(|file| file.path().to_path_buf()));
        });
    })
    .map_err(|e| e.to_string())?;
    receiver.await.map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LibraryState {
    recent: Vec<Recent>,
    active: Option<Recent>,
    version: String,
    build_version: String,
    examples: Vec<String>,
}
#[tauri::command]
fn library_state(app: AppHandle, window: WebviewWindow) -> Result<LibraryState> {
    home_only(&window)?;
    let state = app.state::<DesktopState>();
    let active = state
        .engine
        .lock()
        .map_err(|e| e.to_string())?
        .as_ref()
        .map(|engine| engine.workspace.clone());
    let recent = workspace::read_settings(&settings_path(&app)?)?.recent;
    let examples = recent.iter().filter(|item| {
        std::fs::read(std::path::Path::new(&item.path).join("workspace.json")).ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
            .is_some_and(|manifest| manifest["example"]["id"].as_str().is_some_and(|id| !id.is_empty()))
    }).map(|item| item.path.clone()).collect();
    Ok(LibraryState {
        recent,
        active,
        version: release_version().into(),
        build_version: app.package_info().version.to_string(),
        examples,
    })
}
#[tauri::command]
async fn choose_workspace(app: AppHandle, window: WebviewWindow) -> Result<Option<Recent>> {
    home_only(&window)?;
    let state = app.state::<DesktopState>();
    let _operation = operation(&state)?;
    let directory = storage_directory(&app, "workspaces")?;
    let lang = language(&app);
    let Some(folder) = select_path(&app, move || {
        rfd::AsyncFileDialog::new()
            .set_parent(&window)
            .set_directory(directory)
            .set_title(lang.text("选择作品项目文件夹", "Choose a project folder"))
            .pick_folder()
    })
    .await?
    else {
        return Ok(None);
    };
    Ok(Some(remember(&app, &folder)?))
}
#[tauri::command]
async fn new_workspace(
    app: AppHandle,
    window: WebviewWindow,
    name: String,
) -> Result<Option<Recent>> {
    home_only(&window)?;
    let state = app.state::<DesktopState>();
    let _operation = operation(&state)?;
    let directory = storage_directory(&app, "workspaces")?;
    let lang = language(&app);
    let Some(folder) = select_path(&app, move || {
        rfd::AsyncFileDialog::new()
            .set_parent(&window)
            .set_directory(directory)
            .set_title(lang.text(
                "选择新作品库的保存位置",
                "Choose a location for the new library",
            ))
            .set_can_create_directories(true)
            .pick_folder()
    })
    .await?
    else {
        return Ok(None);
    };
    let root = workspace::create_workspace(&folder, &name, None, None)?;
    Ok(Some(remember(&app, &root)?))
}
#[tauri::command]
async fn restore_workspace(app: AppHandle, window: WebviewWindow) -> Result<Option<Recent>> {
    home_only(&window)?;
    let state = app.state::<DesktopState>();
    let _operation = operation(&state)?;
    let backups = storage_directory(&app, "backups")?;
    let directory = storage_directory(&app, "workspaces")?;
    let parent = window.clone();
    let lang = language(&app);
    let Some(archive) = select_path(&app, move || {
        rfd::AsyncFileDialog::new()
            .set_parent(&parent)
            .set_directory(backups)
            .set_title(lang.text("选择 Viento 迁移包", "Choose a Viento project archive"))
            .add_filter(
                lang.text("Viento 迁移包", "Viento project archive"),
                &["zip"],
            )
            .pick_file()
    })
    .await?
    else {
        return Ok(None);
    };
    let lang = language(&app);
    let Some(folder) = select_path(&app, move || {
        rfd::AsyncFileDialog::new()
            .set_parent(&window)
            .set_directory(directory)
            .set_title(lang.text(
                "选择导入位置（会创建新文件夹）",
                "Choose import location (creates a new folder)",
            ))
            .set_can_create_directories(true)
            .pick_folder()
    })
    .await?
    else {
        return Ok(None);
    };
    let root = workspace::import_workspace(&archive, &folder)?;
    Ok(Some(remember(&app, &root)?))
}
#[tauri::command]
async fn backup_workspace(
    app: AppHandle,
    window: WebviewWindow,
    path: String,
) -> Result<Option<String>> {
    home_only(&window)?;
    let state = app.state::<DesktopState>();
    let _operation = operation(&state)?;
    let root = registered(&app, &path)?;
    let manifest = workspace::ensure_workspace(&root)?;
    let backups = storage_directory(&app, "backups")?;
    let lang = language(&app);
    let Some(output) = select_path(&app, move || {
        rfd::AsyncFileDialog::new()
            .set_parent(&window)
            .set_directory(backups)
            .set_title(lang.text(
                "导出已保存的正文、模板和素材",
                "Export saved documents, templates and media",
            ))
            .set_file_name(format!("{}-{}.viento.zip", manifest.name, workspace::now()))
            .add_filter(
                lang.text("Viento 迁移包", "Viento project archive"),
                &["zip"],
            )
            .save_file()
    })
    .await?
    else {
        return Ok(None);
    };
    workspace::export_workspace(&root, &output)?;
    Ok(Some(output.to_string_lossy().into()))
}
#[tauri::command]
fn reveal_workspace(app: AppHandle, window: WebviewWindow, path: String) -> Result<()> {
    home_only(&window)?;
    app.opener()
        .open_path(registered(&app, &path)?.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}
fn show_library(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
    if let Some(window) = app.get_webview_window("editor") {
        let _ = window.hide();
    }
    let _ = app.emit_to("main", "library-changed", ());
}

async fn save_editor_export(app: AppHandle, engine_id: String, id: String, file_name: String) {
    let result: Result<Option<String>> = async {
        let state = app.state::<DesktopState>();
        let _operation = operation(&state)?;
        if Uuid::parse_str(&id)
            .map(|value| value.to_string())
            .as_deref()
            != Ok(id.as_str())
            || file_name.contains(['/', '\\'])
            || !file_name.ends_with(".zip")
        {
            return Err("无效的导出任务".into());
        }
        let root = state
            .engine
            .lock()
            .map_err(|e| e.to_string())?
            .as_ref()
            .filter(|engine| engine.id == engine_id)
            .map(|engine| PathBuf::from(&engine.workspace.path))
            .ok_or("作品已关闭")?;
        let editor = app.get_webview_window("editor").ok_or("编辑窗口已关闭")?;
        let directory = match app.path().download_dir() {
            Ok(directory) => directory,
            Err(_) => storage_directory(&app, "exports")?,
        };
        let lang = language(&app);
        let Some(destination) = select_path(&app, move || {
            rfd::AsyncFileDialog::new()
                .set_parent(&editor)
                .set_directory(directory)
                .set_title(lang.text("保存导出文件", "Save exported file"))
                .set_file_name(file_name)
                .add_filter(lang.text("ZIP 文件", "ZIP file"), &["zip"])
                .save_file()
        })
        .await?
        else {
            return Ok(None);
        };
        let output = destination.to_string_lossy().into_owned();
        let job_id = id.clone();
        tauri::async_runtime::spawn_blocking(move || {
            export::save_prepared_export(&root, &job_id, &destination)
        })
        .await
        .map_err(|e| e.to_string())??;
        Ok(Some(output))
    }
    .await;
    let detail = match result {
        Ok(Some(path)) => serde_json::json!({ "id": id, "ok": true, "path": path }),
        Ok(None) => serde_json::json!({ "id": id, "ok": true, "cancelled": true }),
        Err(error) => serde_json::json!({ "id": id, "ok": false, "error": error }),
    };
    if let Some(editor) = app.get_webview_window("editor") {
        let _ = editor.eval(&format!(
            "window.dispatchEvent(new CustomEvent('viento-export-result', {{detail: {detail}}}));"
        ));
    }
}
fn stop_engine(app: &AppHandle) {
    let state = app.state::<DesktopState>();
    if let Ok(mut engine) = state.engine.lock() {
        if let Some(engine) = engine.take() {
            let _ = engine.child.kill();
        }
    }
    state.engine_alive.store(false, Ordering::SeqCst);
}
fn finish_close(app: &AppHandle, allow: bool) {
    let state = app.state::<DesktopState>();
    if !state.close_pending.swap(false, Ordering::SeqCst) {
        return;
    }
    let exit = state.exit_after_close.swap(false, Ordering::SeqCst);
    if allow {
        if let Some(editor) = app.get_webview_window("editor") {
            let _ = editor.destroy();
        }
        stop_engine(app);
        if exit {
            app.exit(0);
        } else {
            show_library(app);
        }
    }
}
const CLOSE_SCRIPT: &str = r#"(async () => {
  const {t} = await import('/web/i18n/index.js');
  let allow = false;
  if (document.querySelector('#docEditPanel')?.getAttribute('aria-busy') === 'true' || document.querySelector('#projectSettingsDialog')?.getAttribute('aria-busy') === 'true') {
    window.alert(t('正在保存、导出或更新预览，请完成后再关闭。'));
  } else {
    const dirty = document.querySelector('#docEditDirtyIndicator')?.classList.contains('is-unsaved') || document.querySelector('#projectSettingsDialog')?.dataset.dirty === 'true';
    allow = !dirty || window.confirm(t('还有未保存的修改。关闭编辑窗口将丢弃这些修改，确定关闭？')) === true;
  }
  await fetch('/__desktop/close-response', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({allow})});
})().catch(() => window.alert(document.documentElement.lang === 'en' ? 'Cannot contact the local service. Copy your unsaved work somewhere safe before closing.' : '无法联系本地服务，请先复制保存未保存的内容，再关闭窗口。'));"#;
fn request_close(app: &AppHandle, exit: bool) {
    let state = app.state::<DesktopState>();
    if state.close_pending.swap(true, Ordering::SeqCst) {
        return;
    }
    state.exit_after_close.store(exit, Ordering::SeqCst);
    if let Some(editor) = app.get_webview_window("editor") {
        let _ = editor.show();
        let _ = editor.set_focus();
        if state.engine_alive.load(Ordering::SeqCst) && editor.eval(CLOSE_SCRIPT).is_ok() {
            return;
        }
        let handle = app.clone();
        let lang = language(app);
        if app
            .run_on_main_thread(move || {
                let dialog = rfd::AsyncMessageDialog::new()
                    .set_parent(&editor)
                    .set_description(
                        lang.text("本地服务已停止。请确认未保存内容已复制到安全位置，然后关闭编辑窗口。", "The local service stopped. Copy unsaved work somewhere safe before closing."),
                    )
                    .set_title(lang.text("关闭编辑窗口", "Close editor"))
                    .set_buttons(rfd::MessageButtons::OkCancel)
                    .show();
                tauri::async_runtime::spawn(async move {
                    finish_close(&handle, dialog.await == rfd::MessageDialogResult::Ok);
                });
            })
            .is_err()
        {
            finish_close(app, false);
        }
    } else {
        finish_close(app, true);
    }
}
#[tauri::command]
fn resume_editor(app: AppHandle, window: WebviewWindow) -> Result<()> {
    home_only(&window)?;
    if let Some(editor) = app.get_webview_window("editor") {
        editor.show().map_err(|e| e.to_string())?;
        editor.set_focus().map_err(|e| e.to_string())?;
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}
#[tauri::command]
fn close_editor(app: AppHandle, window: WebviewWindow) -> Result<()> {
    home_only(&window)?;
    request_close(&app, false);
    Ok(())
}

async fn start_editor(app: &AppHandle, root: &Path) -> Result<()> {
    if app.get_webview_window("editor").is_some() {
        return Err("请先保存并关闭当前编辑窗口，再切换作品库".into());
    }
    let recent = remember(app, root)?;
    let lock_path = root.join(".viento/session.lock");
    if fs::symlink_metadata(&lock_path)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err("作品库锁文件不能是链接".into());
    }
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(lock_path)
        .map_err(|e| e.to_string())?;
    FileExt::try_lock_exclusive(&lock).map_err(|_| "这个作品库已在另一个桌面会话中打开")?;
    let runtime = runtime_root(app)?;
    let token = Uuid::new_v4().simple().to_string();
    let id = Uuid::new_v4().to_string();
    let (mut events, child) = app
        .shell()
        .sidecar("viento-node")
        .map_err(|e| e.to_string())?
        .arg(runtime.join("scripts/desktop-server.mjs"))
        .current_dir(root)
        .env("VIENTO_APP_ROOT", &runtime)
        .env("VIENTO_WORKSPACE_ROOT", root)
        .env("VIENTO_SESSION_TOKEN", &token)
        .env("VIENTO_PREFERENCES_PATH", preferences_path(app)?)
        .env("PORT", "0")
        .env("DOC_API_HOST", "127.0.0.1")
        .env("DOC_API_REQUIRE_WRITE_AUTH", "0")
        .env("DOC_API_TOKEN", "")
        .env("DOC_API_WRITE_TOKEN", "")
        .env("DOC_API_TRUST_PROXY", "0")
        .env("NODE_OPTIONS", "")
        .env("NODE_PATH", "")
        .env("DOC_API_SECURITY_AUDIT", "0")
        .spawn()
        .map_err(|e| format!("无法启动内置处理服务：{e}"))?;
    let state = app.state::<DesktopState>();
    state.engine_alive.store(true, Ordering::SeqCst);
    *state.engine.lock().map_err(|e| e.to_string())? = Some(Engine {
        id: id.clone(),
        child,
        workspace: recent.clone(),
        _lock: lock,
    });
    let (ready_tx, ready_rx) = oneshot::channel::<Result<u16>>();
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut ready = Some(ready_tx);
        let mut errors = String::new();
        while let Some(event) = events.recv().await {
            let state = handle.state::<DesktopState>();
            let is_current = state
                .engine
                .lock()
                .ok()
                .and_then(|engine| engine.as_ref().map(|engine| engine.id == id))
                .unwrap_or(false);
            if !is_current {
                break;
            }
            match event {
                CommandEvent::Stdout(bytes) => {
                    for line in String::from_utf8_lossy(&bytes).lines() {
                        let Some(json) = line.strip_prefix("VIENTO_EVENT ") else {
                            continue;
                        };
                        let Ok(event) = serde_json::from_str::<serde_json::Value>(json) else {
                            continue;
                        };
                        match event["type"].as_str() {
                            Some("ready") => {
                                if let Some(port) =
                                    event["port"].as_u64().filter(|p| *p > 0 && *p <= 65535)
                                {
                                    if let Some(sender) = ready.take() {
                                        let _ = sender.send(Ok(port as u16));
                                    }
                                }
                            }
                            Some("library") => show_library(&handle),
                            Some("preferences") => {
                                if let (Some(request_id), Ok(selected)) = (
                                    event["id"]
                                        .as_str()
                                        .filter(|value| Uuid::parse_str(value).is_ok()),
                                    serde_json::from_value::<Language>(event["language"].clone()),
                                ) {
                                    let result = update_language(&handle, selected);
                                    let detail = serde_json::json!({ "id": request_id, "ok": result.is_ok(), "error": result.err() });
                                    if let Some(editor) = handle.get_webview_window("editor") {
                                        let _ = editor.eval(&format!("window.dispatchEvent(new CustomEvent('viento-language-result', {{detail: {detail}}}));"));
                                    }
                                }
                            }
                            Some("export") => {
                                if let (Some(job_id), Some(file_name)) =
                                    (event["id"].as_str(), event["fileName"].as_str())
                                {
                                    tauri::async_runtime::spawn(save_editor_export(
                                        handle.clone(),
                                        id.clone(),
                                        job_id.into(),
                                        file_name.into(),
                                    ));
                                }
                            }
                            Some("close-response") => {
                                if let Some(allow) = event["allow"].as_bool() {
                                    finish_close(&handle, allow);
                                }
                            }
                            _ => {}
                        }
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    if errors.len() < 8192 {
                        errors.push_str(&String::from_utf8_lossy(&bytes));
                    }
                }
                CommandEvent::Error(error) => {
                    errors.push_str(&error);
                }
                CommandEvent::Terminated(_) => {
                    state.engine_alive.store(false, Ordering::SeqCst);
                    state.close_pending.store(false, Ordering::SeqCst);
                    let message = format!("本地处理服务已停止。{}", errors.trim());
                    if let Some(sender) = ready.take() {
                        let _ = sender.send(Err(message.clone()));
                    }
                    let _ = handle.emit_to("main", "library-error", message);
                    break;
                }
                _ => {}
            }
        }
    });
    let port = match tokio::time::timeout(std::time::Duration::from_secs(120), ready_rx).await {
        Ok(Ok(Ok(port))) => port,
        Ok(Ok(Err(error))) => {
            stop_engine(app);
            return Err(error);
        }
        _ => {
            stop_engine(app);
            return Err("作品库打开超时，请检查数据目录与磁盘空间后重试".into());
        }
    };
    let url = format!("http://127.0.0.1:{port}/__desktop/session/{token}")
        .parse::<tauri::Url>()
        .map_err(|e| e.to_string())?;
    let editor = WebviewWindowBuilder::new(app, "editor", WebviewUrl::External(url))
        .title(format!(
            "{} · Viento Studio {}",
            recent.name,
            release_version()
        ))
        .inner_size(1280.0, 820.0)
        .min_inner_size(760.0, 540.0)
        .center()
        .on_navigation(move |url| {
            url.scheme() == "http"
                && url.host_str() == Some("127.0.0.1")
                && url.port() == Some(port)
        })
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .build();
    match editor {
        Ok(window) => {
            let _ = window.set_focus();
            if let Some(main) = app.get_webview_window("main") {
                let _ = main.hide();
            }
        }
        Err(error) => {
            stop_engine(app);
            return Err(format!("编辑窗口创建失败：{error}"));
        }
    }
    Ok(())
}
#[tauri::command]
async fn launch_workspace(app: AppHandle, window: WebviewWindow, path: String) -> Result<()> {
    home_only(&window)?;
    let state = app.state::<DesktopState>();
    let _operation = operation(&state)?;
    start_editor(&app, &registered(&app, &path)?).await
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            show_library(app)
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .manage(DesktopState::default())
        .setup(|app| {
            if let Some(main) = app.get_webview_window("main") {
                main.set_title(&format!(
                    "Viento Studio {} · {}",
                    release_version(),
                    language(app.handle()).text("作品库", "Library")
                ))?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            library_state,
            get_language,
            set_language,
            choose_workspace,
            new_workspace,
            restore_workspace,
            backup_workspace,
            launch_workspace,
            reveal_workspace,
            resume_editor,
            close_editor
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                let state = app.state::<DesktopState>();
                if state.operation_active.load(Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = app.emit_to("main", "library-error", "正在处理文件，请完成后再关闭。");
                } else if window.label() == "editor" || app.get_webview_window("editor").is_some() {
                    api.prevent_close();
                    request_close(app, window.label() == "main");
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("无法初始化 Viento Studio")
        .run(|app, event| {
            match event {
                // System/menu Quit (including Cmd+Q) must use the same draft
                // protection as closing a window. Explicit app.exit(0) follows
                // the user's already-confirmed close and may proceed.
                tauri::RunEvent::ExitRequested {
                    code: None, api, ..
                } => {
                    let state = app.state::<DesktopState>();
                    if state.operation_active.load(Ordering::SeqCst) {
                        api.prevent_exit();
                        let _ =
                            app.emit_to("main", "library-error", "正在处理文件，请完成后再退出。");
                    } else if app.get_webview_window("editor").is_some() {
                        api.prevent_exit();
                        request_close(app, true);
                    }
                }
                tauri::RunEvent::Exit => stop_engine(app),
                _ => {}
            }
        });
}
