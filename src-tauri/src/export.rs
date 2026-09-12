use crate::workspace::{self, Result};
use std::{fs, io, path::Path};
use tempfile::NamedTempFile;
use uuid::Uuid;

// The editor supplies a random job ID, never an arbitrary input/output path.
// Destination access is granted by the native save picker.
pub fn save_prepared_export(root: &Path, id: &str, destination: &Path) -> Result<()> {
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
    let mut input = fs::File::open(&source).map_err(|e| e.to_string())?;
    let before = input.metadata().map_err(|e| e.to_string())?;
    if !before.is_file() {
        return Err("导出缓存必须是实际文件".into());
    }
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
        save_prepared_export(&root, &id, &output).unwrap();
        assert_eq!(fs::read(&output).unwrap(), b"zip contents");
        assert!(save_prepared_export(&root, "../outside", &output).is_err());
        assert!(save_prepared_export(&root, &id, &root.join("workspace.json")).is_err());
        #[cfg(unix)]
        {
            fs::remove_file(staged.join("payload.zip")).unwrap();
            std::os::unix::fs::symlink(&output, staged.join("payload.zip")).unwrap();
            assert!(save_prepared_export(&root, &id, &output).is_err());
        }
        assert_eq!(fs::read(output).unwrap(), b"zip contents");
    }
}
