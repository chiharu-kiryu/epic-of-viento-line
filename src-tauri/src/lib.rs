#[cfg(not(mobile))]
mod close_state;
#[cfg(not(mobile))]
mod export;
#[cfg(not(mobile))]
mod preferences;
pub mod workspace;
#[cfg(not(mobile))]
mod desktop_host;
#[cfg(any(mobile, test))]
mod mobile_storage;
#[cfg(mobile)]
mod mobile_host;
#[cfg(target_os = "android")]
mod mobile_transfer;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(not(mobile))]
    desktop_host::run();
    #[cfg(mobile)]
    mobile_host::run();
}
