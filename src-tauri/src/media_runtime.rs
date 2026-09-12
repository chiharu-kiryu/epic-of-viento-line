use std::ffi::OsString;
use std::path::PathBuf;

fn plugin_paths(existing: Option<OsString>, candidates: &[PathBuf]) -> Option<OsString> {
    let mut paths: Vec<PathBuf> = existing
        .as_ref()
        .map(|value| {
            std::env::split_paths(value)
                .filter(|path| !path.as_os_str().is_empty())
                .collect()
        })
        .unwrap_or_default();
    for candidate in candidates {
        if candidate.is_dir() && !paths.contains(candidate) {
            paths.push(candidate.clone());
        }
    }
    std::env::join_paths(paths).ok()
}

// AppRun replaces GStreamer's default system search path with its bundle path.
// The WebKit media libraries still need the host's decoder and appsink plugins.
// Set this before Tauri creates GTK/WebKit threads, including when launched by
// double-clicking the portable AppImage without an installed shell wrapper.
pub fn prepare_appimage_media() {
    if std::env::var_os("APPDIR").is_none() {
        return;
    }
    let architecture = std::env::consts::ARCH;
    let candidates = [
        PathBuf::from(format!("/usr/lib/{architecture}-linux-gnu/gstreamer-1.0")),
        PathBuf::from("/usr/lib64/gstreamer-1.0"),
        PathBuf::from("/usr/lib/gstreamer-1.0"),
    ];
    let existing =
        std::env::var_os("GST_PLUGIN_PATH_1_0").or_else(|| std::env::var_os("GST_PLUGIN_PATH"));
    if let Some(paths) = plugin_paths(existing, &candidates) {
        std::env::set_var("GST_PLUGIN_PATH_1_0", paths);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_custom_plugins_and_adds_only_existing_unique_system_directories() {
        let directory = tempfile::tempdir().unwrap();
        let system = directory.path().join("system");
        std::fs::create_dir(&system).unwrap();
        let custom = directory.path().join("custom");
        let existing = std::env::join_paths([&custom, &system]).unwrap();
        let result = plugin_paths(
            Some(existing),
            &[system.clone(), directory.path().join("missing")],
        )
        .unwrap();
        assert_eq!(
            std::env::split_paths(&result).collect::<Vec<_>>(),
            vec![custom, system.clone()]
        );
        let clean = plugin_paths(None, &[system.clone()]).unwrap();
        assert_eq!(
            std::env::split_paths(&clean).collect::<Vec<_>>(),
            vec![system]
        );
    }
}
