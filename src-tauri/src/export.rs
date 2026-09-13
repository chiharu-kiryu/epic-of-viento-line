use crate::workspace::{self, Result};
use std::{
    fs, io,
    path::{Path, PathBuf},
};
use tempfile::NamedTempFile;
use uuid::Uuid;

pub struct PreparedExport {
    root: PathBuf,
    input: fs::File,
    before: fs::Metadata,
}

// Hold the actual file before the picker opens. Expiry may unlink its cache
// pathname while the user chooses a destination; this handle keeps the bytes
// available without making another temporary copy or extending every job's TTL.
pub fn prepare_export(root: &Path, id: &str) -> Result<PreparedExport> {
    if Uuid::parse_str(id)
        .map(|value| value.to_string())
        .as_deref()
        != Ok(id)
    {
        return Err("无效的导出任务".into());
    }
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let mut source = root.clone();
    for component in [".viento", "cache", "exports", id, "payload.zip"] {
        source.push(component);
        if fs::symlink_metadata(&source)
            .map_err(|_| "导出文件已过期，请重新导出")?
            .file_type()
            .is_symlink()
        {
            return Err("导出缓存不能是链接".into());
        }
    }
    if !fs::metadata(&source).map_err(|e| e.to_string())?.is_file() {
        return Err("导出缓存必须是实际文件".into());
    }
    let input = fs::File::open(&source).map_err(|e| e.to_string())?;
    let before = input.metadata().map_err(|e| e.to_string())?;
    if !before.is_file() {
        return Err("导出缓存必须是实际文件".into());
    }
    Ok(PreparedExport {
        root,
        input,
        before,
    })
}

// Destination access is granted by the native save picker. Consume the held
// file exactly once, and publish only after the copy and snapshot checks pass.
pub fn save_prepared_export(prepared: PreparedExport, destination: &Path) -> Result<()> {
    let PreparedExport {
        root,
        mut input,
        before,
    } = prepared;
    let parent = destination
        .parent()
        .ok_or("无效的保存位置")?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let assets = workspace::asset_root(&root)?;
    let asset_root = assets.canonicalize().unwrap_or(assets);
    if parent.starts_with(&root) || parent.starts_with(asset_root) {
        return Err("请选择项目文件夹和素材目录之外的保存位置".into());
    }
    let name = destination.file_name().ok_or("无效的导出文件名")?;
    let target = parent.join(name);
    let mut temporary = NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    let size = io::copy(&mut input, &mut temporary).map_err(|e| e.to_string())?;
    let after = input.metadata().map_err(|e| e.to_string())?;
    if size != before.len()
        || before.len() != after.len()
        || before.modified().ok() != after.modified().ok()
    {
        return Err("导出文件发生变化，请重试".into());
    }
    temporary.as_file().sync_all().map_err(|e| e.to_string())?;
    temporary.persist(target).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn save(root: &Path, id: &str, output: &Path) -> Result<()> {
        save_prepared_export(prepare_export(root, id)?, output)
    }

    #[test]
    fn saves_exact_bytes_atomically_and_rejects_project_destinations() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        let id = Uuid::new_v4().to_string();
        let staged = root.join(format!(".viento/cache/exports/{id}"));
        fs::create_dir_all(&staged).unwrap();
        fs::write(staged.join("payload.zip"), b"zip contents").unwrap();
        let output = temp.path().join("作品.zip");
        fs::write(&output, b"old output").unwrap();
        save(&root, &id, &output).unwrap();
        assert_eq!(fs::read(&output).unwrap(), b"zip contents");
        assert!(save(&root, "../outside", &output).is_err());
        assert!(save(&root, &id, &root.join("workspace.json")).is_err());
        #[cfg(unix)]
        {
            fs::remove_file(staged.join("payload.zip")).unwrap();
            std::os::unix::fs::symlink(&output, staged.join("payload.zip")).unwrap();
            assert!(save(&root, &id, &output).is_err());
        }
        assert_eq!(fs::read(output).unwrap(), b"zip contents");
    }

    #[test]
    fn a_picker_can_outlive_cache_expiry_without_losing_or_reopening_its_export() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        let id = Uuid::new_v4().to_string();
        let staged = root.join(format!(".viento/cache/exports/{id}"));
        fs::create_dir_all(&staged).unwrap();
        fs::write(staged.join("payload.zip"), b"original complete package").unwrap();
        let prepared = prepare_export(&root, &id).unwrap();
        // Same deletion as the Node export service's expiry/release cleanup.
        fs::remove_dir_all(&staged).unwrap();
        fs::create_dir_all(&staged).unwrap();
        fs::write(staged.join("payload.zip"), b"replacement at the old path").unwrap();
        let output = temp.path().join("保存 #100%.zip");
        save_prepared_export(prepared, &output).unwrap();
        assert_eq!(fs::read(output).unwrap(), b"original complete package");
        assert_eq!(
            fs::read(staged.join("payload.zip")).unwrap(),
            b"replacement at the old path"
        );
    }

    #[test]
    fn changed_input_and_failed_publication_keep_the_previous_destination_and_allow_retry() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        let id = Uuid::new_v4().to_string();
        let staged = root.join(format!(".viento/cache/exports/{id}"));
        fs::create_dir_all(&staged).unwrap();
        let source = staged.join("payload.zip");
        fs::write(&source, b"complete package").unwrap();
        let prepared = prepare_export(&root, &id).unwrap();
        let output = temp.path().join("backup.zip");
        fs::write(&output, b"previous backup").unwrap();
        fs::write(&source, b"changed while the picker was open").unwrap();
        assert!(save_prepared_export(prepared, &output).is_err());
        assert_eq!(fs::read(&output).unwrap(), b"previous backup");
        let directory = temp.path().join("occupied.zip");
        fs::create_dir(&directory).unwrap();
        fs::write(directory.join("keep"), b"existing data").unwrap();
        assert!(save(&root, &id, &directory).is_err());
        assert_eq!(fs::read(directory.join("keep")).unwrap(), b"existing data");
        fs::write(&source, b"valid retry").unwrap();
        save(&root, &id, &output).unwrap();
        assert_eq!(fs::read(&output).unwrap(), b"valid retry");
        assert_eq!(
            fs::read_dir(temp.path()).unwrap().count(),
            3,
            "failed copies leave no temporary files"
        );
    }
}
