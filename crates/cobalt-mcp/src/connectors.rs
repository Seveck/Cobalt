//! 1-Click connector: detects AI clients on Linux / Windows / macOS and adds or removes the
//! Cobalt MCP entry in their configuration, always writing a timestamped `.bak` first and
//! replacing files atomically. JSON key order and TOML formatting are preserved.

use std::path::{Path, PathBuf};

use cobalt_core::connectors::{ConnectorStatus, ConnectorToggleResult};
use cobalt_core::enums::{AiClient, ConfigFormat};
use cobalt_core::error::{CobaltError, Result};
use cobalt_core::paths::MCP_STDIO_FLAG;
use serde_json::{Map, Value, json};

/// Name of our entry in every client's MCP server table.
pub const SERVER_KEY: &str = "cobalt";

/// Platform directories used to locate client configs (injectable for tests).
#[derive(Debug, Clone)]
pub struct PlatformDirs {
    /// User home (`~`, `%USERPROFILE%`).
    pub home: PathBuf,
    /// Per-user app config dir: `~/.config` (Linux), `~/Library/Application Support` (macOS),
    /// `%APPDATA%` (Windows).
    pub app_config: PathBuf,
}

impl PlatformDirs {
    pub fn detect() -> Result<Self> {
        #[cfg(windows)]
        let home = std::env::var_os("USERPROFILE");
        #[cfg(not(windows))]
        let home = std::env::var_os("HOME");
        let home = home.map(PathBuf::from).ok_or_else(|| {
            CobaltError::Internal("cannot resolve the user home directory".into())
        })?;
        #[cfg(windows)]
        let app_config = std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData").join("Roaming"));
        #[cfg(target_os = "macos")]
        let app_config = home.join("Library").join("Application Support");
        #[cfg(all(not(windows), not(target_os = "macos")))]
        let app_config = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".config"));
        Ok(Self { home, app_config })
    }
}

/// Where a client keeps its MCP servers.
#[derive(Debug, Clone)]
pub struct ClientConfig {
    pub client: AiClient,
    pub path: PathBuf,
    pub format: ConfigFormat,
    /// Directory whose existence means the client is installed / has been run.
    pub detect_dir: PathBuf,
}

pub fn client_config(client: AiClient, dirs: &PlatformDirs) -> ClientConfig {
    let h = &dirs.home;
    let a = &dirs.app_config;
    let (path, format, detect_dir) = match client {
        AiClient::ClaudeDesktop => (
            a.join("Claude").join("claude_desktop_config.json"),
            ConfigFormat::Json,
            a.join("Claude"),
        ),
        AiClient::ClaudeCode => (
            h.join(".claude.json"),
            ConfigFormat::Json,
            h.join(".claude"),
        ),
        AiClient::Cursor => (
            h.join(".cursor").join("mcp.json"),
            ConfigFormat::Json,
            h.join(".cursor"),
        ),
        AiClient::Windsurf => (
            h.join(".codeium").join("windsurf").join("mcp_config.json"),
            ConfigFormat::Json,
            h.join(".codeium").join("windsurf"),
        ),
        AiClient::Cline => {
            let dir = a
                .join("Code")
                .join("User")
                .join("globalStorage")
                .join("saoudrizwan.claude-dev");
            (
                dir.join("settings").join("cline_mcp_settings.json"),
                ConfigFormat::Json,
                dir,
            )
        }
        AiClient::GeminiCli => (
            h.join(".gemini").join("settings.json"),
            ConfigFormat::Json,
            h.join(".gemini"),
        ),
        AiClient::CodexCli => (
            h.join(".codex").join("config.toml"),
            ConfigFormat::Toml,
            h.join(".codex"),
        ),
    };
    ClientConfig {
        client,
        path,
        format,
        detect_dir,
    }
}

/// The JSON entry for a client (Claude Code wants an explicit `type`).
fn json_entry(client: AiClient, exe: &Path) -> Value {
    let mut entry = json!({ "command": exe.to_string_lossy(), "args": [MCP_STDIO_FLAG] });
    if client == AiClient::ClaudeCode {
        entry["type"] = json!("stdio");
    }
    entry
}

/// Snippet shown in "Manual setup": exactly the entry the 1-click toggle would write.
pub fn manual_snippet(client: AiClient, format: ConfigFormat, exe: &Path) -> String {
    match format {
        ConfigFormat::Json => serde_json::to_string_pretty(&json!({
            "mcpServers": { SERVER_KEY: json_entry(client, exe) }
        }))
        .unwrap_or_default(),
        ConfigFormat::Toml => format!(
            "[mcp_servers.{SERVER_KEY}]\ncommand = {:?}\nargs = [\"{MCP_STDIO_FLAG}\"]\n",
            exe.to_string_lossy()
        ),
    }
}

enum Entry {
    Missing,
    Present { command: String },
}

fn read_entry(cfg: &ClientConfig) -> Result<Entry> {
    let raw = match std::fs::read_to_string(&cfg.path) {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Entry::Missing),
        Err(e) => return Err(e.into()),
    };
    if raw.trim().is_empty() {
        return Ok(Entry::Missing);
    }
    match cfg.format {
        ConfigFormat::Json => {
            let doc: Value = serde_json::from_str(&raw).map_err(|e| {
                CobaltError::InvalidInput(format!("{} is not valid JSON: {e}", cfg.path.display()))
            })?;
            Ok(
                match doc
                    .pointer(&format!("/mcpServers/{SERVER_KEY}/command"))
                    .and_then(Value::as_str)
                {
                    Some(cmd) => Entry::Present {
                        command: cmd.to_owned(),
                    },
                    None => Entry::Missing,
                },
            )
        }
        ConfigFormat::Toml => {
            let doc: toml_edit::DocumentMut = raw.parse().map_err(|e| {
                CobaltError::InvalidInput(format!("{} is not valid TOML: {e}", cfg.path.display()))
            })?;
            Ok(
                match doc
                    .get("mcp_servers")
                    .and_then(|t| t.get(SERVER_KEY))
                    .and_then(|s| s.get("command"))
                    .and_then(|c| c.as_str())
                {
                    Some(cmd) => Entry::Present {
                        command: cmd.to_owned(),
                    },
                    None => Entry::Missing,
                },
            )
        }
    }
}

/// Inspects one client.
pub fn status(client: AiClient, dirs: &PlatformDirs, exe: &Path) -> ConnectorStatus {
    let cfg = client_config(client, dirs);
    let detected = cfg.detect_dir.is_dir() || cfg.path.is_file();
    let mut st = ConnectorStatus {
        client,
        detected,
        config_path: Some(cfg.path.to_string_lossy().into_owned()),
        config_format: cfg.format,
        connected: false,
        broken: false,
        last_backup_path: latest_backup(&cfg.path).map(|p| p.to_string_lossy().into_owned()),
        error: None,
        manual_snippet: manual_snippet(client, cfg.format, exe),
    };
    match read_entry(&cfg) {
        Ok(Entry::Present { command }) => {
            let points_here = Path::new(&command) == exe;
            st.connected = points_here;
            st.broken = !points_here || !Path::new(&command).is_file();
        }
        Ok(Entry::Missing) => {}
        Err(e) => st.error = Some(e.to_string()),
    }
    st
}

pub fn status_all(dirs: &PlatformDirs, exe: &Path) -> Vec<ConnectorStatus> {
    AiClient::ALL
        .iter()
        .map(|c| status(*c, dirs, exe))
        .collect()
}

/// Adds (or re-points) / removes the Cobalt entry. Writes `<file>.bak-YYYYmmdd-HHMMSS` first.
pub fn toggle(
    client: AiClient,
    enable: bool,
    dirs: &PlatformDirs,
    exe: &Path,
) -> Result<ConnectorToggleResult> {
    let cfg = client_config(client, dirs);
    let existing = match std::fs::read_to_string(&cfg.path) {
        Ok(r) => Some(r),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.into()),
    };
    if !enable && existing.is_none() {
        return Ok(ConnectorToggleResult {
            status: status(client, dirs, exe),
            backup_path: None,
        });
    }
    let raw = existing.clone().unwrap_or_default();
    let updated = match cfg.format {
        ConfigFormat::Json => edit_json(&raw, client, enable, exe, &cfg.path)?,
        ConfigFormat::Toml => edit_toml(&raw, enable, exe, &cfg.path)?,
    };
    let backup_path = match existing {
        Some(original) => Some(write_backup(&cfg.path, &original)?),
        None => None,
    };
    write_atomic(&cfg.path, &updated)?;
    Ok(ConnectorToggleResult {
        status: status(client, dirs, exe),
        backup_path: backup_path.map(|p| p.to_string_lossy().into_owned()),
    })
}

fn edit_json(raw: &str, client: AiClient, enable: bool, exe: &Path, path: &Path) -> Result<String> {
    let mut doc: Value = if raw.trim().is_empty() {
        Value::Object(Map::new())
    } else {
        serde_json::from_str(raw).map_err(|e| {
            CobaltError::InvalidInput(format!(
                "{} is not valid JSON ({e}); fix it or use Manual setup",
                path.display()
            ))
        })?
    };
    let root = doc.as_object_mut().ok_or_else(|| {
        CobaltError::InvalidInput(format!("{} must contain a JSON object", path.display()))
    })?;
    let servers = root
        .entry("mcpServers")
        .or_insert_with(|| Value::Object(Map::new()));
    let servers = servers
        .as_object_mut()
        .ok_or_else(|| CobaltError::InvalidInput("\"mcpServers\" is not an object".into()))?;
    if enable {
        servers.insert(SERVER_KEY.into(), json_entry(client, exe));
    } else {
        servers.remove(SERVER_KEY);
    }
    let mut out = serde_json::to_string_pretty(&doc)?;
    out.push('\n');
    Ok(out)
}

fn edit_toml(raw: &str, enable: bool, exe: &Path, path: &Path) -> Result<String> {
    let mut doc: toml_edit::DocumentMut = raw.parse().map_err(|e| {
        CobaltError::InvalidInput(format!(
            "{} is not valid TOML ({e}); fix it or use Manual setup",
            path.display()
        ))
    })?;
    if enable {
        if doc.get("mcp_servers").is_none() {
            let mut t = toml_edit::Table::new();
            t.set_implicit(true);
            doc["mcp_servers"] = toml_edit::Item::Table(t);
        }
        let mut entry = toml_edit::Table::new();
        entry["command"] = toml_edit::value(exe.to_string_lossy().as_ref());
        let mut args = toml_edit::Array::new();
        args.push(MCP_STDIO_FLAG);
        entry["args"] = toml_edit::value(args);
        doc["mcp_servers"][SERVER_KEY] = toml_edit::Item::Table(entry);
    } else if let Some(servers) = doc
        .get_mut("mcp_servers")
        .and_then(|t| t.as_table_like_mut())
    {
        servers.remove(SERVER_KEY);
    }
    Ok(doc.to_string())
}

fn write_backup(path: &Path, original: &str) -> Result<PathBuf> {
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let mut name = path.as_os_str().to_owned();
    name.push(format!(".bak-{stamp}"));
    let backup = PathBuf::from(name);
    std::fs::write(&backup, original)?;
    Ok(backup)
}

fn latest_backup(path: &Path) -> Option<PathBuf> {
    let dir = path.parent()?;
    let prefix = format!("{}.bak-", path.file_name()?.to_string_lossy());
    let mut backups: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .is_some_and(|n| n.to_string_lossy().starts_with(&prefix))
        })
        .collect();
    backups.sort();
    backups.pop()
}

fn write_atomic(path: &Path, contents: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".cobalt-tmp");
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, contents)?;
    #[cfg(unix)]
    if let Ok(meta) = std::fs::metadata(path) {
        let _ = std::fs::set_permissions(&tmp, meta.permissions());
    }
    std::fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn dirs(root: &Path) -> PlatformDirs {
        PlatformDirs {
            home: root.join("home"),
            app_config: root.join("appcfg"),
        }
    }

    #[test]
    fn json_clients_keep_other_servers_and_write_backups() {
        let root = tempfile::tempdir().unwrap();
        let d = dirs(root.path());
        let exe = root.path().join("cobalt");
        std::fs::write(&exe, b"bin").unwrap();
        let cfg = client_config(AiClient::Cursor, &d);
        std::fs::create_dir_all(cfg.path.parent().unwrap()).unwrap();
        std::fs::write(
            &cfg.path,
            r#"{"theme":"dark","mcpServers":{"other":{"command":"x"}}}"#,
        )
        .unwrap();

        let st = status(AiClient::Cursor, &d, &exe);
        assert!(st.detected && !st.connected);
        let res = toggle(AiClient::Cursor, true, &d, &exe).unwrap();
        assert!(res.status.connected && !res.status.broken);
        assert!(Path::new(res.backup_path.as_ref().unwrap()).is_file());
        let doc: Value =
            serde_json::from_str(&std::fs::read_to_string(&cfg.path).unwrap()).unwrap();
        assert_eq!(doc["theme"], "dark");
        assert_eq!(doc["mcpServers"]["other"]["command"], "x");
        assert_eq!(doc["mcpServers"]["cobalt"]["args"][0], "--mcp-stdio");
        // Key order preserved.
        assert!(
            std::fs::read_to_string(&cfg.path).unwrap().find("theme")
                < std::fs::read_to_string(&cfg.path)
                    .unwrap()
                    .find("mcpServers")
        );

        let off = toggle(AiClient::Cursor, false, &d, &exe).unwrap();
        assert!(!off.status.connected);
        let doc: Value =
            serde_json::from_str(&std::fs::read_to_string(&cfg.path).unwrap()).unwrap();
        assert!(doc["mcpServers"].get("cobalt").is_none());
        assert!(doc["mcpServers"].get("other").is_some());
    }

    #[test]
    fn claude_code_entry_has_type_and_missing_file_is_created() {
        let root = tempfile::tempdir().unwrap();
        let d = dirs(root.path());
        let exe = root.path().join("cobalt");
        std::fs::write(&exe, b"bin").unwrap();
        let res = toggle(AiClient::ClaudeCode, true, &d, &exe).unwrap();
        assert!(res.backup_path.is_none());
        let cfg = client_config(AiClient::ClaudeCode, &d);
        let doc: Value = serde_json::from_str(&std::fs::read_to_string(cfg.path).unwrap()).unwrap();
        assert_eq!(doc["mcpServers"]["cobalt"]["type"], "stdio");
    }

    #[test]
    fn codex_toml_preserves_formatting_and_comments() {
        let root = tempfile::tempdir().unwrap();
        let d = dirs(root.path());
        let exe = root.path().join("cobalt");
        std::fs::write(&exe, b"bin").unwrap();
        let cfg = client_config(AiClient::CodexCli, &d);
        std::fs::create_dir_all(cfg.path.parent().unwrap()).unwrap();
        std::fs::write(
            &cfg.path,
            "# my settings\nmodel = \"gpt\"\n\n[mcp_servers.other]\ncommand = \"x\"\n",
        )
        .unwrap();
        toggle(AiClient::CodexCli, true, &d, &exe).unwrap();
        let text = std::fs::read_to_string(&cfg.path).unwrap();
        assert!(text.starts_with("# my settings\nmodel = \"gpt\""));
        assert!(text.contains("[mcp_servers.cobalt]") && text.contains("--mcp-stdio"));
        assert!(status(AiClient::CodexCli, &d, &exe).connected);
        toggle(AiClient::CodexCli, false, &d, &exe).unwrap();
        let text = std::fs::read_to_string(&cfg.path).unwrap();
        assert!(!text.contains("mcp_servers.cobalt") && text.contains("[mcp_servers.other]"));
    }

    #[test]
    fn invalid_config_is_never_overwritten_and_stale_entries_are_broken() {
        let root = tempfile::tempdir().unwrap();
        let d = dirs(root.path());
        let exe = root.path().join("cobalt");
        std::fs::write(&exe, b"bin").unwrap();
        let cfg = client_config(AiClient::GeminiCli, &d);
        std::fs::create_dir_all(cfg.path.parent().unwrap()).unwrap();
        std::fs::write(&cfg.path, "{ not json").unwrap();
        assert!(toggle(AiClient::GeminiCli, true, &d, &exe).is_err());
        assert_eq!(std::fs::read_to_string(&cfg.path).unwrap(), "{ not json");
        assert!(status(AiClient::GeminiCli, &d, &exe).error.is_some());

        std::fs::write(
            &cfg.path,
            r#"{"mcpServers":{"cobalt":{"command":"/old/path/cobalt"}}}"#,
        )
        .unwrap();
        let st = status(AiClient::GeminiCli, &d, &exe);
        assert!(st.broken && !st.connected);
        assert!(
            toggle(AiClient::GeminiCli, true, &d, &exe)
                .unwrap()
                .status
                .connected
        );
    }

    #[test]
    fn manual_snippets() {
        let exe = Path::new("/opt/cobalt/cobalt");
        assert!(
            manual_snippet(AiClient::Cursor, ConfigFormat::Json, exe).contains("\"mcpServers\"")
        );
        assert!(
            manual_snippet(AiClient::CodexCli, ConfigFormat::Toml, exe)
                .contains("[mcp_servers.cobalt]")
        );
        let claude = manual_snippet(AiClient::ClaudeCode, ConfigFormat::Json, exe);
        assert!(claude.contains("\"type\": \"stdio\"") && claude.contains("--mcp-stdio"));
        assert!(
            claude.contains(&*exe.to_string_lossy()),
            "real executable path, not 'cobalt'"
        );
    }
}
