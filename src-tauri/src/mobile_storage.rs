//! Application-private storage. No command accepts an absolute filesystem path.
use crate::workspace;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};
use tempfile::NamedTempFile;
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;

#[path = "mobile_archive.rs"]
mod archive;

const MAX_TEXT: usize = 1024 * 1024;
const MAX_DOCUMENTS: usize = 20_000;
const DEFAULTS: &str = include_str!("../../scripts/lib/project-defaults.json");
type Result<T> = std::result::Result<T, StorageError>;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageError {
    pub status_code: u16,
    pub message: String,
    pub error_code: String,
    pub payload: Value,
}
pub(crate) fn error(status_code: u16, message: &str) -> StorageError {
    StorageError {
        status_code,
        message: message.into(),
        error_code: message.into(),
        payload: json!({}),
    }
}
fn io(error_value: std::io::Error) -> StorageError {
    use std::io::ErrorKind;
    match error_value.kind() {
        ErrorKind::NotFound => error(404, "doc not found"),
        ErrorKind::AlreadyExists => error(409, "already exists"),
        ErrorKind::PermissionDenied => error(403, "forbidden"),
        _ => error(500, "无法访问本机作品数据"),
    }
}
fn workspace_error(message: String) -> StorageError {
    error(400, &message)
}
fn real_directory(path: &Path) -> Result<()> {
    let stat = fs::symlink_metadata(path).map_err(io)?;
    if !stat.is_dir() || stat.file_type().is_symlink() {
        return Err(error(403, "bad path"));
    }
    Ok(())
}
fn key(value: &str) -> String {
    value.nfc().collect::<String>().to_lowercase()
}
fn logical(value: &str) -> Result<&str> {
    if value.is_empty()
        || value.len() > 4096
        || value
            .split('/')
            .any(|part| !workspace::portable_component(part))
    {
        return Err(error(400, "bad path"));
    }
    Ok(value)
}
fn contained(root: &Path, relative: &str, create_parents: bool) -> Result<PathBuf> {
    logical(relative)?;
    real_directory(root)?;
    let parts: Vec<_> = relative.split('/').collect();
    let mut current = root.to_path_buf();
    for (index, part) in parts.iter().enumerate() {
        current.push(part);
        match fs::symlink_metadata(&current) {
            Ok(stat) if stat.file_type().is_symlink() => return Err(error(403, "bad path")),
            Ok(stat) if index + 1 != parts.len() && !stat.is_dir() => {
                return Err(error(409, "already exists"))
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                if create_parents && index + 1 != parts.len() {
                    fs::create_dir(&current).map_err(io)?;
                }
            }
            Err(e) => return Err(io(e)),
        }
    }
    Ok(current)
}
fn read_text(path: &Path) -> Result<String> {
    read_limited_text(path, MAX_TEXT)
}
fn read_limited_text(path: &Path, limit: usize) -> Result<String> {
    let file = fs::File::open(path).map_err(io)?;
    if !file.metadata().map_err(io)?.is_file() {
        return Err(error(400, "bad path"));
    }
    use std::io::Read;
    let mut bytes = Vec::new();
    file.take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(io)?;
    if bytes.len() > limit {
        return Err(error(413, "文档过大，请在桌面版中编辑"));
    }
    String::from_utf8(bytes).map_err(|_| error(400, "文档不是有效的 UTF-8 文本"))
}
fn json_file(path: &Path) -> Result<Value> {
    serde_json::from_str(&read_text(path)?)
        .map_err(|_| error(400, "作品数据格式无效，原文件已保留"))
}
fn revision(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}
fn atomic_text(path: &Path, text: &str, exclusive: bool) -> Result<()> {
    let parent = path.parent().ok_or_else(|| error(400, "bad path"))?;
    real_directory(parent)?;
    let mut temporary = NamedTempFile::new_in(parent).map_err(io)?;
    if !exclusive {
        temporary
            .as_file()
            .set_permissions(fs::metadata(path).map_err(io)?.permissions())
            .map_err(io)?;
    }
    temporary.write_all(text.as_bytes()).map_err(io)?;
    temporary.as_file().sync_all().map_err(io)?;
    if exclusive {
        temporary.persist_noclobber(path).map_err(|e| io(e.error))?;
    } else {
        temporary.persist(path).map_err(|e| io(e.error))?;
    }
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub path: String,
    pub content: String,
    pub version: String,
    pub modified_at: u64,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveRequest {
    pub path: String,
    pub content: String,
    #[serde(default)]
    pub create: bool,
    pub expected_version: Option<String>,
    pub document_type: Option<String>,
}

pub struct MobileLibrary {
    root: PathBuf,
}
impl MobileLibrary {
    pub fn new(root: PathBuf) -> Result<Self> {
        fs::create_dir_all(&root).map_err(io)?;
        real_directory(&root)?;
        // Only unpublished imports live here. A terminated import is never a
        // library item and can be discarded safely on the next cold start.
        let pending = root.join(".mobile-import");
        if pending.try_exists().map_err(io)? {
            real_directory(&pending)?;
            fs::remove_dir_all(pending).map_err(io)?;
        }
        Ok(Self { root })
    }
    fn projects(&self) -> Result<Vec<(PathBuf, workspace::Workspace)>> {
        real_directory(&self.root)?;
        let mut result = Vec::new();
        let mut ids = HashSet::new();
        for item in fs::read_dir(&self.root).map_err(io)? {
            let item = item.map_err(io)?;
            let path = item.path();
            if item.file_name() == ".mobile-import" {
                continue;
            }
            if item.file_type().map_err(io)?.is_symlink() {
                return Err(error(403, "bad path"));
            }
            if !path.is_dir() || !path.join("workspace.json").is_file() {
                continue;
            }
            let workspace = workspace::ensure_workspace(&path).map_err(workspace_error)?;
            if !ids.insert(workspace.id.clone()) {
                return Err(error(409, "作品标识重复，请在桌面版中检查"));
            }
            result.push((path, workspace));
        }
        result.sort_by(|a, b| {
            b.1.created_at
                .cmp(&a.1.created_at)
                .then(a.1.id.cmp(&b.1.id))
        });
        Ok(result)
    }
    fn project(&self, id: &str) -> Result<(PathBuf, workspace::Workspace)> {
        Uuid::parse_str(id).map_err(|_| error(400, "bad path"))?;
        let project = self
            .projects()?
            .into_iter()
            .find(|(_, value)| value.id == id)
            .ok_or_else(|| error(404, "作品不存在"))?;
        Self::recover_creations(&project.0, &project.1)?;
        Ok(project)
    }
    pub fn list(&self) -> Result<Value> {
        Ok(json!(self
            .projects()?
            .into_iter()
            .map(|(_, value)| value)
            .collect::<Vec<_>>()))
    }
    pub fn create(&self, name: &str) -> Result<Value> {
        real_directory(&self.root)?;
        let path =
            workspace::create_workspace(&self.root, name, None, None).map_err(workspace_error)?;
        Ok(
            serde_json::to_value(workspace::ensure_workspace(&path).map_err(workspace_error)?)
                .unwrap(),
        )
    }
    fn source_path<'a>(
        manifest: &workspace::Workspace,
        path: &'a str,
        template: bool,
    ) -> Result<&'a str> {
        let path = path.strip_prefix("docs-standard/").unwrap_or(path);
        logical(path)?;
        let prefix = match (manifest.version, template) {
            (3, false) => "documents/",
            (3, true) => "templates/",
            (_, false) => "design-data/",
            (_, true) => "data-template/",
        };
        if !path.starts_with(prefix) {
            return Err(error(400, "bad path"));
        }
        Ok(path)
    }
    fn documents(root: &Path, manifest: &workspace::Workspace) -> Result<Vec<Value>> {
        let directory = contained(root, "metadata/documents", false)?;
        if !directory.exists() {
            return Ok(Vec::new());
        }
        real_directory(&directory)?;
        let mut records = Vec::new();
        let mut sources = HashSet::new();
        for entry in fs::read_dir(directory).map_err(io)? {
            let entry = entry.map_err(io)?;
            if entry.file_type().map_err(io)?.is_symlink() {
                return Err(error(403, "bad path"));
            }
            let filename = entry.file_name().to_string_lossy().to_string();
            if !filename.ends_with(".json") {
                continue;
            }
            if records.len() >= MAX_DOCUMENTS {
                return Err(error(413, "文档数量过多，请在桌面版中打开"));
            }
            let record = json_file(&entry.path())?;
            let id = record["id"]
                .as_str()
                .ok_or_else(|| error(400, "invalid document registry"))?;
            Uuid::parse_str(id).map_err(|_| error(400, "invalid document registry"))?;
            let source = record["sourcePath"]
                .as_str()
                .ok_or_else(|| error(400, "invalid document registry"))?;
            if Self::source_path(manifest, source, false)? != source {
                return Err(error(400, "invalid document registry"));
            }
            if filename != format!("{id}.json")
                || record["format"] != "viento-document"
                || record["version"] != 1
                || !record["assetBindings"].is_array()
                || !sources.insert(key(source))
            {
                return Err(error(400, "invalid document registry"));
            }
            records.push(record);
        }
        workspace::validate_document_models(&records).map_err(workspace_error)?;
        records.sort_by(|a, b| a["sourcePath"].as_str().cmp(&b["sourcePath"].as_str()));
        Ok(records)
    }
    pub fn context(&self, id: &str) -> Result<Value> {
        let (root, manifest) = self.project(id)?;
        let documents = Self::documents(&root, &manifest)?;
        Ok(
            json!({ "manifest": manifest, "documents": documents, "defaults": serde_json::from_str::<Value>(DEFAULTS).unwrap() }),
        )
    }
    pub fn resolve(&self, id: &str, source: &str) -> Result<Value> {
        let (root, manifest) = self.project(id)?;
        let source = Self::source_path(&manifest, source, false)?;
        let target = contained(&root, source, false)?;
        Ok(json!({ "path": source, "exists": target.is_file() }))
    }
    pub fn read(&self, id: &str, source: &str, template: bool) -> Result<Snapshot> {
        let (root, manifest) = self.project(id)?;
        let source = Self::source_path(&manifest, source, template)?;
        let target = contained(&root, source, false)?;
        let content = read_text(&target)?;
        let modified_at = fs::metadata(target)
            .map_err(io)?
            .modified()
            .map_err(io)?
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        Ok(Snapshot {
            path: source.into(),
            version: revision(content.as_bytes()),
            content,
            modified_at,
        })
    }
    fn check_new_location(root: &Path, source: &str, records: &[Value]) -> Result<()> {
        let parts: Vec<_> = source.split('/').collect();
        let extension = parts
            .last()
            .unwrap()
            .rsplit_once('.')
            .map(|(_, ext)| ext.to_lowercase())
            .unwrap_or_default();
        if parts
            .iter()
            .any(|part| part.starts_with('.') || *part == "node_modules" || part.len() > 255)
            || !["", "md", "txt", "json", "yaml", "yml"].contains(&extension.as_str())
        {
            return Err(error(400, "bad path"));
        }
        for record in records {
            let previous: Vec<_> = record["sourcePath"].as_str().unwrap().split('/').collect();
            let mut shared = true;
            for (left, right) in parts.iter().zip(previous.iter()) {
                if key(left) != key(right) {
                    shared = false;
                    break;
                }
                if left != right {
                    return Err(error(409, "already exists"));
                }
            }
            if shared {
                return Err(error(409, "already exists"));
            }
        }
        let mut directory = root.to_path_buf();
        for (index, part) in parts.iter().enumerate() {
            if !directory.exists() {
                break;
            }
            for entry in fs::read_dir(&directory).map_err(io)? {
                let entry = entry.map_err(io)?;
                let name = entry.file_name().to_string_lossy().to_string();
                if key(&name) == key(part)
                    && (name != *part
                        || index + 1 == parts.len()
                        || !entry.file_type().map_err(io)?.is_dir())
                {
                    return Err(error(409, "already exists"));
                }
            }
            directory.push(part);
        }
        Ok(())
    }
    // A new document spans two files. Retain a durable intent until both are
    // published so Android process termination cannot strand its registry.
    fn recover_creations(root: &Path, manifest: &workspace::Workspace) -> Result<()> {
        let directory = contained(root, ".viento/mobile-create", false)?;
        if !directory.exists() {
            return Ok(());
        }
        real_directory(&directory)?;
        for entry in fs::read_dir(&directory).map_err(io)? {
            let entry = entry.map_err(io)?;
            let filename = entry.file_name().to_string_lossy().into_owned();
            if !filename.ends_with(".json") {
                continue;
            }
            let intent_path = contained(root, &format!(".viento/mobile-create/{filename}"), false)?;
            // JSON can expand each source control byte to a six-byte escape.
            let intent: Value =
                serde_json::from_str(&read_limited_text(&intent_path, MAX_TEXT * 6 + 16384)?)
                    .map_err(|_| error(400, "作品数据格式无效，原文件已保留"))?;
            let record = &intent["record"];
            let id = record["id"]
                .as_str()
                .ok_or_else(|| error(400, "invalid document registry"))?;
            Uuid::parse_str(id).map_err(|_| error(400, "invalid document registry"))?;
            let source = record["sourcePath"]
                .as_str()
                .ok_or_else(|| error(400, "bad path"))?;
            if filename != format!("{id}.json")
                || Self::source_path(manifest, source, false)? != source
                || record["format"] != "viento-document"
                || record["version"] != 1
                || !record["assetBindings"].is_array()
            {
                return Err(error(400, "invalid document registry"));
            }
            workspace::validate_document_models(&[record.clone()]).map_err(workspace_error)?;
            let content = intent["content"]
                .as_str()
                .filter(|text| text.len() <= MAX_TEXT)
                .ok_or_else(|| error(400, "作品数据格式无效，原文件已保留"))?;
            let records = Self::documents(root, manifest)?;
            if records.iter().any(|other| {
                other["id"] != id && key(other["sourcePath"].as_str().unwrap()) == key(source)
            }) {
                return Err(error(409, "already exists"));
            }
            let target = contained(root, source, true)?;
            let registry = contained(root, &format!("metadata/documents/{id}.json"), true)?;
            if (registry.exists() && json_file(&registry)? != *record)
                || (target.exists() && read_text(&target)? != content)
            {
                return Err(error(409, "conflict"));
            }
            if !registry.exists() {
                atomic_text(
                    &registry,
                    &(serde_json::to_string_pretty(record).unwrap() + "\n"),
                    true,
                )?;
            }
            if !target.exists() {
                atomic_text(&target, content, true)?;
            }
            fs::remove_file(intent_path).map_err(io)?;
        }
        Ok(())
    }
    pub fn save(&self, id: &str, request: SaveRequest) -> Result<Snapshot> {
        if request.content.len() > MAX_TEXT {
            return Err(error(413, "文档过大，请在桌面版中编辑"));
        }
        let (root, manifest) = self.project(id)?;
        let source = Self::source_path(&manifest, &request.path, false)?;
        let target = contained(&root, source, false)?;
        let mut registered = None;
        let mut intent = None;
        if request.create {
            let records = Self::documents(&root, &manifest)?;
            if records.len() >= MAX_DOCUMENTS {
                return Err(error(413, "文档数量过多，请在桌面版中打开"));
            }
            Self::check_new_location(&root, source, &records)?;
            let defaults: Value = serde_json::from_str(DEFAULTS).unwrap();
            let types = manifest
                .extra
                .get("documentTypes")
                .unwrap_or(&defaults["documentTypes"])
                .as_array()
                .ok_or_else(|| error(400, "invalid document type"))?;
            let selected = request.document_type.as_deref().unwrap_or("document");
            let definition = types
                .iter()
                .find(|value| value["id"] == selected)
                .ok_or_else(|| error(400, "invalid document type"))?;
            let record_id = Uuid::new_v4().to_string();
            let record_path =
                contained(&root, &format!("metadata/documents/{record_id}.json"), true)?;
            let record = json!({ "format": "viento-document", "version": 1, "id": record_id, "sourcePath": source,
                "documentType": selected, "parserProfile": definition["parserProfile"], "relations": [], "assetBindings": [] });
            let intent_path = contained(
                &root,
                &format!(".viento/mobile-create/{record_id}.json"),
                true,
            )?;
            atomic_text(
                &intent_path,
                &serde_json::to_string(&json!({ "record": record, "content": request.content }))
                    .unwrap(),
                true,
            )?;
            if let Err(failure) = atomic_text(
                &record_path,
                &(serde_json::to_string_pretty(&record).unwrap() + "\n"),
                true,
            ) {
                fs::remove_file(intent_path).map_err(io)?;
                return Err(failure);
            }
            intent = Some(intent_path);
            registered = Some(record_path);
        } else {
            let current = self.read(id, source, false)?;
            if request.expected_version.as_deref() != Some(current.version.as_str()) {
                let mut conflict = error(409, "conflict");
                conflict.payload =
                    json!({ "currentVersion": current.version, "modifiedAt": current.modified_at });
                return Err(conflict);
            }
        }
        let written = (|| {
            contained(&root, source, true)?;
            atomic_text(&target, &request.content, request.create)
        })();
        if let Err(failure) = written {
            if let Some(file) = registered {
                fs::remove_file(file).map_err(io)?;
            }
            if let Some(file) = intent {
                fs::remove_file(file).map_err(io)?;
            }
            return Err(failure);
        }
        if let Some(file) = intent {
            fs::remove_file(file).map_err(io)?;
        }
        self.read(id, source, false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, MobileLibrary, String) {
        let temp = tempfile::tempdir().unwrap();
        let library = MobileLibrary::new(temp.path().join("works")).unwrap();
        let project = library.create("移动端测试").unwrap();
        (temp, library, project["id"].as_str().unwrap().into())
    }
    fn request(path: &str, content: &str, version: Option<String>) -> SaveRequest {
        SaveRequest {
            path: path.into(),
            content: content.into(),
            create: version.is_none(),
            expected_version: version,
            document_type: Some("character".into()),
        }
    }
    #[test]
    fn create_save_reopen_preserves_bytes_and_registered_identity() {
        let (_temp, library, id) = fixture();
        let text = "\u{feff}# 旅人\r\n生命：100\r\n\r\n故事原文。\r\n";
        let first = library
            .save(&id, request("documents/characters/旅人.md", text, None))
            .unwrap();
        assert_eq!(first.content, text);
        let before = library.context(&id).unwrap();
        assert_eq!(before["documents"][0]["documentType"], "character");
        let next = library
            .save(
                &id,
                request(
                    &first.path,
                    &text.replace("100", "175"),
                    Some(first.version),
                ),
            )
            .unwrap();
        assert_eq!(
            library.context(&id).unwrap()["documents"],
            before["documents"]
        );
        let reopened = MobileLibrary::new(library.root.clone()).unwrap();
        assert_eq!(
            reopened.read(&id, &first.path, false).unwrap().content,
            next.content
        );
        assert_eq!(reopened.list().unwrap().as_array().unwrap().len(), 1);
    }
    #[test]
    fn native_revision_check_rejects_stale_or_missing_versions_without_touching_data() {
        let (_temp, library, id) = fixture();
        let first = library
            .save(&id, request("documents/a.md", "first", None))
            .unwrap();
        let second = library
            .save(
                &id,
                request(&first.path, "second", Some(first.version.clone())),
            )
            .unwrap();
        let conflict = library
            .save(&id, request(&first.path, "stale", Some(first.version)))
            .unwrap_err();
        assert_eq!(conflict.status_code, 409);
        assert_eq!(conflict.payload["currentVersion"], second.version);
        let mut missing = request(&first.path, "no version", None);
        missing.create = false;
        assert_eq!(library.save(&id, missing).unwrap_err().status_code, 409);
        assert_eq!(
            library.read(&id, &first.path, false).unwrap().content,
            "second"
        );
    }
    #[test]
    fn paths_and_case_collisions_cannot_escape_or_replace_existing_documents() {
        let (_temp, library, id) = fixture();
        for path in [
            "../secret",
            "/documents/a.md",
            "documents/../x.md",
            "documents\\x.md",
            "metadata/a.json",
            "documents/.hidden/a.md",
            "documents/file.bin",
        ] {
            assert!(
                library.save(&id, request(path, "invalid", None)).is_err(),
                "{path}"
            );
        }
        library
            .save(&id, request("documents/Character/A.md", "original", None))
            .unwrap();
        for path in [
            "documents/Character/A.md",
            "documents/character/B.md",
            "documents/Character/a.MD",
            "documents/Character/A.md/child.md",
        ] {
            assert_eq!(
                library
                    .save(&id, request(path, "replace", None))
                    .unwrap_err()
                    .status_code,
                409,
                "{path}"
            );
        }
        assert_eq!(
            library.context(&id).unwrap()["documents"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }
    #[test]
    fn oversized_or_invalid_utf8_sources_are_not_partially_saved() {
        let (_temp, library, id) = fixture();
        assert_eq!(
            library
                .save(
                    &id,
                    request("documents/a.md", &"x".repeat(MAX_TEXT + 1), None)
                )
                .unwrap_err()
                .status_code,
            413
        );
        assert!(library.context(&id).unwrap()["documents"]
            .as_array()
            .unwrap()
            .is_empty());
        let (root, _) = library.project(&id).unwrap();
        fs::write(root.join("documents/b.md"), [0xff, 0xfe]).unwrap();
        assert!(library.read(&id, "documents/b.md", false).is_err());
        assert_eq!(fs::read(root.join("documents/b.md")).unwrap(), [0xff, 0xfe]);
    }
    #[test]
    fn interrupted_creations_finish_without_losing_source_or_identity() {
        for phase in ["intent", "registry", "published"] {
            let (_temp, library, id) = fixture();
            let (root, _) = library.project(&id).unwrap();
            let document_id = Uuid::new_v4().to_string();
            let source = "documents/recovered.md";
            let content = "\u{feff}# 恢复\r\n生命：100\r\n";
            let record = json!({"format":"viento-document","version":1,"id":document_id,"sourcePath":source,
                "documentType":"character","parserProfile":"structured","relations":[],"assetBindings":[]});
            let intent_path = contained(
                &root,
                &format!(".viento/mobile-create/{document_id}.json"),
                true,
            )
            .unwrap();
            atomic_text(
                &intent_path,
                &json!({"record":record,"content":content}).to_string(),
                true,
            )
            .unwrap();
            if phase != "intent" {
                atomic_text(
                    &root.join(format!("metadata/documents/{document_id}.json")),
                    &record.to_string(),
                    true,
                )
                .unwrap();
            }
            if phase == "published" {
                atomic_text(&root.join(source), content, true).unwrap();
            }
            let reopened = MobileLibrary::new(library.root.clone()).unwrap();
            assert_eq!(reopened.context(&id).unwrap()["documents"][0], record);
            assert_eq!(reopened.read(&id, source, false).unwrap().content, content);
            assert!(!intent_path.exists());
        }
    }
    #[test]
    fn recovery_never_overwrites_a_different_source() {
        let (_temp, library, id) = fixture();
        let (root, _) = library.project(&id).unwrap();
        let document_id = Uuid::new_v4().to_string();
        let record = json!({"format":"viento-document","version":1,"id":document_id,"sourcePath":"documents/existing.md",
            "documentType":"character","parserProfile":"structured","relations":[],"assetBindings":[]});
        let intent_path = contained(
            &root,
            &format!(".viento/mobile-create/{document_id}.json"),
            true,
        )
        .unwrap();
        atomic_text(
            &intent_path,
            &json!({"record":record,"content":"pending"}).to_string(),
            true,
        )
        .unwrap();
        fs::write(root.join("documents/existing.md"), "newer").unwrap();
        assert_eq!(library.context(&id).unwrap_err().status_code, 409);
        assert_eq!(
            fs::read_to_string(root.join("documents/existing.md")).unwrap(),
            "newer"
        );
        assert!(intent_path.exists());
    }
    #[cfg(unix)]
    #[test]
    fn linked_files_and_parents_are_never_followed() {
        let (temp, library, id) = fixture();
        let (root, _) = library.project(&id).unwrap();
        let outside = temp.path().join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("secret.md"), "private").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("documents/link")).unwrap();
        assert_eq!(
            library
                .read(&id, "documents/link/secret.md", false)
                .unwrap_err()
                .status_code,
            403
        );
        assert!(library
            .save(&id, request("documents/link/new.md", "escape", None))
            .is_err());
        assert!(!outside.join("new.md").exists());
        assert_eq!(
            fs::read_to_string(outside.join("secret.md")).unwrap(),
            "private"
        );
    }
}
