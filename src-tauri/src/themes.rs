//! Sandboxed Theme Store (`docs/THEME_SPEC.md`).
//!
//! - The registry is fetched **into memory only**; nothing is written until the user installs.
//! - Packages are verified (size + SHA-256), validated entry by entry (whitelist, forbidden
//!   extensions, traversal, size/entry/ratio limits, magic bytes) and extracted into a staging
//!   folder that is renamed atomically into `~/.cobalt/themes/<id>/`.
//! - No code is ever executed from a theme.

use std::io::Read;
use std::path::{Component, Path, PathBuf};

use cobalt_core::enums::{HardwareTier, LayoutType, ThemeCompatibility};
use cobalt_core::error::{CobaltError, Result};
use cobalt_core::ids::now;
use cobalt_core::model::InstalledTheme;
use cobalt_core::theme::*;
use sha2::{Digest, Sha256};

/// Default public registry (static JSON). Override with `COBALT_THEME_REGISTRY`.
pub const DEFAULT_REGISTRY_URL: &str =
    "https://raw.githubusercontent.com/Seveck/cobalt-themes/main/registry.json";
/// Bundled fallback used when the registry is unreachable (development / offline).
const FALLBACK_REGISTRY: &str = include_str!("../themes/registry.fallback.json");
const BUILTIN_MANIFEST: &str = include_str!("../../src/themes/minimal/manifest.json");
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
const MAX_PREVIEW_BYTES: u64 = 1024 * 1024;
const MAX_SHADER_BYTES: u64 = 256 * 1024;

pub fn compatibility(theme: HardwareTier, user: HardwareTier) -> ThemeCompatibility {
    use HardwareTier::*;
    match (theme, user) {
        (Eco, _) | (Balanced, Balanced | Ultra) | (Ultra, Ultra) => ThemeCompatibility::Compatible,
        (Balanced, Eco) | (Ultra, Balanced) => ThemeCompatibility::Degraded,
        (Ultra, Eco) => ThemeCompatibility::Incompatible,
    }
}

pub fn registry_url() -> String {
    std::env::var("COBALT_THEME_REGISTRY").unwrap_or_else(|_| DEFAULT_REGISTRY_URL.into())
}

/// Fetches the registry into memory; falls back to the bundled catalog when offline.
pub async fn fetch_registry(client: &reqwest::Client) -> Result<RegistryIndex> {
    let fetched = async {
        let resp = client.get(registry_url()).send().await.ok()?;
        if !resp.status().is_success() {
            return None;
        }
        resp.json::<RegistryIndex>().await.ok()
    }
    .await;
    match fetched {
        Some(index) => Ok(index),
        None => Ok(serde_json::from_str(FALLBACK_REGISTRY)?),
    }
}

pub fn search(index: &RegistryIndex, query: Option<&str>) -> Vec<RegistryEntry> {
    let q = query.map(str::to_lowercase).unwrap_or_default();
    index
        .themes
        .iter()
        .filter(|t| {
            q.is_empty()
                || t.name.to_lowercase().contains(&q)
                || t.author.to_lowercase().contains(&q)
                || t.description
                    .as_deref()
                    .unwrap_or_default()
                    .to_lowercase()
                    .contains(&q)
        })
        .cloned()
        .collect()
}

/// Downloads a registry package into memory and verifies size + digest.
pub async fn download_package(client: &reqwest::Client, entry: &RegistryEntry) -> Result<Vec<u8>> {
    if !entry.download_url.starts_with("https://") {
        return Err(CobaltError::Sandbox(
            "theme packages must be served over HTTPS".into(),
        ));
    }
    let bytes = client
        .get(&entry.download_url)
        .send()
        .await
        .map_err(|e| CobaltError::Download(e.to_string()))?
        .error_for_status()
        .map_err(|e| CobaltError::Download(e.to_string()))?
        .bytes()
        .await
        .map_err(|e| CobaltError::Download(e.to_string()))?;
    if bytes.len() as u64 != entry.size_bytes {
        return Err(CobaltError::Integrity("theme package size mismatch".into()));
    }
    let digest = hex::encode(Sha256::digest(&bytes));
    if !digest.eq_ignore_ascii_case(&entry.sha256) {
        return Err(CobaltError::Integrity(
            "theme package SHA-256 mismatch".into(),
        ));
    }
    Ok(bytes.to_vec())
}

fn sandbox(msg: impl Into<String>) -> CobaltError {
    CobaltError::Sandbox(msg.into())
}

/// One validated file of a theme package: `(relative path, bytes)`.
pub type ThemeFile = (String, Vec<u8>);

/// Validates one archive path against the whitelist. Returns the normalized relative path.
pub fn validate_entry_path(raw: &str) -> Result<String> {
    if raw.is_empty() || raw.contains('\\') || raw.contains('\0') || raw.contains(':') {
        return Err(sandbox(format!("illegal path '{raw}'")));
    }
    let path = Path::new(raw);
    if path.is_absolute()
        || path
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err(sandbox(format!("path traversal in '{raw}'")));
    }
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if THEME_FORBIDDEN_EXTENSIONS.contains(&ext.as_str()) {
        return Err(sandbox(format!("forbidden file type '{raw}'")));
    }
    let valid_name = |stem: &str| {
        !stem.is_empty()
            && stem.len() <= 64
            && stem.bytes().all(|b| {
                b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-' || b == b'.'
            })
            && stem.as_bytes()[0].is_ascii_alphanumeric()
    };
    let parts: Vec<&str> = raw.split('/').collect();
    let ok = match parts.as_slice() {
        [THEME_MANIFEST_FILE] | [THEME_PREVIEW_FILE] => true,
        [dir, file] if *dir == THEME_SHADERS_DIR => file.ends_with(".glsl") && valid_name(file),
        [dir, file] if *dir == THEME_MESHES_DIR => file.ends_with(".glb") && valid_name(file),
        _ => false,
    };
    if ok {
        Ok(raw.to_owned())
    } else {
        Err(sandbox(format!("'{raw}' is not allowed in a theme")))
    }
}

fn validate_magic(name: &str, data: &[u8]) -> Result<()> {
    if name == THEME_PREVIEW_FILE
        && !(data.len() > 12 && &data[0..4] == b"RIFF" && &data[8..12] == b"WEBP")
    {
        return Err(sandbox("preview.webp is not a WebP image"));
    }
    if name.ends_with(".glb") && !(data.len() > 8 && &data[0..4] == b"glTF" && data[4] == 2) {
        return Err(sandbox(format!("{name} is not binary glTF 2.0")));
    }
    if name.ends_with(".glsl") && std::str::from_utf8(data).is_err() {
        return Err(sandbox(format!("{name} is not UTF-8 text")));
    }
    Ok(())
}

fn per_file_limit(name: &str) -> u64 {
    match name {
        THEME_MANIFEST_FILE => MAX_MANIFEST_BYTES,
        THEME_PREVIEW_FILE => MAX_PREVIEW_BYTES,
        n if n.ends_with(".glsl") => MAX_SHADER_BYTES,
        _ => THEME_MAX_UNPACKED_BYTES,
    }
}

/// Validates the whole package in memory and returns `(manifest, files)`. Sizes are counted
/// while decompressing (headers are never trusted).
pub fn unpack(package: &[u8]) -> Result<(ThemeManifest, Vec<ThemeFile>)> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(package))
        .map_err(|e| sandbox(format!("not a valid .cobalt-theme archive: {e}")))?;
    if archive.len() > THEME_MAX_ENTRIES {
        return Err(sandbox("too many entries"));
    }
    let mut total = 0u64;
    let mut files = Vec::new();
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| sandbox(e.to_string()))?;
        let raw_name = entry
            .name()
            .map_err(|e| sandbox(e.to_string()))?
            .into_owned();
        if entry.is_dir() {
            let dir = raw_name.trim_end_matches('/');
            if dir != THEME_SHADERS_DIR && dir != THEME_MESHES_DIR {
                return Err(sandbox(format!("directory '{dir}' is not allowed")));
            }
            continue;
        }
        if entry.is_symlink() {
            return Err(sandbox("symlinks are not allowed"));
        }
        let name = validate_entry_path(&raw_name)?;
        let limit = per_file_limit(&name).min(THEME_MAX_UNPACKED_BYTES - total);
        let compressed = entry.compressed_size().max(1);
        let mut data = Vec::new();
        let read = (&mut entry).take(limit + 1).read_to_end(&mut data)? as u64;
        if read > limit {
            return Err(sandbox(format!("{name} exceeds its size limit")));
        }
        if read / compressed > THEME_MAX_COMPRESSION_RATIO {
            return Err(sandbox(format!("{name} looks like a zip bomb")));
        }
        total += read;
        validate_magic(&name, &data)?;
        if files.iter().any(|(n, _): &(String, Vec<u8>)| *n == name) {
            return Err(sandbox(format!("duplicate entry {name}")));
        }
        files.push((name, data));
    }
    let manifest_bytes = files
        .iter()
        .find(|(n, _)| n == THEME_MANIFEST_FILE)
        .map(|(_, d)| d.clone())
        .ok_or_else(|| sandbox("manifest.json missing"))?;
    if !files.iter().any(|(n, _)| n == THEME_PREVIEW_FILE) {
        return Err(sandbox("preview.webp missing"));
    }
    let manifest: ThemeManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|e| CobaltError::InvalidInput(format!("invalid manifest.json: {e}")))?;
    validate_manifest(&manifest, &files)?;
    Ok((manifest, files))
}

fn validate_manifest(m: &ThemeManifest, files: &[(String, Vec<u8>)]) -> Result<()> {
    let id_ok = m.id.len() >= 2
        && m.id.len() <= 64
        && m.id.as_bytes()[0].is_ascii_alphanumeric()
        && m.id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    if !id_ok {
        return Err(CobaltError::InvalidInput(format!(
            "invalid theme id '{}'",
            m.id
        )));
    }
    if m.id == cobalt_core::config::BUILTIN_THEME_ID {
        return Err(CobaltError::Conflict(
            "the built-in theme id is reserved".into(),
        ));
    }
    let has = |p: &str| files.iter().any(|(n, _)| n == p);
    let s = &m.shaders;
    for path in [
        &s.node_vertex,
        &s.node_fragment,
        &s.edge_vertex,
        &s.edge_fragment,
        &s.background_fragment,
    ]
    .into_iter()
    .flatten()
    {
        if !path.starts_with("shaders/") || !has(path) {
            return Err(CobaltError::InvalidInput(format!(
                "shader '{path}' missing from package"
            )));
        }
    }
    match (&m.layout_type, &m.mesh_path) {
        (LayoutType::CustomMesh, Some(p)) if p.starts_with("meshes/") && has(p) => Ok(()),
        (LayoutType::CustomMesh, _) => Err(CobaltError::InvalidInput(
            "custom_mesh requires mesh_path".into(),
        )),
        (_, Some(p)) if !has(p) => Err(CobaltError::InvalidInput(format!("mesh '{p}' missing"))),
        _ => Ok(()),
    }
}

/// Extracts a validated package into `themes/<id>/` atomically (staging + rename).
pub fn install_package(themes_dir: &Path, package: &[u8]) -> Result<InstalledTheme> {
    let (manifest, files) = unpack(package)?;
    std::fs::create_dir_all(themes_dir)?;
    let staging = themes_dir.join(format!(".staging-{}", uuid::Uuid::new_v4()));
    let result = (|| -> Result<InstalledTheme> {
        for (name, data) in &files {
            let dest = staging.join(name);
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&dest, data)?;
        }
        let final_dir = themes_dir.join(&manifest.id);
        if final_dir.exists() {
            std::fs::remove_dir_all(&final_dir)?;
        }
        std::fs::rename(&staging, &final_dir)?;
        Ok(InstalledTheme {
            id: manifest.id.clone(),
            name: manifest.name.clone(),
            author: manifest.author.clone(),
            version: manifest.version.clone(),
            size_bytes: files.iter().map(|(_, d)| d.len() as i64).sum(),
            hardware_tier: manifest.hardware_tier,
            local_path: final_dir.to_string_lossy().into_owned(),
            installed_at: now(),
        })
    })();
    if staging.exists() {
        let _ = std::fs::remove_dir_all(&staging);
    }
    result
}

pub fn builtin_manifest() -> Result<ThemeManifest> {
    Ok(serde_json::from_str(BUILTIN_MANIFEST)?)
}

pub fn builtin_installed() -> Result<InstalledTheme> {
    let m = builtin_manifest()?;
    Ok(InstalledTheme {
        id: m.id,
        name: m.name,
        author: m.author,
        version: m.version,
        size_bytes: BUILTIN_MANIFEST.len() as i64,
        hardware_tier: m.hardware_tier,
        local_path: "builtin".into(),
        installed_at: chrono::DateTime::UNIX_EPOCH,
    })
}

/// Reads an installed theme's manifest (never trusting anything outside its folder).
pub fn read_manifest(themes_dir: &Path, id: &str) -> Result<ThemeManifest> {
    if id == cobalt_core::config::BUILTIN_THEME_ID {
        return builtin_manifest();
    }
    validate_entry_path(THEME_MANIFEST_FILE)?;
    if id.contains('/') || id.contains('\\') || id.contains("..") {
        return Err(sandbox("invalid theme id"));
    }
    let raw = std::fs::read(themes_dir.join(id).join(THEME_MANIFEST_FILE))
        .map_err(|_| CobaltError::NotFound(format!("theme {id}")))?;
    Ok(serde_json::from_slice(&raw)?)
}

pub fn uninstall(themes_dir: &Path, id: &str) -> Result<PathBuf> {
    if id == cobalt_core::config::BUILTIN_THEME_ID {
        return Err(CobaltError::Conflict(
            "the built-in theme cannot be uninstalled".into(),
        ));
    }
    if id.contains('/') || id.contains('\\') || id.contains("..") || id.is_empty() {
        return Err(sandbox("invalid theme id"));
    }
    let dir = themes_dir.join(id);
    if dir.exists() {
        std::fs::remove_dir_all(&dir)?;
    }
    Ok(dir)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use std::io::Write;

    fn webp() -> Vec<u8> {
        let mut v = b"RIFF\x10\x00\x00\x00WEBPVP8 ".to_vec();
        v.extend_from_slice(&[0u8; 16]);
        v
    }

    fn manifest(id: &str) -> String {
        format!(
            r#"{{"id":"{id}","name":"Nebula","author":"Ana","version":"1.0.0","hardware_tier":"balanced","layout_type":"galaxy","shaders":{{"node_fragment":"shaders/node.glsl"}}}}"#
        )
    }

    fn package(entries: &[(&str, Vec<u8>)]) -> Vec<u8> {
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut zw = zip::ZipWriter::new(&mut buf);
            for (name, data) in entries {
                zw.start_file(*name, zip::write::SimpleFileOptions::default())
                    .unwrap();
                zw.write_all(data).unwrap();
            }
            zw.finish().unwrap();
        }
        buf.into_inner()
    }

    fn good() -> Vec<(&'static str, Vec<u8>)> {
        vec![
            ("manifest.json", manifest("nebula").into_bytes()),
            ("preview.webp", webp()),
            ("shaders/node.glsl", b"void main(){}".to_vec()),
        ]
    }

    #[test]
    fn installs_valid_theme_atomically_and_uninstalls() {
        let dir = tempfile::tempdir().unwrap();
        let installed = install_package(dir.path(), &package(&good())).unwrap();
        assert_eq!(installed.id, "nebula");
        assert!(dir.path().join("nebula/shaders/node.glsl").is_file());
        assert!(std::fs::read_dir(dir.path()).unwrap().all(|e| {
            !e.unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".staging")
        }));
        assert_eq!(read_manifest(dir.path(), "nebula").unwrap().name, "Nebula");
        uninstall(dir.path(), "nebula").unwrap();
        assert!(!dir.path().join("nebula").exists());
        assert!(uninstall(dir.path(), "cobalt-minimal").is_err());
        assert!(read_manifest(dir.path(), "cobalt-minimal").is_ok());
    }

    #[test]
    fn rejects_code_traversal_and_unknown_files() {
        for bad in [
            "theme.js",
            "shaders/x.js",
            "../evil.glsl",
            "/abs/manifest.json",
            "other/file.glsl",
            "shaders/a.wasm",
            "index.html",
            "C:/x.glsl",
        ] {
            assert!(validate_entry_path(bad).is_err(), "{bad}");
        }
        let mut pkg = good();
        pkg.push(("payload.js", b"alert(1)".to_vec()));
        assert!(matches!(
            unpack(&package(&pkg)),
            Err(CobaltError::Sandbox(_))
        ));
    }

    #[test]
    fn rejects_fake_preview_missing_shader_reserved_id_and_bombs() {
        let mut pkg = good();
        pkg[1].1 = b"<svg onload=alert(1)>".to_vec();
        assert!(unpack(&package(&pkg)).is_err());

        let pkg = vec![
            ("manifest.json", manifest("nebula").into_bytes()),
            ("preview.webp", webp()),
        ];
        assert!(unpack(&package(&pkg)).is_err(), "declared shader missing");

        let mut pkg = good();
        pkg[0].1 = manifest("cobalt-minimal").into_bytes();
        assert!(unpack(&package(&pkg)).is_err());

        let mut pkg = good();
        pkg[2].1 = vec![b' '; 200 * 1024]; // highly compressible, ratio > 100
        assert!(matches!(
            unpack(&package(&pkg)),
            Err(CobaltError::Sandbox(_))
        ));
    }

    #[test]
    fn compatibility_matrix() {
        use HardwareTier::*;
        assert_eq!(compatibility(Eco, Eco), ThemeCompatibility::Compatible);
        assert_eq!(compatibility(Balanced, Eco), ThemeCompatibility::Degraded);
        assert_eq!(compatibility(Ultra, Eco), ThemeCompatibility::Incompatible);
        assert_eq!(compatibility(Ultra, Ultra), ThemeCompatibility::Compatible);
    }

    #[test]
    fn fallback_registry_parses() {
        let idx: RegistryIndex = serde_json::from_str(FALLBACK_REGISTRY).unwrap();
        assert_eq!(idx.schema_version, 1);
    }
}
