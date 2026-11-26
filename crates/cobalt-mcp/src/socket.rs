//! Local IPC between `cobalt --mcp-stdio` bridges and the single daemon.
//!
//! - Unix (Linux/macOS): Unix domain socket `~/.cobalt/daemon.sock` (home dir is 0700).
//! - Windows: named pipe `\\.\pipe\cobalt-daemon`.
//!
//! Wire protocol: newline-delimited JSON. The first line from the bridge is a handshake
//! `{"cobalt_auth": "<token>", "cwd": "<dir>"}`; the token lives in `~/.cobalt/daemon.token`
//! (regenerated at every daemon start, owner-only permissions). Every following line is an
//! MCP JSON-RPC message, relayed verbatim in both directions.

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
        home.join(DAEMON_SOCKET_FILE)
            .to_fs_name::<GenericFilePath>()
            .map(|n| n.into_owned())
            .map_err(CobaltError::Io)
    }
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
    loop {
        match listener.accept().await {
            Ok(conn) => {
                let daemon = daemon.clone();
                let token = token.clone();
                tokio::spawn(async move {
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

    let mut ctx = ClientContext::new(McpTransport::Stdio);
    ctx.cwd = hs.cwd;
    let mut session = Session::new(daemon, ctx);
    while let Some(line) = lines.next_line().await? {
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
    let stream = connect_authenticated(home, daemon_exe).await?;
    let mut send = &stream;

    let upstream = async {
        let mut stdin = BufReader::new(tokio::io::stdin()).lines();
        while let Some(line) = stdin.next_line().await? {
            send.write_all(line.as_bytes()).await?;
            send.write_all(b"\n").await?;
            send.flush().await?;
        }
        Ok::<_, CobaltError>(())
    };
    let downstream = async {
        let mut stdout = tokio::io::stdout();
        let mut lines = BufReader::new(&stream).lines();
        while let Some(line) = lines.next_line().await? {
            stdout.write_all(line.as_bytes()).await?;
            stdout.write_all(b"\n").await?;
            stdout.flush().await?;
        }
        Ok::<_, CobaltError>(())
    };
    // The client closing stdin (or the daemon closing the socket) ends the bridge.
    tokio::select! {
        r = upstream => r,
        r = downstream => r,
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
