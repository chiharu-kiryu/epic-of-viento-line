//! Command-line access to the same archive implementation used by the desktop UI.
use std::path::Path;
use viento_studio::workspace;

fn run() -> workspace::Result<serde_json::Value> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.as_slice() {
        [command, parent, name] if command == "create" => {
            let root = workspace::create_workspace(Path::new(parent), name, None, None)?;
            Ok(serde_json::json!({"root": root}))
        }
        [command, root, destination] if command == "export" => {
            let files = workspace::export_workspace(Path::new(root), Path::new(destination))?;
            Ok(serde_json::json!({"archive": destination, "files": files}))
        }
        [command, archive, parent] if command == "import" => {
            let root = workspace::import_workspace(Path::new(archive), Path::new(parent))?;
            Ok(serde_json::json!({"root": root}))
        }
        [command, archive] if command == "verify" => {
            // Import performs all format, path, size and SHA-256 checks. The
            // restored workspace is deleted even when verification fails.
            let temporary = tempfile::tempdir().map_err(|error| error.to_string())?;
            workspace::import_workspace(Path::new(archive), temporary.path())?;
            Ok(serde_json::json!({"archive": archive, "restoredAndVerified": true}))
        }
        _ => Err(
            "Usage: workspace-archive create PARENT NAME | export ROOT ARCHIVE | import ARCHIVE PARENT | verify ARCHIVE"
                .into(),
        ),
    }
}

fn main() {
    match run() {
        Ok(value) => println!("{value}"),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
