//! Installers for automatic capture (`docs/CLI_CAPTURE.md` §2–4). Every change is reversible,
//! writes a timestamped `.bak` first and never touches content outside Cobalt's own markers.

use std::path::{Path, PathBuf};

use cobalt_core::enums::{AiClient, CaptureIntegration};
use cobalt_core::error::{CobaltError, Result};
use cobalt_core::events::CaptureStatus;
use cobalt_core::paths::HOOK_FLAG;
use serde_json::{Value, json};

use crate::connectors::PlatformDirs;

const BEGIN: &str = "<!-- cobalt:begin -->";
const END: &str = "<!-- cobalt:end -->";
const SH_BEGIN: &str = "# cobalt:begin";
const SH_END: &str = "# cobalt:end";

/// Rules every AI receives in its global instructions.
pub const GLOBAL_RULES: &str = "## Cobalt (shared memory of all my AI tools)
- At the start of every session call the Cobalt MCP tool `list_project_rules` and follow the rules.
- Call `search_memory` before reading large files or asking me for context again; trust results
  marked as current, re-check those flagged \"file changed since saved\".
- Call `search_reusable_assets` before writing boilerplate or utilities from scratch.
- Save decisions, fixed bugs (root cause + fix) and my preferences with `save_memory`
  (1-4 lines: Context -> Decision -> Reason); use `update_memory` when something changed.
- Use `create_handoff` when you stop mid-task; `resume_handoff` when I ask to continue.";

fn global_file(client: AiClient, dirs: &PlatformDirs) -> Option<PathBuf> {
    let h = &dirs.home;
    match client {
        AiClient::ClaudeCode => Some(h.join(".claude").join("CLAUDE.md")),
        AiClient::CodexCli => Some(h.join(".codex").join("AGENTS.md")),
        AiClient::GeminiCli => Some(h.join(".gemini").join("GEMINI.md")),
        _ => None,
    }
}

fn hooks_file(client: AiClient, dirs: &PlatformDirs) -> Option<PathBuf> {
    match client {
        AiClient::ClaudeCode => Some(dirs.home.join(".claude").join("settings.json")),
        AiClient::CodexCli => Some(dirs.home.join(".codex").join("config.toml")),
        AiClient::GeminiCli => Some(dirs.home.join(".gemini").join("settings.json")),
        _ => None,
    }
}

fn backup(path: &Path) -> Result<()> {
    if path.is_file() {
        let mut name = path.as_os_str().to_owned();
        name.push(format!(
            ".bak-{}",
            chrono::Local::now().format("%Y%m%d-%H%M%S")
        ));
        std::fs::copy(path, PathBuf::from(name))?;
    }
    Ok(())
}

fn write(path: &Path, text: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".cobalt-tmp");
    std::fs::write(PathBuf::from(&tmp), text)?;
    std::fs::rename(PathBuf::from(tmp), path)?;
    Ok(())
}

/// Removes the region between markers (inclusive), returning the text and whether it existed.
fn strip_block(text: &str, begin: &str, end: &str) -> (String, bool) {
    let (Some(b), Some(e)) = (text.find(begin), text.find(end)) else {
        return (text.to_owned(), false);
    };
    if e < b {
        return (text.to_owned(), false);
    }
    let mut out = String::new();
    out.push_str(text[..b].trim_end_matches('\n'));
    let rest = &text[e + end.len()..];
    let rest = rest.trim_start_matches('\n');
    if !out.is_empty() && !rest.is_empty() {
        out.push_str("\n\n");
    }
    out.push_str(rest);
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    (out, true)
}

fn hook_command(exe: &Path, source: &str) -> String {
    format!("\"{}\" {HOOK_FLAG} {source}", exe.to_string_lossy())
}

// ---------------------------------------------------------------- global instructions

fn global_status(client: AiClient, dirs: &PlatformDirs) -> CaptureStatus {
    let path = global_file(client, dirs);
    let enabled = path
        .as_ref()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .is_some_and(|t| t.contains(BEGIN));
    CaptureStatus {
        integration: CaptureIntegration::GlobalInstructions,
        client: Some(client),
        project_id: None,
        supported: path.is_some(),
        enabled,
        path: path.map(|p| p.to_string_lossy().into_owned()),
        detail: None,
    }
}

fn toggle_global(client: AiClient, enable: bool, dirs: &PlatformDirs) -> Result<CaptureStatus> {
    let path = global_file(client, dirs).ok_or_else(|| {
        CobaltError::Unsupported(format!("{client} has no global instructions file"))
    })?;
    let current = std::fs::read_to_string(&path).unwrap_or_default();
    let (mut text, existed) = strip_block(&current, BEGIN, END);
    if enable {
        if !text.is_empty() && !text.ends_with("\n\n") {
            text.push('\n');
        }
        text.push_str(&format!("{BEGIN}\n{GLOBAL_RULES}\n{END}\n"));
    }
    if enable || existed {
        backup(&path)?;
        write(&path, &text)?;
    }
    Ok(global_status(client, dirs))
}

// ---------------------------------------------------------------- session hooks

const CLAUDE_EVENTS: [(&str, Option<&str>); 4] = [
    ("SessionStart", None),
    (
        "PostToolUse",
        Some("Edit|Write|MultiEdit|NotebookEdit|Bash"),
    ),
    ("Stop", None),
    ("SessionEnd", None),
];

/// Gemini CLI events (timeouts in milliseconds there, seconds in Claude Code).
const GEMINI_EVENTS: [(&str, Option<&str>); 4] = [
    ("SessionStart", None),
    ("AfterTool", Some("write_file|replace|run_shell_command")),
    ("AfterAgent", None),
    ("SessionEnd", None),
];

fn is_ours_for(entry: &Value, source: &str) -> bool {
    entry
        .get("hooks")
        .and_then(Value::as_array)
        .is_some_and(|hs| {
            hs.iter().any(|h| {
                h.get("command")
                    .and_then(Value::as_str)
                    .is_some_and(|c| c.contains(HOOK_FLAG) && c.ends_with(source))
            })
        })
}

fn json_hooks_enabled(doc: &Value, events: &[(&str, Option<&str>)], source: &str) -> bool {
    events.iter().all(|(ev, _)| {
        doc.pointer(&format!("/hooks/{ev}"))
            .and_then(Value::as_array)
            .is_some_and(|a| a.iter().any(|e| is_ours_for(e, source)))
    })
}

/// Adds or removes Cobalt's entries in a `{"hooks": {Event: [...]}}` JSON settings file,
/// leaving every other hook and setting untouched.
fn edit_json_hooks(
    raw: &str,
    path: &Path,
    events: &[(&str, Option<&str>)],
    source: &str,
    timeout: u64,
    exe: &Path,
    enable: bool,
) -> Result<String> {
    let mut doc: Value = if raw.trim().is_empty() {
        json!({})
    } else {
        serde_json::from_str(raw).map_err(|e| {
            CobaltError::InvalidInput(format!("{} is not valid JSON: {e}", path.display()))
        })?
    };
    let root = doc
        .as_object_mut()
        .ok_or_else(|| CobaltError::InvalidInput("settings must be a JSON object".into()))?;
    let hooks = root.entry("hooks").or_insert_with(|| json!({}));
    let hooks = hooks
        .as_object_mut()
        .ok_or_else(|| CobaltError::InvalidInput("\"hooks\" must be an object".into()))?;
    for (event, matcher) in events {
        let list = hooks.entry(*event).or_insert_with(|| json!([]));
        let list = list
            .as_array_mut()
            .ok_or_else(|| CobaltError::InvalidInput(format!("hooks.{event} must be an array")))?;
        list.retain(|e| !is_ours_for(e, source));
        if enable {
            let mut entry = json!({ "hooks": [{ "type": "command", "command": hook_command(exe, source), "timeout": timeout }] });
            if let Some(m) = matcher {
                entry["matcher"] = json!(m);
            }
            list.push(entry);
        }
    }
    hooks.retain(|_, v| !v.as_array().is_some_and(Vec::is_empty));
    if hooks.is_empty() {
        root.remove("hooks");
    }
    let mut out = serde_json::to_string_pretty(&doc)?;
    out.push('\n');
    Ok(out)
}

fn codex_notify_state(raw: &str, exe: &Path) -> (bool, bool) {
    // (ours, someone else's notify present)
    let Ok(doc) = raw.parse::<toml_edit::DocumentMut>() else {
        return (false, false);
    };
    match doc.get("notify").and_then(|n| n.as_array()) {
        Some(arr) => {
            let first = arr.get(0).and_then(|v| v.as_str()).unwrap_or_default();
            let ours = Path::new(first) == exe && arr.iter().any(|v| v.as_str() == Some(HOOK_FLAG));
            (ours, !ours)
        }
        None => (false, false),
    }
}

fn hooks_status(client: AiClient, dirs: &PlatformDirs, exe: &Path) -> CaptureStatus {
    let path = hooks_file(client, dirs);
    let raw = path
        .as_ref()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .unwrap_or_default();
    let (enabled, detail) = match client {
        AiClient::ClaudeCode => (
            serde_json::from_str::<Value>(&raw)
                .map(|d| json_hooks_enabled(&d, &CLAUDE_EVENTS, "claude"))
                .unwrap_or(false),
            None,
        ),
        AiClient::GeminiCli => (
            serde_json::from_str::<Value>(&raw)
                .map(|d| json_hooks_enabled(&d, &GEMINI_EVENTS, "gemini"))
                .unwrap_or(false),
            None,
        ),
        AiClient::CodexCli => {
            let (ours, foreign) = codex_notify_state(&raw, exe);
            (
                ours,
                foreign.then(|| {
                    "another `notify` program is configured; Cobalt will not replace it".to_owned()
                }),
            )
        }
        _ => (
            false,
            Some("this client has no hook system yet; global instructions still apply".into()),
        ),
    };
    CaptureStatus {
        integration: CaptureIntegration::SessionHooks,
        client: Some(client),
        project_id: None,
        supported: path.is_some(),
        enabled,
        path: path.map(|p| p.to_string_lossy().into_owned()),
        detail,
    }
}

fn toggle_hooks(
    client: AiClient,
    enable: bool,
    dirs: &PlatformDirs,
    exe: &Path,
) -> Result<CaptureStatus> {
    let path = hooks_file(client, dirs)
        .ok_or_else(|| CobaltError::Unsupported(format!("{client} has no hook system yet")))?;
    let raw = std::fs::read_to_string(&path).unwrap_or_default();
    match client {
        AiClient::ClaudeCode => {
            let out = edit_json_hooks(&raw, &path, &CLAUDE_EVENTS, "claude", 5, exe, enable)?;
            backup(&path)?;
            write(&path, &out)?;
        }
        AiClient::GeminiCli => {
            let out = edit_json_hooks(&raw, &path, &GEMINI_EVENTS, "gemini", 5000, exe, enable)?;
            backup(&path)?;
            write(&path, &out)?;
        }
        AiClient::CodexCli => {
            let mut doc: toml_edit::DocumentMut = raw.parse().map_err(|e| {
                CobaltError::InvalidInput(format!("{} is not valid TOML: {e}", path.display()))
            })?;
            let (ours, foreign) = codex_notify_state(&raw, exe);
            if enable {
                if foreign {
                    return Err(CobaltError::Conflict("another `notify` program is configured in Codex; remove it first or keep it".into()));
                }
                let mut arr = toml_edit::Array::new();
                arr.push(exe.to_string_lossy().as_ref());
                arr.push(HOOK_FLAG);
                arr.push("codex");
                // `notify` must be a top-level key: insert it before the first table.
                doc.insert("notify", toml_edit::value(arr));
            } else if ours {
                doc.remove("notify");
            }
            backup(&path)?;
            write(&path, &doc.to_string())?;
        }
        _ => {
            return Err(CobaltError::Unsupported(format!(
                "{client} has no hook system yet"
            )));
        }
    }
    Ok(hooks_status(client, dirs, exe))
}

// ---------------------------------------------------------------- git hooks

fn git_hook_path(repo_root: &Path) -> Option<PathBuf> {
    let git = repo_root.join(".git");
    git.is_dir().then(|| git.join("hooks").join("post-commit"))
}

pub fn git_status(project_id: cobalt_core::Id, repo_root: Option<&Path>) -> CaptureStatus {
    let path = repo_root.and_then(git_hook_path);
    let enabled = path
        .as_ref()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .is_some_and(|t| t.contains(SH_BEGIN));
    CaptureStatus {
        integration: CaptureIntegration::GitHooks,
        client: None,
        project_id: Some(project_id),
        supported: path.is_some(),
        enabled,
        path: path.map(|p| p.to_string_lossy().into_owned()),
        detail: if repo_root.is_some() && !enabled && repo_root.and_then(git_hook_path).is_none() {
            Some("not a git repository".into())
        } else {
            None
        },
    }
}

pub fn toggle_git(
    project_id: cobalt_core::Id,
    repo_root: &Path,
    enable: bool,
    exe: &Path,
) -> Result<CaptureStatus> {
    let path = git_hook_path(repo_root).ok_or_else(|| {
        CobaltError::InvalidInput("the project root is not a git repository".into())
    })?;
    let current = std::fs::read_to_string(&path).unwrap_or_default();
    let (mut text, existed) = strip_block(&current, SH_BEGIN, SH_END);
    if enable {
        if text.trim().is_empty() {
            text = "#!/bin/sh\n".into();
        }
        if !text.ends_with('\n') {
            text.push('\n');
        }
        // Run in the background so commits are never slowed down.
        text.push_str(&format!(
            "{SH_BEGIN}\n({} >/dev/null 2>&1 &)\n{SH_END}\n",
            hook_command(exe, "git")
        ));
    }
    if enable || existed {
        backup(&path)?;
        write(&path, &text)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))?;
        }
    }
    Ok(git_status(project_id, Some(repo_root)))
}

// ---------------------------------------------------------------- public API

/// Status of every client-level integration (global instructions + session hooks).
pub fn client_statuses(dirs: &PlatformDirs, exe: &Path) -> Vec<CaptureStatus> {
    let mut out = Vec::new();
    for client in [
        AiClient::ClaudeCode,
        AiClient::CodexCli,
        AiClient::GeminiCli,
    ] {
        out.push(global_status(client, dirs));
        out.push(hooks_status(client, dirs, exe));
    }
    out
}

pub fn toggle_client(
    integration: CaptureIntegration,
    client: AiClient,
    enable: bool,
    dirs: &PlatformDirs,
    exe: &Path,
) -> Result<CaptureStatus> {
    match integration {
        CaptureIntegration::GlobalInstructions => toggle_global(client, enable, dirs),
        CaptureIntegration::SessionHooks => toggle_hooks(client, enable, dirs, exe),
        CaptureIntegration::GitHooks => Err(CobaltError::InvalidInput(
            "git hooks are per project".into(),
        )),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn dirs(root: &Path) -> PlatformDirs {
        PlatformDirs {
            home: root.join("home"),
            app_config: root.join("cfg"),
        }
    }

    #[test]
    fn global_block_is_added_once_and_removed_cleanly() {
        let root = tempfile::tempdir().unwrap();
        let d = dirs(root.path());
        let file = global_file(AiClient::ClaudeCode, &d).unwrap();
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, "# Mis reglas\nUsa pnpm.\n").unwrap();
        assert!(
            toggle_global(AiClient::ClaudeCode, true, &d)
                .unwrap()
                .enabled
        );
        toggle_global(AiClient::ClaudeCode, true, &d).unwrap();
        let text = std::fs::read_to_string(&file).unwrap();
        assert_eq!(text.matches(BEGIN).count(), 1);
        assert!(text.starts_with("# Mis reglas\nUsa pnpm.\n"));
        assert!(
            !toggle_global(AiClient::ClaudeCode, false, &d)
                .unwrap()
                .enabled
        );
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "# Mis reglas\nUsa pnpm.\n"
        );
    }

    #[test]
    fn claude_hooks_keep_user_hooks() {
        let root = tempfile::tempdir().unwrap();
        let d = dirs(root.path());
        let exe = root.path().join("cobalt");
        let file = hooks_file(AiClient::ClaudeCode, &d).unwrap();
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, r#"{"model":"opus","hooks":{"Stop":[{"hooks":[{"type":"command","command":"notify-send done"}]}]}}"#).unwrap();
        assert!(
            toggle_hooks(AiClient::ClaudeCode, true, &d, &exe)
                .unwrap()
                .enabled
        );
        let doc: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(doc["model"], "opus");
        assert_eq!(doc["hooks"]["Stop"].as_array().unwrap().len(), 2);
        assert_eq!(
            doc["hooks"]["PostToolUse"][0]["matcher"],
            "Edit|Write|MultiEdit|NotebookEdit|Bash"
        );
        assert!(
            !toggle_hooks(AiClient::ClaudeCode, false, &d, &exe)
                .unwrap()
                .enabled
        );
        let doc: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(
            doc["hooks"]["Stop"][0]["hooks"][0]["command"],
            "notify-send done"
        );
        assert!(doc["hooks"].get("PostToolUse").is_none());
    }

    #[test]
    fn gemini_hooks_use_milliseconds_and_keep_settings() {
        let root = tempfile::tempdir().unwrap();
        let d = dirs(root.path());
        let exe = root.path().join("cobalt");
        let file = hooks_file(AiClient::GeminiCli, &d).unwrap();
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(
            &file,
            r#"{"theme":"Dracula","mcpServers":{"cobalt":{"command":"x"}}}"#,
        )
        .unwrap();
        assert!(
            toggle_hooks(AiClient::GeminiCli, true, &d, &exe)
                .unwrap()
                .enabled
        );
        let doc: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(doc["theme"], "Dracula");
        assert_eq!(
            doc["hooks"]["AfterTool"][0]["matcher"],
            "write_file|replace|run_shell_command"
        );
        assert_eq!(doc["hooks"]["AfterAgent"][0]["hooks"][0]["timeout"], 5000);
        assert!(
            !toggle_hooks(AiClient::GeminiCli, false, &d, &exe)
                .unwrap()
                .enabled
        );
        let doc: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert!(doc.get("hooks").is_none());
        assert_eq!(doc["mcpServers"]["cobalt"]["command"], "x");
    }

    #[test]
    fn codex_notify_never_replaces_foreign_program() {
        let root = tempfile::tempdir().unwrap();
        let d = dirs(root.path());
        let exe = root.path().join("cobalt");
        let file = hooks_file(AiClient::CodexCli, &d).unwrap();
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(
            &file,
            "model = \"o3\"\n\n[mcp_servers.x]\ncommand = \"x\"\n",
        )
        .unwrap();
        assert!(
            toggle_hooks(AiClient::CodexCli, true, &d, &exe)
                .unwrap()
                .enabled
        );
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(
            text.find("notify").unwrap() < text.find("[mcp_servers.x]").unwrap(),
            "{text}"
        );
        toggle_hooks(AiClient::CodexCli, false, &d, &exe).unwrap();
        assert!(!std::fs::read_to_string(&file).unwrap().contains("notify"));
        std::fs::write(&file, "notify = [\"/usr/bin/other\"]\n").unwrap();
        assert!(toggle_hooks(AiClient::CodexCli, true, &d, &exe).is_err());
        assert!(hooks_status(AiClient::CodexCli, &d, &exe).detail.is_some());
    }

    #[test]
    fn git_hook_chains_existing_hook() {
        let repo = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(repo.path().join(".git/hooks")).unwrap();
        let hook = repo.path().join(".git/hooks/post-commit");
        std::fs::write(&hook, "#!/bin/sh\necho previo\n").unwrap();
        let id = cobalt_core::ids::new_id();
        let exe = Path::new("/opt/cobalt");
        assert!(toggle_git(id, repo.path(), true, exe).unwrap().enabled);
        let text = std::fs::read_to_string(&hook).unwrap();
        assert!(text.contains("echo previo") && text.contains("--hook git"));
        toggle_git(id, repo.path(), false, exe).unwrap();
        assert_eq!(
            std::fs::read_to_string(&hook).unwrap(),
            "#!/bin/sh\necho previo\n"
        );
        let not_repo = tempfile::tempdir().unwrap();
        assert!(!git_status(id, Some(not_repo.path())).supported);
    }
}
