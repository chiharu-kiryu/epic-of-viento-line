//! Desktop-compatible archives, validated in isolation before publication.
use super::*;
use std::io::Read;

const MAX_ARCHIVE: u64 = 1024 * 1024 * 1024;
const MAX_EXPANDED: u64 = 4 * MAX_ARCHIVE;
const MAX_ARCHIVE_FILES: usize = 50_000;

impl MobileLibrary {
    pub fn import_archive(&self, archive: &Path) -> Result<Value> {
        let stat = fs::symlink_metadata(archive).map_err(io)?;
        if !stat.is_file() || stat.file_type().is_symlink() {
            return Err(error(400, "bad path"));
        }
        if stat.len() > MAX_ARCHIVE {
            return Err(error(413, "移动端项目包最多 1 GiB，展开后最多 4 GiB"));
        }
        let mut zip = zip::ZipArchive::new(fs::File::open(archive).map_err(io)?)
            .map_err(|_| error(400, "项目包无法读取，请选择完整的 Viento ZIP 项目包"))?;
        if zip.len() > MAX_ARCHIVE_FILES {
            return Err(error(413, "项目包文件过多，请在桌面版中打开"));
        }
        let mut total = 0u64;
        let mut metadata_bytes = 0u64;
        let mut source_bytes = 0u64;
        let mut sources = HashSet::new();
        for index in 0..zip.len() {
            let entry = zip
                .by_index(index)
                .map_err(|_| error(400, "项目包无法读取，请选择完整的 Viento ZIP 项目包"))?;
            total = total
                .checked_add(entry.size())
                .ok_or_else(|| error(413, "移动端项目包最多 1 GiB，展开后最多 4 GiB"))?;
            if total > MAX_EXPANDED || entry.size() > MAX_ARCHIVE {
                return Err(error(413, "移动端项目包最多 1 GiB，展开后最多 4 GiB"));
            }
            // The shared archive verifier reads registries and its manifest as
            // JSON. Bound those allocations before asking it to extract files.
            let limit = if entry.name() == "manifest.json" {
                64 * MAX_TEXT
            } else {
                MAX_TEXT
            };
            if (entry.name() == "manifest.json"
                || entry.name().starts_with("metadata/")
                || entry.name() == "workspace.json"
                || entry.name() == ".viento/workspace.json")
                && entry.size() > limit as u64
            {
                return Err(error(413, "项目元数据过大，请在桌面版中打开"));
            }
            if entry.name().starts_with("metadata/") {
                metadata_bytes = metadata_bytes.saturating_add(entry.size());
                if metadata_bytes > 32 * MAX_TEXT as u64 {
                    return Err(error(413, "项目元数据过大，请在桌面版中打开"));
                }
            }
            let extension = Path::new(entry.name())
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if (entry.name().starts_with("documents/") || entry.name().starts_with("design-data/"))
                && !entry.is_dir()
                && ["", "md", "txt", "json", "yaml", "yml"].contains(&extension.as_str())
            {
                source_bytes = source_bytes.saturating_add(entry.size());
                if source_bytes > 32 * MAX_TEXT as u64 {
                    return Err(error(413, "移动端正文总量最多 32 MiB，请在桌面版中打开"));
                }
                sources.insert(entry.name().to_string());
            }
        }
        let mut manifest = String::new();
        zip.by_name("manifest.json")
            .map_err(|_| error(400, "迁移包缺少 manifest.json"))?
            .take((64 * MAX_TEXT + 1) as u64)
            .read_to_string(&mut manifest)
            .map_err(io)?;
        let manifest: Value = serde_json::from_str(&manifest)
            .map_err(|_| error(400, "项目包无法读取，请选择完整的 Viento ZIP 项目包"))?;
        if ![Some(2), Some(3)].contains(&manifest["workspace"]["version"].as_u64()) {
            return Err(error(400, "请先在桌面版升级此作品，再导出项目包"));
        }
        let id = manifest["workspace"]["id"]
            .as_str()
            .ok_or_else(|| error(400, "invalid document registry"))?;
        if self.projects()?.iter().any(|(_, work)| work.id == id) {
            return Err(error(409, "本机已有此作品，未覆盖已有内容"));
        }
        real_directory(&self.root)?;
        let parent = contained(&self.root, ".mobile-import", false)?;
        fs::create_dir_all(&parent).map_err(io)?;
        real_directory(&parent)?;
        if fs2::available_space(&parent).map_err(io)? < total.saturating_add(32 * 1024 * 1024) {
            return Err(error(507, "磁盘空间不足，无法导入项目包"));
        }
        let stage = tempfile::tempdir_in(&parent).map_err(io)?;
        let root = workspace::import_workspace(archive, stage.path()).map_err(workspace_error)?;
        let work = workspace::ensure_workspace(&root).map_err(workspace_error)?;
        let records = Self::documents(&root, &work)?;
        for record in &records {
            sources.remove(record["sourcePath"].as_str().unwrap());
            read_text(&contained(
                &root,
                record["sourcePath"].as_str().unwrap(),
                false,
            )?)?;
        }
        if !sources.is_empty() {
            return Err(error(
                400,
                "项目包包含未登记的正文，请在桌面版刷新登记后重新导出",
            ));
        }
        // Publish only after all native/mobile validation succeeds. Use a new
        // directory, preserve the project's and documents' original identities.
        let destination = self.root.join(Uuid::new_v4().to_string());
        fs::rename(&root, destination).map_err(io)?;
        Ok(serde_json::to_value(work).unwrap())
    }

    pub fn export_archive(&self, id: &str, destination: &Path) -> Result<Value> {
        let (root, work) = self.project(id)?;
        let files = workspace::export_workspace(&root, destination).map_err(workspace_error)?;
        Ok(json!({"workspace":work,"files":files}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    fn tree(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
        fn walk(root: &Path, dir: &Path, files: &mut BTreeMap<PathBuf, Vec<u8>>) {
            for item in fs::read_dir(dir).unwrap() {
                let path = item.unwrap().path();
                if path.is_dir() {
                    walk(root, &path, files);
                } else {
                    files.insert(
                        path.strip_prefix(root).unwrap().to_owned(),
                        fs::read(path).unwrap(),
                    );
                }
            }
        }
        let mut files = BTreeMap::new();
        walk(root, root, &mut files);
        files
    }
    fn save(library: &MobileLibrary, id: &str, source: &str, content: &str) {
        library
            .save(
                id,
                SaveRequest {
                    path: source.into(),
                    content: content.into(),
                    create: true,
                    expected_version: None,
                    document_type: Some("character".into()),
                },
            )
            .unwrap();
    }
    #[test]
    fn desktop_mobile_roundtrip_preserves_every_file_and_all_media_bindings() {
        let temp = tempfile::tempdir().unwrap();
        let desktop = workspace::create_workspace(temp.path(), "跨设备作品", None, None).unwrap();
        let fixture = MobileLibrary::new(temp.path().join("fixture")).unwrap();
        let work = fixture.create("素材与故事").unwrap();
        let id = work["id"].as_str().unwrap();
        save(
            &fixture,
            id,
            "documents/character.md",
            "\u{feff}# 旅人\r\n生命：100\r\n",
        );
        save(
            &fixture,
            id,
            "documents/story.md",
            "# 故事\n保留英雄背景故事。\n",
        );
        let (root, _) = fixture.project(id).unwrap();
        let mut records = fixture.context(id).unwrap()["documents"]
            .as_array()
            .unwrap()
            .clone();
        let mut bindings = Vec::new();
        for (kind, name, bytes) in [
            ("image", "插图.png", b"\x89PNG\0\r\n".as_slice()),
            ("video", "movie.mp4", b"ftyp\0\x01\xff"),
            ("audio", "voice.ogg", b"OggS\0\x02\xff"),
        ] {
            let asset_id = Uuid::new_v4().to_string();
            fs::write(root.join("assets").join(name), bytes).unwrap();
            workspace::write_json(&root.join(format!("metadata/assets/{asset_id}.json")), &json!({
                "format":"viento-asset","version":1,"id":asset_id,"name":name,"kind":kind,"tags":[],
                "location":{"store":"main","path":name},"content":{"size":bytes.len(),"sha256":format!("{:x}",Sha256::digest(bytes))},"legacyPaths":[]
            })).unwrap();
            bindings.push(json!({"role":kind,"assetId":asset_id}));
        }
        records[0]["assetBindings"] = json!(bindings);
        records[1]["relations"] =
            json!([{"kind":"part-of","targetId":records[0]["id"],"slot":"story"}]);
        for record in records {
            workspace::write_json(
                &root.join(format!(
                    "metadata/documents/{}.json",
                    record["id"].as_str().unwrap()
                )),
                &record,
            )
            .unwrap();
        }
        let original = tree(&root);
        let incoming = temp.path().join("desktop.zip");
        workspace::export_workspace(&root, &incoming).unwrap();
        let mobile = MobileLibrary::new(temp.path().join("mobile")).unwrap();
        assert_eq!(mobile.import_archive(&incoming).unwrap(), work);
        assert_eq!(tree(&mobile.project(id).unwrap().0), original);
        let outgoing = temp.path().join("mobile.zip");
        mobile.export_archive(id, &outgoing).unwrap();
        let restored = workspace::import_workspace(&outgoing, &desktop).unwrap();
        assert_eq!(tree(&restored), original);
        assert_eq!(
            mobile.context(id).unwrap()["documents"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }
    #[test]
    fn duplicate_import_preserves_newer_content_and_identity() {
        let temp = tempfile::tempdir().unwrap();
        let library = MobileLibrary::new(temp.path().join("works")).unwrap();
        let work = library.create("唯一作品").unwrap();
        let id = work["id"].as_str().unwrap();
        save(&library, id, "documents/a.md", "old");
        let archive = temp.path().join("old.zip");
        library.export_archive(id, &archive).unwrap();
        let root = library.project(id).unwrap().0;
        fs::write(root.join("documents/a.md"), "newer saved text").unwrap();
        let before = tree(&root);
        assert_eq!(
            library.import_archive(&archive).unwrap_err().status_code,
            409
        );
        assert_eq!(tree(&root), before);
        assert_eq!(library.list().unwrap().as_array().unwrap().len(), 1);
        assert!(!library.root.join(".mobile-import").exists());
    }
    #[test]
    fn unreadable_sources_rollback_import_and_keep_the_archive() {
        for bytes in [vec![b'a'; MAX_TEXT + 1], vec![0xff, 0xfe]] {
            let temp = tempfile::tempdir().unwrap();
            let source = MobileLibrary::new(temp.path().join("source")).unwrap();
            let work = source.create("正文检查").unwrap();
            let id = work["id"].as_str().unwrap();
            save(&source, id, "documents/a.md", "valid");
            fs::write(source.project(id).unwrap().0.join("documents/a.md"), bytes).unwrap();
            let archive = temp.path().join("input.zip");
            source.export_archive(id, &archive).unwrap();
            let original = fs::read(&archive).unwrap();
            let target = MobileLibrary::new(temp.path().join("target")).unwrap();
            assert!(target.import_archive(&archive).is_err());
            assert!(target.list().unwrap().as_array().unwrap().is_empty());
            assert_eq!(
                fs::read_dir(target.root.join(".mobile-import"))
                    .unwrap()
                    .count(),
                0
            );
            assert_eq!(fs::read(archive).unwrap(), original);
        }
    }
    #[test]
    fn corrupt_and_oversized_packages_do_not_enter_the_library() {
        let temp = tempfile::tempdir().unwrap();
        let library = MobileLibrary::new(temp.path().join("works")).unwrap();
        let archive = temp.path().join("broken.zip");
        fs::write(&archive, b"not a zip").unwrap();
        assert_eq!(
            library.import_archive(&archive).unwrap_err().status_code,
            400
        );
        fs::File::create(&archive)
            .unwrap()
            .set_len(MAX_ARCHIVE + 1)
            .unwrap();
        assert_eq!(
            library.import_archive(&archive).unwrap_err().status_code,
            413
        );
        assert!(library.list().unwrap().as_array().unwrap().is_empty());
    }
    #[test]
    fn zip_json_and_text_budgets_are_checked_before_extraction() {
        use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};
        let temp = tempfile::tempdir().unwrap();
        let library = MobileLibrary::new(temp.path().join("works")).unwrap();
        for (name, size) in [
            ("workspace.json", MAX_TEXT + 1),
            ("metadata/documents/large.json", MAX_TEXT + 1),
            ("documents/large.md", 32 * MAX_TEXT + 1),
        ] {
            let archive = temp.path().join("large.zip");
            let mut zip = ZipWriter::new(fs::File::create(&archive).unwrap());
            zip.start_file(
                name,
                SimpleFileOptions::default().compression_method(CompressionMethod::Deflated),
            )
            .unwrap();
            zip.write_all(&vec![b'a'; size]).unwrap();
            zip.finish().unwrap();
            assert_eq!(
                library.import_archive(&archive).unwrap_err().status_code,
                413
            );
            assert!(!library.root.join(".mobile-import").exists());
        }
    }
    #[test]
    fn cold_start_discards_only_unpublished_imports() {
        let temp = tempfile::tempdir().unwrap();
        let library = MobileLibrary::new(temp.path().join("works")).unwrap();
        let work = library.create("保留已有作品").unwrap();
        let id = work["id"].as_str().unwrap();
        save(&library, id, "documents/a.md", "must survive");
        let before = tree(&library.project(id).unwrap().0);
        let pending = library.root.join(".mobile-import");
        fs::create_dir(&pending).unwrap();
        workspace::create_workspace(&pending, "未完成导入", None, None).unwrap();
        assert_eq!(library.list().unwrap().as_array().unwrap().len(), 1);
        let reopened = MobileLibrary::new(library.root.clone()).unwrap();
        assert!(!pending.exists());
        assert_eq!(tree(&reopened.project(id).unwrap().0), before);
        assert_eq!(reopened.list().unwrap().as_array().unwrap().len(), 1);
    }
    #[test]
    fn unregistered_documents_cannot_be_imported_as_an_empty_work() {
        let temp = tempfile::tempdir().unwrap();
        let root = workspace::create_workspace(temp.path(), "缺少登记", None, None).unwrap();
        fs::write(root.join("documents/story.md"), "must not be hidden").unwrap();
        let archive = temp.path().join("unregistered.zip");
        workspace::export_workspace(&root, &archive).unwrap();
        let library = MobileLibrary::new(temp.path().join("works")).unwrap();
        let failure = library.import_archive(&archive).unwrap_err();
        assert!(failure.message.contains("未登记"));
        assert!(library.list().unwrap().as_array().unwrap().is_empty());
        assert_eq!(
            fs::read_dir(library.root.join(".mobile-import"))
                .unwrap()
                .count(),
            0
        );
        assert_eq!(
            fs::read_to_string(root.join("documents/story.md")).unwrap(),
            "must not be hidden"
        );
    }
}
