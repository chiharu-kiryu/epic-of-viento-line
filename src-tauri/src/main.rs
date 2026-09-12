#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "linux")]
mod media_runtime;

fn main() {
    #[cfg(target_os = "linux")]
    media_runtime::prepare_appimage_media();
    viento_studio::run();
}
