//! JSON-lines test adapter for the Android storage implementation on the host.
//! Used with temporary directories only; it is not packaged in the application.
#![allow(dead_code)]
#[path = "../src/mobile_storage.rs"]
mod mobile_storage;
#[path = "../src/workspace.rs"]
mod workspace;
use mobile_storage::{MobileLibrary, StorageError};
use serde_json::{json, Value};
use std::io::{BufRead, Write};

fn main() {
    let root = std::env::args()
        .nth(1)
        .expect("Usage: mobile-storage TEMP_LIBRARY_ROOT");
    let library = MobileLibrary::new(root.into()).expect("open temporary library");
    for line in std::io::stdin().lock().lines() {
        let request: Value = serde_json::from_str(&line.unwrap()).expect("JSON request");
        let bad = || StorageError {
            status_code: 400,
            message: "bad request".into(),
            error_code: "bad request".into(),
            payload: json!({}),
        };
        let id = request["workspaceId"].as_str().unwrap_or("");
        let path = request["path"].as_str().unwrap_or("");
        let result = match request["action"].as_str().unwrap_or("") {
            "list" => library.list(),
            "create" => library.create(request["payload"]["name"].as_str().unwrap_or("")),
            "context" => library.context(id),
            "importArchive" => library.import_archive(std::path::Path::new(path)),
            "exportArchive" => library.export_archive(id, std::path::Path::new(path)),
            "resolve" => library.resolve(id, path),
            "read" | "template" => library
                .read(id, path, request["action"] == "template")
                .map(|value| serde_json::to_value(value).unwrap()),
            "save" => serde_json::from_value(request["payload"].clone())
                .map_err(|_| bad())
                .and_then(|value| library.save(id, value))
                .map(|value| serde_json::to_value(value).unwrap()),
            _ => Err(bad()),
        };
        println!(
            "{}",
            match result {
                Ok(data) => json!({"data":data}),
                Err(error) => json!({"error":error}),
            }
        );
        std::io::stdout().flush().unwrap();
    }
}
