use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tempfile::{Builder, NamedTempFile};
use uuid::Uuid;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

pub type Result<T> = std::result::Result<T, String>;
const ROOTS: [&str; 4] = ["design-data", "data-template", "assets", "metadata"];
const GENERIC_ROOTS: [&str; 4] = ["documents", "templates", "assets", "metadata"];
const PROJECT_DEFAULTS: &str = include_str!("../../scripts/lib/project-defaults.json");
fn data_roots(version: u32) -> [&'static str; 4] {
    if version == 3 {
        GENERIC_ROOTS
    } else {
        ROOTS
    }
}
fn layout_version(root: &Path) -> Result<u32> {
    for file in [
        root.join("workspace.json"),
        root.join(".viento/workspace.json"),
    ] {
        if file.exists() {
            if fs::symlink_metadata(&file)
                .map_err(io_error)?
                .file_type()
                .is_symlink()
            {
                return Err("作品清单不能是链接".into());
            }
            let manifest: Workspace =
                serde_json::from_slice(&fs::read(file).map_err(io_error)?).map_err(io_error)?;
            validate_manifest(&manifest)?;
            return Ok(manifest.version);
        }
    }
    match (
        root.join("documents").is_dir(),
        root.join("design-data").is_dir(),
    ) {
        (true, false) => Ok(3),
        (false, true) => Ok(2),
        _ => Err(
            "请选择含有 workspace.json 的作品目录；未登记目录需要包含 documents 或旧版 design-data"
                .into(),
        ),
    }
}
const MAX_FILES: usize = 200_000;
const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 64 * 1024 * 1024 * 1024;

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub format: String,
    pub version: u32,
    pub id: String,
    pub name: String,
    pub created_at: u64,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Recent {
    pub path: String,
    pub name: String,
    pub id: String,
    pub last_opened: u64,
}

#[derive(Default, Serialize, Deserialize)]
pub struct Settings {
    #[serde(default)]
    pub recent: Vec<Recent>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Entry {
    path: String,
    size: u64,
    sha256: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveManifest {
    format: String,
    version: u32,
    exported_at: u64,
    workspace: Workspace,
    files: Vec<Entry>,
}

fn io_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

pub fn write_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let parent = path.parent().ok_or("无效的保存位置")?;
    fs::create_dir_all(parent).map_err(io_error)?;
    let mut temporary = NamedTempFile::new_in(parent).map_err(io_error)?;
    serde_json::to_writer_pretty(&mut temporary, value).map_err(io_error)?;
    temporary.write_all(b"\n").map_err(io_error)?;
    temporary.as_file().sync_all().map_err(io_error)?;
    temporary.persist(path).map_err(io_error)?;
    Ok(())
}

pub fn read_settings(path: &Path) -> Result<Settings> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|e| format!("作品库记录无法读取，原文件已保留：{e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Settings::default()),
        Err(e) => Err(io_error(e)),
    }
}

pub fn portable_component(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.ends_with(['.', ' '])
        && !name
            .chars()
            .any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
        && ![
            "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
            "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
        ]
        .contains(&stem.as_str())
}

fn portable_path(value: &str) -> bool {
    if value == "workspace.json" || value == ".viento/workspace.json" {
        return true;
    }
    let mut parts = value.split('/');
    ({
        let first = parts.next().unwrap_or("");
        ROOTS.contains(&first) || GENERIC_ROOTS.contains(&first)
    }) && value.contains('/')
        && value.split('/').all(portable_component)
}

fn validate_manifest(workspace: &Workspace) -> Result<()> {
    if workspace.extra.get("compatibilityGuard") == Some(&serde_json::json!(true)) {
        return Err("公共作品清单缺失，请恢复 workspace.json".into());
    }
    if workspace.format != "viento-workspace" || ![1, 2, 3].contains(&workspace.version) {
        return Err("作品库格式不受支持，请使用兼容版本打开；现有数据未修改".into());
    }
    if workspace.version >= 2
        && (workspace.extra.get("paths") != Some(&default_layout(workspace.version)["paths"])
            || workspace.extra.get("assetStores")
                != Some(&serde_json::json!({"main":{"path":"assets"}})))
    {
        return Err("不受支持的作品库目录声明".into());
    }
    if Uuid::parse_str(&workspace.id).is_err() || !portable_component(&workspace.name) {
        return Err("作品库名称或标识无效".into());
    }
    if let Some(types) = workspace.extra.get("documentTypes") {
        let types = types
            .as_array()
            .filter(|types| !types.is_empty() && types.len() <= 100)
            .ok_or("项目文档类型需要包含 1 至 100 个类型")?;
        let mut ids = HashSet::new();
        let mut directories = HashSet::new();
        for definition in types {
            let id = definition["id"].as_str().ok_or("文档类型标识无效")?;
            let label = definition["label"].as_str().ok_or("文档类型名称无效")?;
            let directory = definition["directory"].as_str().ok_or("文档类型目录无效")?;
            if id.len() > 64
                || !id.starts_with(|c: char| c.is_ascii_lowercase())
                || !id
                    .bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_' || c == b'-')
                || label.trim().is_empty()
                || label.chars().count() > 120
                || (!directory.is_empty() && !directory.split('/').all(portable_component))
                || ![Some("structured"), Some("prose")]
                    .contains(&definition["parserProfile"].as_str())
                || !ids.insert(id)
                || !directories.insert(directory.to_lowercase())
            {
                return Err("项目文档类型、目录或解析配置无效".into());
            }
            if let Some(template) = definition.get("template") {
                let file = template.as_str().ok_or("文档模板路径无效")?;
                let extension = Path::new(file)
                    .extension()
                    .and_then(|value| value.to_str())
                    .unwrap_or("")
                    .to_ascii_lowercase();
                if !file.split('/').all(portable_component)
                    || !["md", "txt", "json", "yaml", "yml"].contains(&extension.as_str())
                {
                    return Err("文档模板路径无效".into());
                }
            }
        }
    }
    Ok(())
}

fn default_layout(version: u32) -> BTreeMap<String, serde_json::Value> {
    if version == 3 {
        let defaults: serde_json::Value =
            serde_json::from_str(PROJECT_DEFAULTS).expect("valid bundled project defaults");
        return ["paths", "assetStores", "documentTypes"]
            .into_iter()
            .map(|key| (key.into(), defaults[key].clone()))
            .collect();
    }
    BTreeMap::from([
        (
            "paths".into(),
            serde_json::json!({"documents":"design-data","templates":"data-template","metadata":"metadata"}),
        ),
        (
            "assetStores".into(),
            serde_json::json!({"main":{"path":"assets"}}),
        ),
    ])
}

fn v2_guard() -> Workspace {
    Workspace {
        format: "viento-workspace".into(),
        version: 2,
        id: "00000000-0000-0000-0000-000000000000".into(),
        name: "Viento Studio 0.2+ required".into(),
        created_at: 0,
        extra: BTreeMap::from([("compatibilityGuard".into(), serde_json::json!(true))]),
    }
}

fn ensure_v2_guard(root: &Path) -> Result<()> {
    let file = root.join(".viento/workspace.json");
    let expected = format!(
        "{}\n",
        serde_json::to_string_pretty(&v2_guard()).map_err(io_error)?
    );
    if file.exists() {
        let kind = fs::symlink_metadata(&file).map_err(io_error)?;
        if !kind.is_file() || kind.file_type().is_symlink() {
            return Err("兼容标记必须是实际文件".into());
        }
        let old = fs::read(&file).map_err(io_error)?;
        if old == expected.as_bytes() {
            return Ok(());
        }
        let history = root.join(".viento/legacy");
        fs::create_dir_all(&history).map_err(io_error)?;
        require_real_dir(&history)?;
        fs::write(
            history.join(format!("workspace-{}.json", Uuid::new_v4())),
            old,
        )
        .map_err(io_error)?;
    }
    write_json(&file, &v2_guard())
}

fn asset_root(root: &Path) -> Result<PathBuf> {
    let file = root.join(".viento/local.json");
    if !file.exists() {
        return Ok(root.join("assets"));
    }
    let local: serde_json::Value =
        serde_json::from_slice(&fs::read(file).map_err(io_error)?).map_err(io_error)?;
    if local["version"] != 1
        || local.get("assetStores").is_some_and(|s| !s.is_object())
        || local["assetStores"]
            .as_object()
            .is_some_and(|stores| stores.keys().any(|key| key != "main"))
    {
        return Err("无效的本机素材绑定".into());
    }
    match local["assetStores"].get("main") {
        None => Ok(root.join("assets")),
        Some(value) => {
            let directory = PathBuf::from(value.as_str().ok_or("素材目录绑定必须是路径")?);
            if !directory.is_absolute() {
                return Err("素材目录绑定必须是绝对路径".into());
            }
            Ok(directory)
        }
    }
}

fn data_file(root: &Path, relative: &str) -> Result<PathBuf> {
    if let Some(asset) = relative.strip_prefix("assets/") {
        Ok(asset_root(root)?.join(asset))
    } else {
        Ok(root.join(relative))
    }
}

fn require_registered_assets(root: &Path) -> Result<()> {
    let directory = root.join("metadata/assets");
    if !directory.exists() {
        return Ok(());
    }
    require_real_dir(&directory)?;
    let store = asset_root(root)?;
    for entry in fs::read_dir(directory).map_err(io_error)? {
        let entry = entry.map_err(io_error)?;
        if !entry.file_type().map_err(io_error)?.is_file() {
            return Err("素材登记项必须是实际文件".into());
        }
        let record: serde_json::Value =
            serde_json::from_slice(&fs::read(entry.path()).map_err(io_error)?).map_err(io_error)?;
        let relative = record["location"]["path"]
            .as_str()
            .ok_or("素材登记项缺少路径")?;
        if record["location"]["store"] != "main"
            || !portable_path(&format!("assets/{relative}"))
            || !store.join(relative).is_file()
        {
            return Err(format!(
                "素材缺失或登记位置无效，无法生成完整备份：{relative}"
            ));
        }
    }
    Ok(())
}

fn require_real_dir(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path).map_err(io_error)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(format!("请使用实际文件夹，而不是链接：{}", path.display()));
    }
    Ok(())
}

pub fn ensure_workspace(root: &Path) -> Result<Workspace> {
    require_real_dir(root)?;
    let version = layout_version(root)?;
    require_real_dir(&root.join(data_roots(version)[0]))?;
    let private = root.join(".viento");
    if private.exists() {
        require_real_dir(&private)?;
    } else {
        fs::create_dir(&private).map_err(io_error)?;
    }
    let public = root.join("workspace.json");
    let legacy = private.join("workspace.json");
    let metadata = if public.exists() || !legacy.exists() {
        public
    } else {
        legacy
    };
    let workspace = if metadata.exists() {
        if fs::symlink_metadata(&metadata)
            .map_err(io_error)?
            .file_type()
            .is_symlink()
        {
            return Err("作品库描述文件不能是链接".into());
        }
        let value: Workspace =
            serde_json::from_slice(&fs::read(&metadata).map_err(io_error)?).map_err(io_error)?;
        validate_manifest(&value)?;
        value
    } else {
        let name = root
            .file_name()
            .and_then(|s| s.to_str())
            .filter(|s| portable_component(s))
            .unwrap_or("作品库");
        let value = Workspace {
            format: "viento-workspace".into(),
            version,
            id: Uuid::new_v4().to_string(),
            name: name.into(),
            created_at: now(),
            extra: default_layout(version),
        };
        write_json(&metadata, &value)?;
        value
    };
    for name in [
        data_roots(workspace.version)[1],
        "assets",
        "metadata",
        ".viento/cache",
    ] {
        let folder = root.join(name);
        if folder.exists() {
            require_real_dir(&folder)?;
        } else {
            fs::create_dir_all(folder).map_err(io_error)?;
        }
    }
    for name in [
        ".viento/cache/docs-standard",
        ".viento/cache/web",
        ".viento/cache/web/data",
    ] {
        let folder = root.join(name);
        if folder.exists() {
            require_real_dir(&folder)?;
        }
    }
    if workspace.version >= 2 {
        ensure_v2_guard(root)?;
    }
    Ok(workspace)
}

fn list_files(root: &Path) -> Result<Vec<String>> {
    fn visit(root: &Path, dir: &Path, output: &mut Vec<String>, depth: usize) -> Result<()> {
        if depth > 64 {
            return Err("文件夹层级过深".into());
        }
        for item in fs::read_dir(dir).map_err(io_error)? {
            let item = item.map_err(io_error)?;
            let name = item
                .file_name()
                .into_string()
                .map_err(|_| "文件名必须是有效的 Unicode")?;
            if name == ".DS_Store" || name.starts_with("._") || name == "Thumbs.db" {
                continue;
            }
            if !portable_component(&name) {
                return Err(format!("文件名无法跨系统迁移：{name}"));
            }
            let kind = item.file_type().map_err(io_error)?;
            if kind.is_symlink() {
                return Err(format!(
                    "迁移前请将链接转换成实际文件：{}",
                    item.path().display()
                ));
            }
            if kind.is_dir() {
                visit(root, &item.path(), output, depth + 1)?;
            } else if kind.is_file() {
                let relative = item
                    .path()
                    .strip_prefix(root)
                    .map_err(io_error)?
                    .to_string_lossy()
                    .replace('\\', "/");
                output.push(relative);
                if output.len() > MAX_FILES {
                    return Err("文件数量超过迁移包限制".into());
                }
            } else {
                return Err(format!("不支持的文件类型：{}", item.path().display()));
            }
        }
        Ok(())
    }
    let mut files = Vec::new();
    for folder in data_roots(layout_version(root)?) {
        let dir = if folder == "assets" {
            asset_root(root)?
        } else {
            root.join(folder)
        };
        if dir.exists() {
            require_real_dir(&dir)?;
            let mut relative = Vec::new();
            visit(&dir, &dir, &mut relative, 0)?;
            files.extend(relative.into_iter().map(|file| format!("{folder}/{file}")));
        } else if folder == "assets" && dir != root.join("assets") {
            return Err("外置素材目录离线，无法生成完整备份".into());
        }
    }
    let manifest = root.join("workspace.json");
    if manifest.exists() {
        let kind = fs::symlink_metadata(&manifest).map_err(io_error)?;
        if !kind.is_file() || kind.file_type().is_symlink() {
            return Err("作品库清单必须是实际文件".into());
        }
        files.push("workspace.json".into());
        let guard = root.join(".viento/workspace.json");
        if guard.exists() {
            let kind = fs::symlink_metadata(&guard).map_err(io_error)?;
            if !kind.is_file() || kind.file_type().is_symlink() {
                return Err("兼容标记必须是实际文件".into());
            }
            files.push(".viento/workspace.json".into());
        }
    }
    if files.len() > MAX_FILES {
        return Err("文件数量超过迁移包限制".into());
    }
    files.sort();
    let mut unique = HashSet::new();
    for name in &files {
        if !unique.insert(name.to_lowercase()) {
            return Err(format!("文件名大小写冲突，无法安全迁移：{name}"));
        }
    }
    Ok(files)
}

pub fn create_workspace(
    parent: &Path,
    name: &str,
    seed: Option<&Path>,
    templates: Option<&Path>,
) -> Result<PathBuf> {
    let name = name.trim();
    if !portable_component(name) || name.chars().count() > 80 {
        return Err("请填写不含路径符号的作品库名称（最多 80 字）".into());
    }
    let version = seed.map(layout_version).transpose()?.unwrap_or(3);
    let temporary = Builder::new()
        .prefix(&format!("{name}-"))
        .tempdir_in(parent)
        .map_err(io_error)?;
    for folder in data_roots(version) {
        fs::create_dir(temporary.path().join(folder)).map_err(io_error)?;
    }
    let mut extra = default_layout(version);
    if let Some(source) = seed {
        for relative in list_files(source)? {
            let destination = temporary.path().join(&relative);
            fs::create_dir_all(destination.parent().unwrap()).map_err(io_error)?;
            fs::copy(data_file(source, &relative)?, destination).map_err(io_error)?;
        }
        let manifest = source.join("workspace.json");
        if manifest.is_file() {
            extra = serde_json::from_slice::<Workspace>(&fs::read(manifest).map_err(io_error)?)
                .map_err(io_error)?
                .extra;
        }
    } else if let Some(source) = templates.filter(|directory| directory.exists()) {
        let prefix = format!("{}/", data_roots(layout_version(source)?)[1]);
        for relative in list_files(source)? {
            if let Some(file) = relative.strip_prefix(&prefix) {
                let destination = temporary.path().join(data_roots(version)[1]).join(file);
                fs::create_dir_all(destination.parent().unwrap()).map_err(io_error)?;
                fs::copy(source.join(relative), destination).map_err(io_error)?;
            }
        }
    } else {
        let defaults: serde_json::Value =
            serde_json::from_str(PROJECT_DEFAULTS).map_err(io_error)?;
        for (file, content) in defaults["templates"].as_object().ok_or("通用模板无效")? {
            fs::write(
                temporary.path().join("templates").join(file),
                content.as_str().ok_or("通用模板无效")?,
            )
            .map_err(io_error)?;
        }
    }
    let value = Workspace {
        format: "viento-workspace".into(),
        version,
        id: Uuid::new_v4().to_string(),
        name: name.into(),
        created_at: now(),
        extra,
    };
    validate_manifest(&value)?;
    write_json(&temporary.path().join("workspace.json"), &value)?;
    for folder in [
        "metadata/documents",
        "metadata/assets",
        "assets/media/images",
        "assets/media/videos",
        ".viento/cache",
    ] {
        fs::create_dir_all(temporary.path().join(folder)).map_err(io_error)?;
    }
    ensure_v2_guard(temporary.path())?;
    Ok(temporary.keep())
}

fn copy_hashed(
    input: &mut impl Read,
    output: &mut impl Write,
    limit: u64,
) -> Result<(u64, String)> {
    let mut hash = Sha256::new();
    let mut size = 0u64;
    let mut bytes = [0u8; 64 * 1024];
    loop {
        let count = input.read(&mut bytes).map_err(io_error)?;
        if count == 0 {
            break;
        }
        size = size.checked_add(count as u64).ok_or("文件过大")?;
        if size > limit {
            return Err("文件实际大小超过迁移包声明或限制".into());
        }
        hash.update(&bytes[..count]);
        output.write_all(&bytes[..count]).map_err(io_error)?;
    }
    Ok((size, format!("{:x}", hash.finalize())))
}

pub fn export_workspace(root: &Path, destination: &Path) -> Result<usize> {
    let workspace = ensure_workspace(root)?;
    let files = list_files(root)?;
    require_registered_assets(root)?;
    // Do not archive a partially written export inside the workspace itself.
    let parent = destination
        .parent()
        .ok_or("无效的导出位置")?
        .canonicalize()
        .map_err(io_error)?;
    let canonical_root = root.canonicalize().map_err(io_error)?;
    if data_roots(workspace.version)
        .iter()
        .any(|folder| parent.starts_with(canonical_root.join(folder)))
        || parent.starts_with(asset_root(root)?.canonicalize().map_err(io_error)?)
        || parent.starts_with(canonical_root.join(".viento"))
        || parent.join(destination.file_name().ok_or("无效的导出文件名")?)
            == canonical_root.join("workspace.json")
    {
        return Err("请选择正文、模板和素材文件夹之外的导出位置".into());
    }
    let mut temporary = NamedTempFile::new_in(parent).map_err(io_error)?;
    let mut writer = ZipWriter::new(temporary.as_file_mut());
    let mut entries = Vec::new();
    let mut snapshots = Vec::new();
    let mut total = 0u64;
    for relative in &files {
        let absolute = data_file(root, relative)?;
        let mut input = fs::File::open(&absolute).map_err(io_error)?;
        let metadata = input.metadata().map_err(io_error)?;
        if metadata.len() > MAX_FILE_BYTES {
            return Err(format!("文件超过 8 GiB 限制：{relative}"));
        }
        total = total.checked_add(metadata.len()).ok_or("迁移包过大")?;
        if total > MAX_TOTAL_BYTES {
            return Err("迁移包超过 64 GiB 限制".into());
        }
        let extension = absolute
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let method = if ["", "md", "txt", "json", "yaml", "yml"].contains(&extension.as_str()) {
            CompressionMethod::Deflated
        } else {
            CompressionMethod::Stored
        };
        writer
            .start_file(
                relative,
                SimpleFileOptions::default()
                    .compression_method(method)
                    .large_file(metadata.len() > u32::MAX as u64),
            )
            .map_err(io_error)?;
        let (size, sha256) = copy_hashed(&mut input, &mut writer, metadata.len())?;
        if size != metadata.len() {
            return Err(format!("导出时文件发生变化，请重试：{relative}"));
        }
        snapshots.push((
            absolute,
            metadata.len(),
            metadata.modified().map_err(io_error)?,
        ));
        entries.push(Entry {
            path: relative.clone(),
            size,
            sha256,
        });
    }
    if list_files(root)? != files {
        return Err("导出时作品库发生变化，请重试".into());
    }
    for (absolute, size, modified) in snapshots {
        let current = fs::metadata(&absolute).map_err(io_error)?;
        if current.len() != size || current.modified().map_err(io_error)? != modified {
            return Err("导出时作品库发生变化，请保存后重试".into());
        }
    }
    writer
        .start_file(
            "manifest.json",
            SimpleFileOptions::default().compression_method(CompressionMethod::Deflated),
        )
        .map_err(io_error)?;
    serde_json::to_writer(
        &mut writer,
        &ArchiveManifest {
            format: "viento-archive".into(),
            version: if workspace.version == 3 { 3 } else { 2 },
            exported_at: now(),
            workspace,
            files: entries,
        },
    )
    .map_err(io_error)?;
    writer.finish().map_err(io_error)?;
    temporary.as_file().sync_all().map_err(io_error)?;
    temporary.persist(destination).map_err(io_error)?;
    Ok(files.len())
}

pub fn import_workspace(archive_path: &Path, parent: &Path) -> Result<PathBuf> {
    let mut archive =
        ZipArchive::new(fs::File::open(archive_path).map_err(io_error)?).map_err(io_error)?;
    if archive.len() > MAX_FILES + 1 {
        return Err("迁移包文件数量过多".into());
    }
    let mut raw = String::new();
    {
        let mut entry = archive
            .by_name("manifest.json")
            .map_err(|_| "迁移包缺少 manifest.json")?;
        if entry.size() > 64 * 1024 * 1024 {
            return Err("迁移包清单过大".into());
        }
        entry
            .by_ref()
            .take(64 * 1024 * 1024 + 1)
            .read_to_string(&mut raw)
            .map_err(io_error)?;
    }
    let manifest: ArchiveManifest =
        serde_json::from_str(&raw).map_err(|e| format!("迁移包清单无效：{e}"))?;
    if manifest.format != "viento-archive" || ![1, 2, 3].contains(&manifest.version) {
        return Err("迁移包版本不受支持".into());
    }
    validate_manifest(&manifest.workspace)?;
    if (manifest.version == 3) != (manifest.workspace.version == 3) {
        return Err("迁移包版本与作品结构不一致".into());
    }
    if manifest.files.len() > MAX_FILES || archive.len() != manifest.files.len() + 1 {
        return Err("迁移包文件与清单数量不一致".into());
    }
    let mut names = HashSet::new();
    let mut exact_names = HashSet::new();
    let mut total = 0u64;
    for entry in &manifest.files {
        if !portable_path(&entry.path)
            || (entry.path == ".viento/workspace.json" && manifest.workspace.version < 2)
            || (entry.path != "workspace.json"
                && entry.path != ".viento/workspace.json"
                && !data_roots(manifest.workspace.version)
                    .contains(&entry.path.split('/').next().unwrap_or("")))
            || !names.insert(entry.path.to_lowercase())
            || entry.size > MAX_FILE_BYTES
            || entry.sha256.len() != 64
            || !entry.sha256.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err(format!("迁移包包含无效或冲突的文件：{}", entry.path));
        }
        exact_names.insert(entry.path.as_str());
        total = total.checked_add(entry.size).ok_or("迁移包过大")?;
        if total > MAX_TOTAL_BYTES {
            return Err("迁移包展开后超过 64 GiB 限制".into());
        }
    }
    let mut zip_names = HashSet::new();
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(io_error)?;
        if !zip_names.insert(entry.name().to_string())
            || (entry.name() != "manifest.json" && !exact_names.contains(entry.name()))
            || entry.is_dir()
            || entry
                .unix_mode()
                .map(|mode| mode & 0o170000 == 0o120000)
                .unwrap_or(false)
        {
            return Err("迁移包含有未声明文件、重复条目或链接".into());
        }
    }
    let temporary = Builder::new()
        .prefix(&format!("{}-", manifest.workspace.name))
        .tempdir_in(parent)
        .map_err(io_error)?;
    for folder in data_roots(manifest.workspace.version) {
        fs::create_dir(temporary.path().join(folder)).map_err(io_error)?;
    }
    for expected in manifest.files {
        let mut entry = archive.by_name(&expected.path).map_err(io_error)?;
        if entry.size() != expected.size {
            return Err(format!("文件大小校验失败：{}", expected.path));
        }
        let destination = temporary.path().join(&expected.path);
        fs::create_dir_all(destination.parent().unwrap()).map_err(io_error)?;
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(destination)
            .map_err(io_error)?;
        let (size, sha256) = copy_hashed(&mut entry, &mut output, expected.size)?;
        if size != expected.size || !sha256.eq_ignore_ascii_case(&expected.sha256) {
            return Err(format!("文件完整性校验失败：{}", expected.path));
        }
        output.sync_all().map_err(io_error)?;
    }
    let public = temporary.path().join("workspace.json");
    if public.exists() {
        let value: Workspace =
            serde_json::from_slice(&fs::read(&public).map_err(io_error)?).map_err(io_error)?;
        validate_manifest(&value)?;
        if serde_json::to_value(&value).map_err(io_error)?
            != serde_json::to_value(&manifest.workspace).map_err(io_error)?
        {
            return Err("作品库清单与迁移包声明不一致".into());
        }
    } else if manifest.version >= 2 && manifest.workspace.version >= 2 {
        return Err("迁移包缺少公共作品库清单".into());
    } else {
        write_json(
            &temporary.path().join(".viento/workspace.json"),
            &manifest.workspace,
        )?;
    }
    if manifest.workspace.version >= 2 {
        let guard = temporary.path().join(".viento/workspace.json");
        if guard.exists() {
            let actual: Workspace =
                serde_json::from_slice(&fs::read(&guard).map_err(io_error)?).map_err(io_error)?;
            if serde_json::to_value(&actual).map_err(io_error)?
                != serde_json::to_value(v2_guard()).map_err(io_error)?
            {
                return Err("迁移包中的旧版兼容标记无效".into());
            }
        }
        ensure_v2_guard(temporary.path())?;
    }
    require_registered_assets(temporary.path())?;
    Ok(temporary.keep())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn legacy_workspace(parent: &Path, name: &str) -> PathBuf {
        let directory = Builder::new()
            .prefix("v2-test-")
            .tempdir_in(parent)
            .unwrap();
        for folder in ROOTS {
            fs::create_dir(directory.path().join(folder)).unwrap();
        }
        let manifest = Workspace {
            format: "viento-workspace".into(),
            version: 2,
            id: Uuid::new_v4().to_string(),
            name: name.into(),
            created_at: now(),
            extra: default_layout(2),
        };
        write_json(&directory.path().join("workspace.json"), &manifest).unwrap();
        ensure_v2_guard(directory.path()).unwrap();
        directory.keep()
    }

    #[test]
    fn generic_projects_are_empty_and_keep_custom_types_templates_and_media_on_restore() {
        let temp = tempfile::tempdir().unwrap();
        let root = create_workspace(temp.path(), "新的世界", None, None).unwrap();
        let mut manifest = ensure_workspace(&root).unwrap();
        assert_eq!(manifest.version, 3);
        assert!(!root.join("design-data").exists());
        assert!(!root.join("data-template").exists());
        assert_eq!(fs::read_dir(root.join("documents")).unwrap().count(), 0);
        assert_eq!(fs::read_dir(root.join("templates")).unwrap().count(), 6);
        let character = fs::read_to_string(root.join("templates/character.md")).unwrap();
        assert!(character.contains("## 背景与经历"));
        assert!(!character.contains("力量"));
        manifest.extra.get_mut("documentTypes").unwrap().as_array_mut().unwrap().push(serde_json::json!({"id":"species","label":"种族","directory":"species","parserProfile":"structured","template":"species.md"}));
        write_json(&root.join("workspace.json"), &manifest).unwrap();
        fs::write(
            root.join("templates/species.md"),
            "# 新种族\n\n灵魂数量：\n",
        )
        .unwrap();
        let archive = temp.path().join("generic.viento.zip");
        export_workspace(&root, &archive).unwrap();
        let restored = import_workspace(&archive, temp.path()).unwrap();
        assert_eq!(
            fs::read(restored.join("workspace.json")).unwrap(),
            fs::read(root.join("workspace.json")).unwrap()
        );
        assert_eq!(
            fs::read(restored.join("templates/species.md")).unwrap(),
            fs::read(root.join("templates/species.md")).unwrap()
        );
        assert!(!restored.join("design-data").exists());
        assert_eq!(ensure_workspace(&restored).unwrap().id, manifest.id);
        manifest.extra.get_mut("documentTypes").unwrap()[0]["template"] =
            serde_json::json!("../escape.md");
        assert!(validate_manifest(&manifest).is_err());
    }

    #[test]
    fn v2_archive_carries_metadata_and_external_assets_but_not_local_bindings() {
        let temp = tempfile::tempdir().unwrap();
        let root = legacy_workspace(temp.path(), "独立作品");
        let external = temp.path().join("external");
        fs::rename(root.join("assets"), &external).unwrap();
        fs::write(external.join("image.png"), [0, 255, 128]).unwrap();
        fs::write(external.join("unregistered.bin"), [3, 2, 1]).unwrap();
        write_json(
            &root.join(".viento/local.json"),
            &serde_json::json!({"version":1,"assetStores":{"main":external}}),
        )
        .unwrap();
        write_json(
            &root.join("metadata/assets/test.json"),
            &serde_json::json!({"location":{"store":"main","path":"image.png"}}),
        )
        .unwrap();
        fs::write(root.join("metadata/custom.json"), b"{\"userField\":true}").unwrap();
        let manifest_before = fs::read(root.join("workspace.json")).unwrap();
        let target = temp.path().join("v2.zip");
        export_workspace(&root, &target).unwrap();
        let restored = import_workspace(&target, temp.path()).unwrap();
        assert_eq!(
            fs::read(restored.join("workspace.json")).unwrap(),
            manifest_before
        );
        assert_eq!(
            fs::read(restored.join("metadata/custom.json")).unwrap(),
            b"{\"userField\":true}"
        );
        assert_eq!(
            fs::read(restored.join("assets/image.png")).unwrap(),
            [0, 255, 128]
        );
        assert_eq!(
            fs::read(restored.join("assets/unregistered.bin")).unwrap(),
            [3, 2, 1]
        );
        assert!(!restored.join(".viento/local.json").exists());
        fs::remove_file(external.join("image.png")).unwrap();
        let previous_backup = fs::read(&target).unwrap();
        assert!(export_workspace(&root, &target).is_err());
        assert_eq!(fs::read(&target).unwrap(), previous_backup);
        assert!(export_workspace(&restored, &restored.join("workspace.json")).is_err());
        assert_eq!(
            fs::read(restored.join("workspace.json")).unwrap(),
            manifest_before
        );
    }

    #[test]
    fn compatibility_guard_blocks_old_readers_and_never_replaces_a_missing_public_manifest() {
        let temp = tempfile::tempdir().unwrap();
        let root = create_workspace(temp.path(), "新作品", None, None).unwrap();
        let guard: Workspace =
            serde_json::from_slice(&fs::read(root.join(".viento/workspace.json")).unwrap())
                .unwrap();
        assert_ne!(
            guard.version, 1,
            "v1 application must reject this workspace"
        );
        let before = fs::read(root.join(".viento/workspace.json")).unwrap();
        fs::remove_file(root.join("workspace.json")).unwrap();
        assert!(ensure_workspace(&root)
            .unwrap_err()
            .contains("公共作品清单缺失"));
        assert_eq!(
            fs::read(root.join(".viento/workspace.json")).unwrap(),
            before
        );
    }

    #[test]
    fn imports_legacy_v1_archives_without_changing_identity_or_source_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("legacy");
        fs::create_dir(&root).unwrap();
        fs::create_dir(root.join("design-data")).unwrap();
        let workspace = Workspace {
            format: "viento-workspace".into(),
            version: 1,
            id: Uuid::new_v4().to_string(),
            name: "旧作品".into(),
            created_at: 1,
            extra: BTreeMap::new(),
        };
        write_json(&root.join(".viento/workspace.json"), &workspace).unwrap();
        let content = b"\xef\xbb\xbf# Original\r\n";
        fs::write(root.join("design-data/original.md"), content).unwrap();
        let target = temp.path().join("legacy.zip");
        let mut writer = ZipWriter::new(fs::File::create(&target).unwrap());
        writer
            .start_file("design-data/original.md", SimpleFileOptions::default())
            .unwrap();
        writer.write_all(content).unwrap();
        let manifest = ArchiveManifest {
            format: "viento-archive".into(),
            version: 1,
            exported_at: 1,
            workspace: workspace.clone(),
            files: vec![Entry {
                path: "design-data/original.md".into(),
                size: content.len() as u64,
                sha256: format!("{:x}", Sha256::digest(content)),
            }],
        };
        writer
            .start_file("manifest.json", SimpleFileOptions::default())
            .unwrap();
        serde_json::to_writer(&mut writer, &manifest).unwrap();
        writer.finish().unwrap();
        let restored = import_workspace(&target, temp.path()).unwrap();
        assert_eq!(ensure_workspace(&restored).unwrap().id, workspace.id);
        assert_eq!(
            fs::read(restored.join("design-data/original.md")).unwrap(),
            content
        );
        assert!(restored.join(".viento/workspace.json").exists());
    }

    #[test]
    fn new_workspaces_copy_seed_or_templates_without_sharing_or_overwriting_data() {
        let temporary = tempfile::tempdir().unwrap();
        let seed = temporary.path().join("seed");
        for folder in ROOTS {
            fs::create_dir_all(seed.join(folder)).unwrap();
        }
        fs::write(seed.join("design-data/正文.md"), b"\xef\xbb\xbf# Story\r\n").unwrap();
        fs::write(seed.join("data-template/hero.json"), b"{\"version\":1}").unwrap();
        fs::write(seed.join("assets/empty.bin"), b"").unwrap();
        let first =
            create_workspace(temporary.path(), "同名作品", Some(&seed), Some(&seed)).unwrap();
        let blank = create_workspace(temporary.path(), "同名作品", None, Some(&seed)).unwrap();
        assert_ne!(first, blank);
        assert_ne!(
            ensure_workspace(&first).unwrap().id,
            ensure_workspace(&blank).unwrap().id
        );
        assert_eq!(
            fs::read(first.join("design-data/正文.md")).unwrap(),
            b"\xef\xbb\xbf# Story\r\n"
        );
        assert_eq!(
            fs::read(blank.join("templates/hero.json")).unwrap(),
            b"{\"version\":1}"
        );
        assert_eq!(fs::read_dir(blank.join("documents")).unwrap().count(), 0);
        assert!(!blank.join("assets/empty.bin").exists());
        fs::write(first.join("design-data/正文.md"), "自己的修改").unwrap();
        assert_eq!(
            fs::read(seed.join("design-data/正文.md")).unwrap(),
            b"\xef\xbb\xbf# Story\r\n"
        );
        assert!(create_workspace(temporary.path(), "../其他位置", None, Some(&seed)).is_err());
    }

    #[test]
    #[ignore = "full-size source and asset migration; set VIENTO_TEST_SOURCE_ROOT"]
    fn full_project_migration_roundtrip() {
        let source = PathBuf::from(
            std::env::var("VIENTO_TEST_SOURCE_ROOT").expect("VIENTO_TEST_SOURCE_ROOT is required"),
        );
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("migration-source");
        fs::create_dir(&root).unwrap();
        for folder in ROOTS {
            fs::create_dir(root.join(folder)).unwrap();
        }
        let files = list_files(&source).unwrap();
        for relative in &files {
            let destination = root.join(relative);
            fs::create_dir_all(destination.parent().unwrap()).unwrap();
            fs::hard_link(source.join(relative), &destination)
                .or_else(|_| fs::copy(source.join(relative), &destination).map(|_| ()))
                .unwrap();
        }
        let archive_storage = std::env::var("VIENTO_TEST_ARCHIVE_DIR")
            .ok()
            .map(|directory| tempfile::tempdir_in(directory).unwrap());
        let archive = archive_storage
            .as_ref()
            .map(|dir| dir.path())
            .unwrap_or(temporary.path())
            .join("all-data.viento.zip");
        assert_eq!(export_workspace(&root, &archive).unwrap(), files.len());
        let restored = import_workspace(&archive, temporary.path()).unwrap();
        assert_eq!(list_files(&restored).unwrap(), files);
        let mut total = 0u64;
        for relative in &files {
            let before = copy_hashed(
                &mut fs::File::open(source.join(relative)).unwrap(),
                &mut std::io::sink(),
                MAX_FILE_BYTES,
            )
            .unwrap();
            let after = copy_hashed(
                &mut fs::File::open(restored.join(relative)).unwrap(),
                &mut std::io::sink(),
                MAX_FILE_BYTES,
            )
            .unwrap();
            assert_eq!(before, after, "{relative}");
            total += after.0;
        }
        println!(
            "Verified full migration: {} files, {} bytes, archive {} bytes",
            files.len(),
            total,
            fs::metadata(archive).unwrap().len()
        );
    }

    #[test]
    fn archive_roundtrip_preserves_sources_binary_assets_and_excludes_cache() {
        let temp = tempfile::tempdir().unwrap();
        let root = create_workspace(temp.path(), "风之诗", None, None).unwrap();
        fs::write(
            root.join("documents/空：正文.md"),
            b"\xef\xbb\xbf# Title\r\n\r\n",
        )
        .unwrap();
        fs::write(root.join("documents/empty.md"), b"").unwrap();
        fs::write(root.join("assets/portrait.png"), [0, 1, 255, 128]).unwrap();
        fs::create_dir_all(root.join(".viento/cache/docs-standard")).unwrap();
        fs::write(root.join(".viento/cache/docs-standard/stale.json"), b"{}").unwrap();
        let target = temp.path().join("backup.viento.zip");
        assert_eq!(export_workspace(&root, &target).unwrap(), 11);
        let restored = import_workspace(&target, temp.path()).unwrap();
        assert_ne!(restored, root);
        assert_eq!(
            fs::read(restored.join("documents/空：正文.md")).unwrap(),
            fs::read(root.join("documents/空：正文.md")).unwrap()
        );
        assert_eq!(
            fs::read(restored.join("assets/portrait.png")).unwrap(),
            vec![0, 1, 255, 128]
        );
        assert!(restored.join("documents/empty.md").exists());
        assert!(!restored.join(".viento/cache").exists());
        assert_eq!(
            ensure_workspace(&root).unwrap().id,
            ensure_workspace(&restored).unwrap().id
        );
    }

    #[test]
    fn imports_are_validated_before_committing_and_existing_folders_are_preserved() {
        let temp = tempfile::tempdir().unwrap();
        let root = create_workspace(temp.path(), "原作品", None, None).unwrap();
        let workspace = ensure_workspace(&root).unwrap();
        for bad_path in [
            "../escape.txt",
            "assets/../../escape.txt",
            "assets/CON.txt",
            "assets/a\\b",
            "C:/escape",
            "assets/trailing.",
        ] {
            let archive_path = temp.path().join("bad.zip");
            let mut archive = ZipWriter::new(fs::File::create(&archive_path).unwrap());
            let manifest = ArchiveManifest {
                format: "viento-archive".into(),
                version: 3,
                exported_at: now(),
                workspace: workspace.clone(),
                files: vec![Entry {
                    path: bad_path.into(),
                    size: 1,
                    sha256: "0".repeat(64),
                }],
            };
            archive
                .start_file("manifest.json", SimpleFileOptions::default())
                .unwrap();
            serde_json::to_writer(&mut archive, &manifest).unwrap();
            archive
                .start_file(bad_path, SimpleFileOptions::default())
                .unwrap();
            archive.write_all(b"x").unwrap();
            archive.finish().unwrap();
            assert!(
                import_workspace(&archive_path, temp.path()).is_err(),
                "{bad_path}"
            );
        }
        assert!(root.exists());
        assert!(!temp.path().parent().unwrap().join("escape.txt").exists());
    }

    #[test]
    fn wrong_checksum_rolls_back_the_entire_import() {
        let temp = tempfile::tempdir().unwrap();
        let root = create_workspace(temp.path(), "完整性", None, None).unwrap();
        let manifest = ArchiveManifest {
            format: "viento-archive".into(),
            version: 3,
            exported_at: now(),
            workspace: ensure_workspace(&root).unwrap(),
            files: vec![Entry {
                path: "documents/正文.md".into(),
                size: 1,
                sha256: "0".repeat(64),
            }],
        };
        let target = temp.path().join("bad.zip");
        let mut writer = ZipWriter::new(fs::File::create(&target).unwrap());
        writer
            .start_file("manifest.json", SimpleFileOptions::default())
            .unwrap();
        serde_json::to_writer(&mut writer, &manifest).unwrap();
        writer
            .start_file("documents/正文.md", SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"x").unwrap();
        writer.finish().unwrap();
        let before = fs::read_dir(temp.path()).unwrap().count();
        assert!(import_workspace(&target, temp.path())
            .unwrap_err()
            .contains("完整性"));
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), before);
    }
}
