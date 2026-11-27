//! Local IPC between `cobalt --mcp-stdio` bridges and the single daemon.
//!
//! - Unix (Linux/macOS): Unix domain socket `~/.cobalt/daemon.sock` (home dir is 0700).
//! - Windows: named pipe `\\.\pipe\cobalt-daemon`.
//!
//! Wire protocol: newline-delimited JSON. The first line from the bridge is a handshake
//! `{"cobalt_auth": "<token>", "cwd": "<dir>"}`; the token lives in `~/.cobalt/daemon.token`
//! (regenerated at every daemon start, owner-only permissions). Every following line is an
//! MCP JSON-RPC message, relayed verbatim in both directions.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use cobalt_core::enums::McpTransport;
use cobalt_core::error::{CobaltError, Result};
use cobalt_core::paths::{DAEMON_SOCKET_FILE, DAEMON_TOKEN_FILE};
use interprocess::local_socket::tokio::{Listener, Stream, prelude::*};
use interprocess::local_socket::{ListenerOptions, Name};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::daemon::Daemon;
use crate::project::ClientContext;
use crate::protocol::Session;

#[derive(Debug, Serialize, Deserialize)]
struct Handshake {
    cobalt_auth: String,
    cwd: Option<String>,
}

fn socket_name(home: &Path) -> Result<Name<'static>> {
    #[cfg(windows)]
    {
        let _ = home;
        use interprocess::local_socket::{GenericNamespaced, ToNsName};
        "cobalt-daemon"
            .to_ns_name::<GenericNamespaced>()
            .map(|n| n.into_owned())
            .map_err(CobaltError::Io)
    }
    #[cfg(not(windows))]
    {
        use interprocess::local_socket::{GenericFilePath, ToFsName};
        unix_socket_path(home)
            .to_fs_name::<GenericFilePath>()
            .map(|n| n.into_owned())
            .map_err(CobaltError::Io)
    }
}

/// Unix socket paths are limited to ~104-108 bytes. Very long homes fall back to a per-home
/// socket in the system temp dir (access is still protected by the token).
#[cfg(not(windows))]
fn unix_socket_path(home: &Path) -> PathBuf {
    let preferred = home.join(DAEMON_SOCKET_FILE);
    if preferred.as_os_str().len() < 100 {
        return preferred;
    }
    let hash = home
        .to_string_lossy()
        .bytes()
        .fold(0xcbf2_9ce4_8422_2325_u64, |h, b| {
            (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3)
        });
    std::env::temp_dir().join(format!("cobalt-{hash:016x}.sock"))
}

fn token_path(home: &Path) -> PathBuf {
    home.join(DAEMON_TOKEN_FILE)
}

/// Writes a fresh random token readable only by the current user.
fn write_token(home: &Path) -> Result<String> {
    let token = hex::encode(rand::random::<[u8; 32]>());
    let path = token_path(home);
    std::fs::create_dir_all(home)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let _ = std::fs::set_permissions(home, std::fs::Permissions::from_mode(0o700));
        let _ = std::fs::remove_file(&path);
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)?;
        std::io::Write::write_all(&mut f, token.as_bytes())?;
    }
    #[cfg(not(unix))]
    std::fs::write(&path, &token)?;
    Ok(token)
}

pub fn read_token(home: &Path) -> Result<String> {
    Ok(std::fs::read_to_string(token_path(home))?.trim().to_owned())
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Running daemon socket server. Dropping it stops accepting connections.
pub struct SocketServer {
    task: tokio::task::JoinHandle<()>,
    pub token: String,
}

impl Drop for SocketServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl SocketServer {
    /// Binds the local socket. Fails with `Conflict` when another daemon is already live.
    pub async fn start(daemon: Arc<Daemon>) -> Result<Self> {
        let home = daemon.home.clone();
        if Stream::connect(socket_name(&home)?).await.is_ok() {
            return Err(CobaltError::Conflict(
                "another Cobalt daemon is already running".into(),
            ));
        }
        let token = write_token(&home)?;
        let listener = ListenerOptions::new()
            .name(socket_name(&home)?)
            .try_overwrite(true)
            .create_tokio()
            .map_err(CobaltError::Io)?;
        let accept_token = token.clone();
        let task = tokio::spawn(accept_loop(listener, daemon, accept_token));
        Ok(Self { task, token })
    }
}

async fn accept_loop(listener: Listener, daemon: Arc<Daemon>, token: String) {
    // Owned by this task: stopping the server (abort) drops the set and closes every bridge
    // connection, exactly like a daemon restart does.
    let mut connections = tokio::task::JoinSet::new();
    loop {
        while connections.try_join_next().is_some() {}
        match listener.accept().await {
            Ok(conn) => {
                let daemon = daemon.clone();
                let token = token.clone();
                connections.spawn(async move {
                    if let Err(err) = serve_connection(conn, daemon, &token).await {
                        tracing::debug!(%err, "bridge connection closed");
                    }
                });
            }
            Err(err) => {
                tracing::warn!(%err, "local socket accept failed");
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        }
    }
}

async fn serve_connection(conn: Stream, daemon: Arc<Daemon>, token: &str) -> Result<()> {
    let mut send = &conn;
    let mut lines = BufReader::new(&conn).lines();
    let first = tokio::time::timeout(Duration::from_secs(5), lines.next_line())
        .await
        .map_err(|_| CobaltError::Daemon("handshake timeout".into()))??
        .ok_or_else(|| CobaltError::Daemon("connection closed before handshake".into()))?;
    let hs: Handshake = serde_json::from_str(&first)
        .map_err(|_| CobaltError::Daemon("invalid handshake".into()))?;
    if !constant_time_eq(hs.cobalt_auth.as_bytes(), token.as_bytes()) {
        send.write_all(b"{\"cobalt_error\":\"unauthorized\"}\n")
            .await?;
        return Err(CobaltError::Daemon("unauthorized bridge".into()));
    }
    send.write_all(b"{\"cobalt_ok\":true}\n").await?;

    // A hook client sends exactly one `{"cobalt_hook": ...}` line and leaves.
    let first_msg = match lines.next_line().await? {
        Some(l) => l,
        None => return Ok(()),
    };
    if let Ok(serde_json::Value::Object(obj)) =
        serde_json::from_str::<serde_json::Value>(&first_msg)
        && let Some(hook) = obj.get("cobalt_hook")
    {
        if let Ok(env) = serde_json::from_value::<crate::capture::HookEnvelope>(hook.clone()) {
            let _ = daemon.handle_hook(env).await;
        }
        send.write_all(b"{\"cobalt_ok\":true}\n").await?;
        return Ok(());
    }
    // Session start: record the event, then answer with the context to inject (v1.13.0).
    if let Ok(serde_json::Value::Object(obj)) =
        serde_json::from_str::<serde_json::Value>(&first_msg)
        && let Some(hook) = obj.get("cobalt_context")
    {
        let mut context = String::new();
        if let Ok(env) = serde_json::from_value::<crate::capture::HookEnvelope>(hook.clone()) {
            context = daemon.session_context(&env).await;
            let _ = daemon.handle_hook(env).await;
        }
        let mut line =
            serde_json::to_vec(&serde_json::json!({ "cobalt_ok": true, "context": context }))?;
        line.push(b'\n');
        send.write_all(&line).await?;
        return Ok(());
    }

    let mut ctx = ClientContext::new(McpTransport::Stdio);
    ctx.cwd = hs.cwd;
    let mut session = Session::new(daemon, ctx);
    let mut pending = Some(first_msg);
    loop {
        let line = match pending.take() {
            Some(l) => l,
            None => match lines.next_line().await? {
                Some(l) => l,
                None => break,
            },
        };
        if line.trim().is_empty() {
            continue;
        }
        for out in session.handle_raw(&line).await {
            let mut bytes = serde_json::to_vec(&out)?;
            bytes.push(b'\n');
            send.write_all(&bytes).await?;
        }
        send.flush().await?;
    }
    Ok(())
}

// ============================================================================ bridge

/// Connects to the daemon (starting `cobalt --headless` if needed) and authenticates.
async fn connect_authenticated(home: &Path, daemon_exe: &Path) -> Result<Stream> {
    let mut spawned = false;
    for attempt in 0..120u32 {
        if let Ok(stream) = Stream::connect(socket_name(home)?).await
            && let Ok(token) = read_token(home)
        {
            let cwd = std::env::current_dir()
                .ok()
                .map(|d| d.to_string_lossy().into_owned());
            if handshake(&stream, token, cwd).await? {
                return Ok(stream);
            }
            return Err(CobaltError::Daemon(
                "daemon rejected the bridge token".into(),
            ));
        }
        if !spawned {
            spawn_daemon(daemon_exe)?;
            spawned = true;
        }
        tokio::time::sleep(Duration::from_millis(if attempt < 10 { 100 } else { 250 })).await;
    }
    Err(CobaltError::Daemon(
        "could not reach the Cobalt daemon".into(),
    ))
}

/// Starts `cobalt --headless` fully detached from the MCP client process.
fn spawn_daemon(exe: &Path) -> Result<()> {
    let mut cmd = std::process::Command::new(exe);
    cmd.arg(cobalt_core::paths::HEADLESS_FLAG)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    cmd.spawn()?;
    Ok(())
}

/// Sends the auth line and waits for `cobalt_ok`. Reads byte by byte so no MCP traffic is
/// swallowed by a buffer.
async fn handshake(stream: &Stream, token: String, cwd: Option<String>) -> Result<bool> {
    use tokio::io::AsyncReadExt;
    let mut line = serde_json::to_vec(&Handshake {
        cobalt_auth: token,
        cwd,
    })?;
    line.push(b'\n');
    let mut send = stream;
    send.write_all(&line).await?;
    let mut recv = stream;
    let mut reply = Vec::new();
    let mut byte = [0u8; 1];
    while reply.len() < 256 {
        if recv.read(&mut byte).await? == 0 || byte[0] == b'\n' {
            break;
        }
        reply.push(byte[0]);
    }
    Ok(String::from_utf8_lossy(&reply).contains("cobalt_ok"))
}

/// `cobalt --mcp-stdio`: relays stdin/stdout JSON-RPC lines to the daemon and back.
pub async fn run_stdio_bridge(home: &Path, daemon_exe: &Path) -> Result<()> {
    // Release builds restart a missing daemon; dev builds wait, because `tauri dev` owns the
    // app process and a headless copy would take over its single instance.
    let respawn = (!cfg!(debug_assertions)).then_some(daemon_exe);
    let first = connect_authenticated(home, daemon_exe).await?;
    run_bridge(
        home,
        respawn,
        first,
        BufReader::new(tokio::io::stdin()),
        tokio::io::stdout(),
    )
    .await
}

/// Id of the `initialize` the bridge replays after reconnecting (its response is dropped).
const REPLAY_ID: &str = "cobalt-bridge-reinit";
/// A request waiting for the daemon to come back fails after this long.
const OFFLINE_REQUEST_TIMEOUT: Duration = Duration::from_secs(45);
/// Release builds start the daemon again when it has been gone this long.
const RESPAWN_AFTER: Duration = Duration::from_secs(10);

/// Error sent for a request the daemon will never answer (it went away mid-call).
fn restart_error(id: &serde_json::Value) -> String {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": -32000, "message": "Cobalt daemon restarted; retry the request" }
    })
    .to_string()
}

/// MCP session state the bridge must replay after a daemon restart.
#[derive(Default)]
struct BridgeSession {
    initialize: Option<serde_json::Value>,
    initialized: Option<String>,
    /// Client requests sent to the daemon and not answered yet, keyed by serialized id.
    in_flight: std::collections::HashMap<String, serde_json::Value>,
}

impl BridgeSession {
    /// Remembers what a client line means for replay and pending answers.
    fn outgoing(&mut self, line: &str) {
        let Ok(msg) = serde_json::from_str::<serde_json::Value>(line) else {
            return;
        };
        match (msg.get("method").and_then(|m| m.as_str()), msg.get("id")) {
            (Some("initialize"), Some(id)) => {
                self.in_flight.insert(id.to_string(), id.clone());
                self.initialize = Some(msg);
            }
            (Some("notifications/initialized"), None) => self.initialized = Some(line.to_owned()),
            (Some(_), Some(id)) => {
                self.in_flight.insert(id.to_string(), id.clone());
            }
            _ => {}
        }
    }

    /// `false` when the daemon line must not reach the client (the replayed `initialize`).
    fn incoming(&mut self, line: &str) -> bool {
        let Ok(msg) = serde_json::from_str::<serde_json::Value>(line) else {
            return true;
        };
        if msg.get("method").is_some() {
            return true; // server → client request or notification
        }
        match msg.get("id") {
            Some(id) if id.as_str() == Some(REPLAY_ID) => false,
            Some(id) => {
                self.in_flight.remove(&id.to_string());
                true
            }
            None => true,
        }
    }

    /// Lines that rebuild the session on a fresh daemon connection.
    fn replay(&self) -> Vec<String> {
        let mut lines = Vec::new();
        if let Some(init) = &self.initialize {
            let mut init = init.clone();
            init["id"] = serde_json::Value::from(REPLAY_ID);
            lines.push(init.to_string());
            lines.extend(self.initialized.clone());
        }
        lines
    }
}

/// Why one daemon connection ended.
enum LinkEnd {
    ClientGone,
    DaemonGone,
}

async fn write_line<W: tokio::io::AsyncWrite + Unpin>(out: &mut W, line: &str) -> Result<()> {
    out.write_all(line.as_bytes()).await?;
    out.write_all(b"\n").await?;
    out.flush().await?;
    Ok(())
}

/// Relays between the client and the daemon, reconnecting (and replaying the MCP handshake)
/// whenever the daemon restarts, so the client never sees "connection closed".
pub async fn run_bridge<I, O>(
    home: &Path,
    respawn: Option<&Path>,
    first: Stream,
    input: I,
    mut output: O,
) -> Result<()>
where
    I: tokio::io::AsyncBufRead + Unpin + Send + 'static,
    O: tokio::io::AsyncWrite + Unpin,
{
    let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(256);
    tokio::spawn(async move {
        let mut lines = input.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if tx.send(line).await.is_err() {
                break;
            }
        }
    });
    let mut session = BridgeSession::default();
    let mut stream = first;
    // Client lines not delivered yet (sent before anything newer from stdin).
    let mut backlog = VecDeque::new();
    loop {
        match relay(&stream, &mut rx, &mut output, &mut session, &mut backlog).await? {
            LinkEnd::ClientGone => return Ok(()),
            LinkEnd::DaemonGone => {
                tracing::info!("daemon connection lost; reconnecting");
                for id in std::mem::take(&mut session.in_flight).into_values() {
                    write_line(&mut output, &restart_error(&id)).await?;
                }
                match reconnect(home, respawn, &mut rx, &mut output, &mut backlog).await? {
                    Some(fresh) => stream = fresh,
                    None => return Ok(()),
                }
                let mut send = &stream;
                for line in session.replay() {
                    write_line(&mut send, &line).await?;
                }
            }
        }
    }
}

/// One daemon connection: delivers the backlog first, then relays both ways.
async fn relay<O: tokio::io::AsyncWrite + Unpin>(
    stream: &Stream,
    rx: &mut tokio::sync::mpsc::Receiver<String>,
    output: &mut O,
    session: &mut BridgeSession,
    backlog: &mut VecDeque<String>,
) -> Result<LinkEnd> {
    let mut send = stream;
    let mut lines = BufReader::new(stream).lines();
    loop {
        let line = match backlog.pop_front() {
            Some(line) => line,
            None => tokio::select! {
                msg = rx.recv() => match msg {
                    Some(line) => line,
                    None => return Ok(LinkEnd::ClientGone),
                },
                got = lines.next_line() => match got {
                    Ok(Some(line)) => {
                        if session.incoming(&line) {
                            write_line(output, &line).await?;
                        }
                        continue;
                    }
                    Ok(None) | Err(_) => return Ok(LinkEnd::DaemonGone),
                },
            },
        };
        if line.trim().is_empty() {
            continue;
        }
        if write_line(&mut send, &line).await.is_err() {
            backlog.push_front(line);
            return Ok(LinkEnd::DaemonGone);
        }
        session.outgoing(&line);
    }
}

/// Tries one authenticated connection without starting a daemon.
async fn try_connect(home: &Path) -> Option<Stream> {
    let stream = Stream::connect(socket_name(home).ok()?).await.ok()?;
    let token = read_token(home).ok()?;
    let cwd = std::env::current_dir()
        .ok()
        .map(|d| d.to_string_lossy().into_owned());
    handshake(&stream, token, cwd)
        .await
        .ok()
        .filter(|ok| *ok)
        .map(|_| stream)
}

/// Waits for the daemon to come back. Client lines arriving meanwhile join the backlog; a
/// request older than [`OFFLINE_REQUEST_TIMEOUT`] is answered with an error and dropped.
/// `None` when the client left.
async fn reconnect<O: tokio::io::AsyncWrite + Unpin>(
    home: &Path,
    respawn: Option<&Path>,
    rx: &mut tokio::sync::mpsc::Receiver<String>,
    output: &mut O,
    backlog: &mut VecDeque<String>,
) -> Result<Option<Stream>> {
    let lost = tokio::time::Instant::now();
    let mut since: VecDeque<tokio::time::Instant> = backlog.iter().map(|_| lost).collect();
    let mut spawned = false;
    loop {
        if let Some(stream) = try_connect(home).await {
            return Ok(Some(stream));
        }
        if let Some(exe) = respawn
            && !spawned
            && lost.elapsed() >= RESPAWN_AFTER
        {
            spawned = spawn_daemon(exe).is_ok();
        }
        while since
            .front()
            .is_some_and(|t| t.elapsed() >= OFFLINE_REQUEST_TIMEOUT)
        {
            since.pop_front();
            if let Some(line) = backlog.pop_front()
                && let Ok(serde_json::Value::Object(msg)) = serde_json::from_str(&line)
                && let Some(id) = msg.get("id")
                && msg.contains_key("method")
            {
                write_line(output, &restart_error(id)).await?;
            }
        }
        tokio::select! {
            msg = rx.recv() => match msg {
                Some(line) => {
                    backlog.push_back(line);
                    since.push_back(tokio::time::Instant::now());
                }
                None => return Ok(None),
            },
            () = tokio::time::sleep(Duration::from_millis(250)) => {}
        }
    }
}

/// Client used by tests and tooling: connects to a running daemon without spawning one.
pub async fn connect_existing(home: &Path) -> Result<Stream> {
    let stream = Stream::connect(socket_name(home)?).await?;
    if handshake(&stream, read_token(home)?, None).await? {
        Ok(stream)
    } else {
        Err(CobaltError::Daemon("handshake rejected".into()))
    }
}

/// SessionStart hook client: delivers the event and returns the context to inject.
pub async fn request_context(home: &Path, env: &crate::capture::HookEnvelope) -> Result<String> {
    let stream = connect_existing(home).await?;
    let mut line = serde_json::to_vec(&serde_json::json!({ "cobalt_context": env }))?;
    line.push(b'\n');
    let mut send = &stream;
    send.write_all(&line).await?;
    send.flush().await?;
    let mut lines = BufReader::new(&stream).lines();
    let reply = lines
        .next_line()
        .await?
        .ok_or_else(|| CobaltError::Daemon("no context reply".into()))?;
    let value: serde_json::Value = serde_json::from_str(&reply)?;
    Ok(value
        .get("context")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_owned())
}

/// Hook client: authenticates and delivers one event to a running daemon (never spawns one).
pub async fn send_hook(home: &Path, env: &crate::capture::HookEnvelope) -> Result<()> {
    let stream = connect_existing(home).await?;
    let mut line = serde_json::to_vec(&serde_json::json!({ "cobalt_hook": env }))?;
    line.push(b'\n');
    let mut send = &stream;
    send.write_all(&line).await?;
    send.flush().await?;
    let mut ack = [0u8; 1];
    let mut recv = &stream;
    let _ = tokio::io::AsyncReadExt::read(&mut recv, &mut ack).await;
    Ok(())
}
