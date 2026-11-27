//! Automatic capture from AI CLIs (`docs/CLI_CAPTURE.md`): hook events sent by
//! `cobalt --hook <source>` are turned into live `cobalt://cli-activity` events, re-indexing of
//! touched files (through the [`EventSink`](crate::EventSink)) and automatic session handoffs.

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, Write as _};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use cobalt_core::enums::{CliActivityKind, McpTransport, MemoryCategory, SourceType};
use cobalt_core::error::{CobaltError, Result};
use cobalt_core::events::CliActivity;
use cobalt_core::ids::now;
use cobalt_core::model::{NewHandoff, NewMemory};
use cobalt_core::paths::HOOK_QUEUE_FILE;
use cobalt_core::scrubber::scrub;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::daemon::Daemon;
use crate::project::{ClientContext, Resolved};

/// What `cobalt --hook <source>` forwards to the daemon.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookEnvelope {
    /// `claude`, `codex`, `git`.
    pub source: String,
    /// Working directory of the hook process.
    pub cwd: Option<String>,
    /// Raw event JSON from the client (stdin or last CLI arg); for git, collected commit data.
    pub payload: Value,
}

/// Per-session state kept by the daemon (touched files, handoff throttling).
#[derive(Default)]
pub(crate) struct SessionTracker {
    files: HashMap<String, Vec<String>>,
    last_handoff: HashMap<String, Instant>,
}

const HANDOFF_THROTTLE: Duration = Duration::from_secs(600);
const MAX_TRACKED_FILES: usize = 40;

fn str_at<'a>(v: &'a Value, path: &str) -> Option<&'a str> {
    v.pointer(path).and_then(Value::as_str)
}

/// Client name for a custom hook source: lowercase `[a-z0-9._-]` (spaces become `-`), ≤ 32 chars
/// (empty = invalid).
pub fn client_label(source: &str) -> String {
    source
        .trim()
        .to_lowercase()
        .chars()
        .map(|c| if c.is_whitespace() { '-' } else { c })
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        .take(32)
        .collect()
}

fn short(text: &str, max: usize) -> String {
    let t: String = text.chars().take(max).collect();
    if text.chars().count() > max {
        format!("{t}…")
    } else {
        t
    }
}

/// Last assistant text in a Claude Code transcript (JSONL), if readable.
fn last_assistant_message(transcript: &Path) -> Option<String> {
    let file = std::fs::File::open(transcript).ok()?;
    let mut last = None;
    for line in std::io::BufReader::new(file)
        .lines()
        .map_while(std::result::Result::ok)
    {
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if v.get("type").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        if let Some(parts) = v.pointer("/message/content").and_then(Value::as_array) {
            let text: Vec<&str> = parts
                .iter()
                .filter(|p| p.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|p| p.get("text").and_then(Value::as_str))
                .collect();
            if !text.is_empty() {
                last = Some(text.join("\n"));
            }
        }
    }
    last
}

/// Last plain-text message the user typed in a Claude Code transcript (tool results skipped).
fn last_user_message(transcript: &Path) -> Option<String> {
    let file = std::fs::File::open(transcript).ok()?;
    let mut last = None;
    for line in std::io::BufReader::new(file)
        .lines()
        .map_while(std::result::Result::ok)
    {
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if v.get("type").and_then(Value::as_str) != Some("user") {
            continue;
        }
        match v.pointer("/message/content") {
            Some(Value::String(t)) => last = Some(t.clone()),
            Some(Value::Array(parts)) => {
                let text: Vec<&str> = parts
                    .iter()
                    .filter(|p| p.get("type").and_then(Value::as_str) == Some("text"))
                    .filter_map(|p| p.get("text").and_then(Value::as_str))
                    .collect();
                if !text.is_empty() {
                    last = Some(text.join("\n"));
                }
            }
            _ => {}
        }
    }
    last
}

/// Who sent a hook event and from where.
fn hook_client(env: &HookEnvelope) -> ClientContext {
    let mut ctx = ClientContext::new(McpTransport::Stdio);
    ctx.cwd = env
        .cwd
        .clone()
        .or_else(|| str_at(&env.payload, "/cwd").map(str::to_owned));
    ctx.client_name = match env.source.as_str() {
        "claude" => "claude-code".into(),
        "codex" => "codex".into(),
        "gemini" => "gemini-cli".into(),
        "git" => "git".into(),
        other => client_label(other),
    };
    ctx
}

/// `true` for a SessionStart event of a client that accepts injected context.
pub fn wants_session_context(env: &HookEnvelope) -> bool {
    matches!(env.source.as_str(), "claude" | "gemini")
        && str_at(&env.payload, "/hook_event_name") == Some("SessionStart")
}

/// Hard cap for injected session context (clients allow ~10k characters).
const SESSION_CONTEXT_MAX_CHARS: usize = 6_000;

impl Daemon {
    /// Text injected at session start (v1.13.0): the project's rules and the latest handoff,
    /// exactly as `list_project_rules` / `resume_handoff` would return them. Empty when disabled,
    /// outside a project with nothing to say, or on error (never blocks the client).
    pub async fn session_context(&self, env: &HookEnvelope) -> String {
        if !self.config.get().capture.session_context || !wants_session_context(env) {
            return String::new();
        }
        let ctx = hook_client(env);
        if ctx.client_name.is_empty() || ctx.cwd.is_none() {
            return String::new();
        }
        let mut parts = Vec::new();
        if let Ok(out) = self
            .call_tool(
                cobalt_core::mcp::TOOL_LIST_PROJECT_RULES,
                serde_json::json!({}),
                &ctx,
            )
            .await
            && !out.text.contains("No rules yet")
        {
            parts.push(out.text);
        }
        if let Ok(out) = self
            .call_tool(
                cobalt_core::mcp::TOOL_RESUME_HANDOFF,
                serde_json::json!({}),
                &ctx,
            )
            .await
            && out.structured.get("handoff").is_some_and(|h| !h.is_null())
        {
            parts.push(out.text);
        }
        if parts.is_empty() {
            return String::new();
        }
        parts.insert(
            0,
            "Cobalt (the user's shared AI memory) loaded this automatically. Obey these rules; \
             use search_memory before re-reading files and save_memory for decisions."
                .to_owned(),
        );
        let mut text = parts.join("\n\n");
        if text.chars().count() > SESSION_CONTEXT_MAX_CHARS {
            text = text
                .chars()
                .take(SESSION_CONTEXT_MAX_CHARS)
                .collect::<String>()
                + "\n…";
        }
        text
    }

    /// Handles one hook event. Never fails loudly: hooks must not disturb the user's CLI.
    pub async fn handle_hook(&self, env: HookEnvelope) -> Result<()> {
        let ctx = hook_client(&env);
        if ctx.client_name.is_empty() {
            return Ok(());
        }
        let resolved = if ctx.cwd.is_some() {
            self.resolve_project(None, &ctx).await?
        } else {
            Resolved::Global
        };
        let (project_id, project_name) = match &resolved {
            Resolved::Project { project, .. } => (Some(project.id), Some(project.name.clone())),
            Resolved::Global => (None, None),
        };
        if let Resolved::Project { project, .. } = &resolved {
            self.notify_project_active(project);
        }
        let p = &env.payload;
        let session = str_at(p, "/session_id").unwrap_or("default").to_owned();
        let mut activity = CliActivity {
            timestamp: now(),
            client_name: ctx.client_name.clone(),
            kind: CliActivityKind::TurnEnd,
            project_id,
            project_name,
            cwd: ctx.cwd.clone(),
            files: Vec::new(),
            detail: None,
        };

        match env.source.as_str() {
            "claude" => {
                let event = str_at(p, "/hook_event_name").unwrap_or_default();
                match event {
                    "SessionStart" => activity.kind = CliActivityKind::SessionStart,
                    "PostToolUse" => {
                        let tool = str_at(p, "/tool_name").unwrap_or_default();
                        if tool == "Bash" {
                            activity.kind = CliActivityKind::Command;
                            activity.detail = str_at(p, "/tool_input/command")
                                .map(|c| short(&scrub(c).text, 160));
                        } else {
                            activity.kind = CliActivityKind::FileEdit;
                            let file = str_at(p, "/tool_input/file_path")
                                .or_else(|| str_at(p, "/tool_input/notebook_path"));
                            if let Some(f) = file {
                                activity.files.push(f.to_owned());
                                self.track_file(&session, f);
                            }
                        }
                    }
                    "Stop" | "SessionEnd" => {
                        activity.kind = if event == "Stop" {
                            CliActivityKind::TurnEnd
                        } else {
                            CliActivityKind::SessionEnd
                        };
                        let transcript = str_at(p, "/transcript_path").map(Path::new);
                        let message = transcript.and_then(last_assistant_message);
                        let user = transcript.and_then(last_user_message);
                        activity.detail = message.as_deref().map(|m| short(&scrub(m).text, 160));
                        activity.files = self.session_files(&session);
                        self.auto_handoff(
                            &ctx,
                            &resolved,
                            &session,
                            message.as_deref(),
                            &activity.files,
                            event == "SessionEnd",
                        )
                        .await;
                        self.propose_from_turn(
                            &ctx.client_name,
                            resolved.project_id(),
                            message.as_deref(),
                            user.as_deref(),
                        )
                        .await;
                    }
                    _ => return Ok(()),
                }
            }
            "gemini" => {
                let event = str_at(p, "/hook_event_name").unwrap_or_default();
                match event {
                    "SessionStart" => activity.kind = CliActivityKind::SessionStart,
                    "AfterTool" => {
                        let tool = str_at(p, "/tool_name").unwrap_or_default();
                        if tool == "run_shell_command" {
                            activity.kind = CliActivityKind::Command;
                            activity.detail = str_at(p, "/tool_input/command")
                                .map(|c| short(&scrub(c).text, 160));
                        } else {
                            activity.kind = CliActivityKind::FileEdit;
                            let file = str_at(p, "/tool_input/file_path")
                                .or_else(|| str_at(p, "/tool_input/absolute_path"));
                            if let Some(f) = file {
                                activity.files.push(f.to_owned());
                                self.track_file(&session, f);
                            }
                        }
                    }
                    "AfterAgent" | "SessionEnd" => {
                        activity.kind = if event == "AfterAgent" {
                            CliActivityKind::TurnEnd
                        } else {
                            CliActivityKind::SessionEnd
                        };
                        let message = str_at(p, "/prompt_response").map(str::to_owned);
                        let user = str_at(p, "/prompt").map(str::to_owned);
                        activity.detail = message.as_deref().map(|m| short(&scrub(m).text, 160));
                        activity.files = self.session_files(&session);
                        self.auto_handoff(
                            &ctx,
                            &resolved,
                            &session,
                            message.as_deref(),
                            &activity.files,
                            event == "SessionEnd",
                        )
                        .await;
                        self.propose_from_turn(
                            &ctx.client_name,
                            resolved.project_id(),
                            message.as_deref(),
                            user.as_deref(),
                        )
                        .await;
                    }
                    _ => return Ok(()),
                }
            }
            "codex" => {
                if str_at(p, "/type") != Some("agent-turn-complete") {
                    return Ok(());
                }
                let message = str_at(p, "/last-assistant-message").map(str::to_owned);
                activity.detail = message.as_deref().map(|m| short(&scrub(m).text, 160));
                let turn = str_at(p, "/turn-id").unwrap_or("codex").to_owned();
                self.auto_handoff(&ctx, &resolved, &turn, message.as_deref(), &[], false)
                    .await;
                let user = p
                    .get("input-messages")
                    .and_then(Value::as_array)
                    .and_then(|a| a.last())
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                self.propose_from_turn(
                    &ctx.client_name,
                    resolved.project_id(),
                    message.as_deref(),
                    user.as_deref(),
                )
                .await;
            }
            "git" => {
                activity.kind = CliActivityKind::GitCommit;
                let sha = str_at(p, "/sha").unwrap_or_default();
                let branch = str_at(p, "/branch").unwrap_or("HEAD");
                let subject = str_at(p, "/subject").unwrap_or_default();
                let body = str_at(p, "/body").unwrap_or_default().trim();
                activity.files = p
                    .get("files")
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter_map(Value::as_str)
                            .map(str::to_owned)
                            .collect()
                    })
                    .unwrap_or_default();
                activity.detail = Some(short(
                    &format!("{} {subject}", sha.chars().take(8).collect::<String>()),
                    160,
                ));
                if self.config.get().capture.git_commits && !subject.is_empty() {
                    let mut content = format!(
                        "Commit {} on {branch}: {subject}",
                        sha.chars().take(8).collect::<String>()
                    );
                    if !body.is_empty() {
                        content.push('\n');
                        content.push_str(&short(body, 600));
                    }
                    if !activity.files.is_empty() {
                        content.push_str(&format!(
                            "\nFiles: {}",
                            activity
                                .files
                                .iter()
                                .take(20)
                                .cloned()
                                .collect::<Vec<_>>()
                                .join(", ")
                        ));
                    }
                    let new = NewMemory {
                        content,
                        category: MemoryCategory::Doc,
                        project_id: resolved.project_id(),
                        branch_id: None,
                        source_doc_id: None,
                        source_type: Some(SourceType::Note),
                        confidence: Some(1.0),
                        is_core_pin: false,
                        is_reusable: false,
                        reusable_snippet: None,
                        source_client: None,
                    };
                    if let Err(err) = self.save_captured(new, "git").await {
                        tracing::debug!(%err, "git commit not recorded");
                    }
                }
            }
            // Any other tool: the generic event format (docs/CLI_CAPTURE.md §3.1).
            _ => {
                let files: Vec<String> = p
                    .get("files")
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter_map(Value::as_str)
                            .take(MAX_TRACKED_FILES)
                            .map(str::to_owned)
                            .collect()
                    })
                    .unwrap_or_default();
                match str_at(p, "/event").unwrap_or_default() {
                    "session_start" => activity.kind = CliActivityKind::SessionStart,
                    "file_edit" => {
                        activity.kind = CliActivityKind::FileEdit;
                        for f in &files {
                            self.track_file(&session, f);
                        }
                        activity.files = files;
                    }
                    "command" => {
                        activity.kind = CliActivityKind::Command;
                        activity.detail = str_at(p, "/command").map(|c| short(&scrub(c).text, 160));
                    }
                    event @ ("turn_end" | "session_end") => {
                        let ended = event == "session_end";
                        activity.kind = if ended {
                            CliActivityKind::SessionEnd
                        } else {
                            CliActivityKind::TurnEnd
                        };
                        for f in &files {
                            self.track_file(&session, f);
                        }
                        let message = str_at(p, "/message").map(str::to_owned);
                        let user = str_at(p, "/user_message").map(str::to_owned);
                        activity.detail = message.as_deref().map(|m| short(&scrub(m).text, 160));
                        activity.files = self.session_files(&session);
                        self.auto_handoff(
                            &ctx,
                            &resolved,
                            &session,
                            message.as_deref(),
                            &activity.files,
                            ended,
                        )
                        .await;
                        self.propose_from_turn(
                            &ctx.client_name,
                            resolved.project_id(),
                            message.as_deref(),
                            user.as_deref(),
                        )
                        .await;
                    }
                    _ => return Ok(()),
                }
            }
        }
        self.emit_cli_activity(activity);
        Ok(())
    }

    fn track_file(&self, session: &str, file: &str) {
        let mut t = self.sessions.lock().unwrap_or_else(|p| p.into_inner());
        let files = t.files.entry(session.to_owned()).or_default();
        if !files.iter().any(|f| f == file) {
            files.push(file.to_owned());
            if files.len() > MAX_TRACKED_FILES {
                files.remove(0);
            }
        }
    }

    fn session_files(&self, session: &str) -> Vec<String> {
        let t = self.sessions.lock().unwrap_or_else(|p| p.into_inner());
        t.files.get(session).cloned().unwrap_or_default()
    }

    /// Ephemeral handoff summarizing where the session stopped (never permanent memory).
    async fn auto_handoff(
        &self,
        ctx: &ClientContext,
        resolved: &Resolved,
        session: &str,
        message: Option<&str>,
        files: &[String],
        force: bool,
    ) {
        if !self.config.get().capture.session_handoffs || self.is_read_only() {
            return;
        }
        {
            let mut t = self.sessions.lock().unwrap_or_else(|p| p.into_inner());
            if !force
                && t.last_handoff
                    .get(session)
                    .is_some_and(|i| i.elapsed() < HANDOFF_THROTTLE)
            {
                return;
            }
            t.last_handoff.insert(session.to_owned(), Instant::now());
        }
        let Some(message) = message.map(str::trim).filter(|m| !m.is_empty()) else {
            return;
        };
        let summary = format!(
            "[auto] {} stopped here: {}",
            ctx.client_name,
            scrub(message).text
        );
        let summary = self
            .tokens
            .truncate(&summary, cobalt_core::mcp::HANDOFF_MAX_TOKENS as usize);
        let result = self
            .store()
            .create_handoff(NewHandoff {
                project_id: resolved.project_id(),
                source_client: ctx.client_name.clone(),
                summary,
                last_error: None,
                open_files: files.to_vec(),
                ttl_hours: Some(self.config.get().mcp.handoff_ttl_hours),
            })
            .await;
        if let Err(err) = result {
            tracing::debug!(%err, "automatic handoff not created");
        }
    }

    /// Replays hook events queued while the daemon was down.
    pub async fn replay_hook_queue(&self) {
        let path = self.home.join(HOOK_QUEUE_FILE);
        let Ok(raw) = std::fs::read_to_string(&path) else {
            return;
        };
        let _ = std::fs::remove_file(&path);
        for line in raw.lines().filter(|l| !l.trim().is_empty()) {
            if let Ok(env) = serde_json::from_str::<HookEnvelope>(line)
                && let Err(err) = self.handle_hook(env).await
            {
                tracing::debug!(%err, "queued hook event failed");
            }
        }
    }
}

/// Projects already announced to the sink in this process (auto-watch once per project).
#[derive(Default)]
pub(crate) struct SeenProjects(pub(crate) Mutex<HashSet<cobalt_core::Id>>);

// ============================================================================ hook client

/// Gathers commit data for the git hook from the repository in `cwd`.
fn git_payload(cwd: &Path) -> Value {
    let git = |args: &[&str]| -> String {
        std::process::Command::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
            .unwrap_or_default()
    };
    let files: Vec<String> = git(&["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"])
        .lines()
        .map(|f| cwd.join(f).to_string_lossy().into_owned())
        .collect();
    serde_json::json!({
        "sha": git(&["rev-parse", "HEAD"]),
        "branch": git(&["rev-parse", "--abbrev-ref", "HEAD"]),
        "subject": git(&["log", "-1", "--format=%s"]),
        "body": git(&["log", "-1", "--format=%b"]),
        "files": files,
    })
}

/// `cobalt --hook <source>`: forwards the event to the daemon or queues it. Always quick.
pub async fn run_hook(home: &Path, source: &str, last_arg: Option<String>) -> Result<()> {
    let cwd = std::env::current_dir().ok();
    let payload = match source {
        "git" => cwd.as_deref().map(git_payload).unwrap_or(Value::Null),
        "codex" => last_arg
            .and_then(|a| serde_json::from_str(&a).ok())
            .unwrap_or(Value::Null),
        // Custom tools may pass the event JSON as the last argument instead of stdin.
        _ if last_arg
            .as_deref()
            .is_some_and(|a| a.trim_start().starts_with('{')) =>
        {
            last_arg
                .and_then(|a| serde_json::from_str(&a).ok())
                .unwrap_or(Value::Null)
        }
        _ => {
            let mut raw = String::new();
            let read = tokio::time::timeout(Duration::from_secs(2), async {
                use tokio::io::AsyncReadExt;
                tokio::io::stdin().read_to_string(&mut raw).await
            })
            .await;
            match read {
                Ok(Ok(_)) => serde_json::from_str(&raw).unwrap_or(Value::Null),
                _ => Value::Null,
            }
        }
    };
    if payload.is_null() {
        return Ok(());
    }
    let env = HookEnvelope {
        source: source.to_owned(),
        cwd: cwd.map(|c| c.to_string_lossy().into_owned()),
        payload,
    };
    if wants_session_context(&env) {
        // SessionStart: ask the daemon for the rules + latest handoff and hand them to the
        // client on stdout (its documented JSON shape). Nothing is printed if Cobalt is closed.
        let got = tokio::time::timeout(
            Duration::from_secs(4),
            crate::socket::request_context(home, &env),
        )
        .await;
        match got {
            Ok(Ok(context)) => {
                if !context.is_empty() {
                    let out = serde_json::json!({
                        "hookSpecificOutput": {
                            "hookEventName": "SessionStart",
                            "additionalContext": context,
                        }
                    });
                    println!("{out}");
                }
                return Ok(());
            }
            _ => {
                queue_hook(home, &env)?;
                return Ok(());
            }
        }
    }
    let sent =
        tokio::time::timeout(Duration::from_secs(2), crate::socket::send_hook(home, &env)).await;
    if !matches!(sent, Ok(Ok(()))) {
        queue_hook(home, &env)?;
    }
    Ok(())
}

fn queue_hook(home: &Path, env: &HookEnvelope) -> Result<()> {
    std::fs::create_dir_all(home)?;
    let path: PathBuf = home.join(HOOK_QUEUE_FILE);
    if std::fs::metadata(&path)
        .map(|m| m.len() > 5 * 1024 * 1024)
        .unwrap_or(false)
    {
        return Err(CobaltError::Conflict("hook queue full".into()));
    }
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    writeln!(f, "{}", serde_json::to_string(env)?)?;
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn reads_last_assistant_text_from_transcript() {
        let dir = tempfile::tempdir().unwrap();
        let t = dir.path().join("t.jsonl");
        std::fs::write(
            &t,
            [
                r#"{"type":"user","message":{"content":"hola"}}"#,
                r#"{"type":"assistant","message":{"content":[{"type":"text","text":"primera"}]}}"#,
                r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit"},{"type":"text","text":"Listo: migré la API a v2."}]}}"#,
            ]
            .join("\n"),
        )
        .unwrap();
        assert_eq!(
            last_assistant_message(&t).as_deref(),
            Some("Listo: migré la API a v2.")
        );
    }

    #[test]
    fn queue_appends_events() {
        let dir = tempfile::tempdir().unwrap();
        let env = HookEnvelope {
            source: "claude".into(),
            cwd: None,
            payload: serde_json::json!({"a":1}),
        };
        queue_hook(dir.path(), &env).unwrap();
        queue_hook(dir.path(), &env).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join(HOOK_QUEUE_FILE))
                .unwrap()
                .lines()
                .count(),
            2
        );
    }
}
