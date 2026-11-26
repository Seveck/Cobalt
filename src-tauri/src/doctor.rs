//! MCP Doctor: 1-click self-diagnosis of the daemon, storage, embedding engine, vault and
//! every AI client's configuration, with automatic fixes where they are safe.

use cobalt_core::connectors::{DoctorCheck, DoctorReport};
use cobalt_core::enums::{AiClient, CheckStatus, EngineState};
use cobalt_core::error::{CobaltError, Result};
use cobalt_core::ids::now;
use cobalt_core::model::GraphQuery;
use cobalt_core::search::{ProjectScope, SearchFilter, SearchRequest};
use cobalt_mcp::connectors::{self, PlatformDirs};

use crate::state::AppState;

fn check(
    id: &str,
    label_key: &str,
    status: CheckStatus,
    detail: Option<String>,
    fixable: bool,
) -> DoctorCheck {
    DoctorCheck {
        id: id.into(),
        label_key: label_key.into(),
        status,
        detail,
        fixable,
    }
}

pub async fn run(state: &AppState) -> Result<DoctorReport> {
    let mut checks = Vec::new();
    let settings = state.config.get();

    // Daemon local socket (what `cobalt --mcp-stdio` bridges use).
    checks.push(
        match cobalt_mcp::socket::connect_existing(&state.home).await {
            Ok(_) => check(
                "daemon.socket",
                "doctor.daemon_socket",
                CheckStatus::Ok,
                None,
                false,
            ),
            Err(e) => check(
                "daemon.socket",
                "doctor.daemon_socket",
                CheckStatus::Error,
                Some(e.to_string()),
                true,
            ),
        },
    );

    // HTTP endpoint.
    let status = state.daemon.status();
    checks.push(match (settings.mcp.http_enabled, status.http_port) {
        (false, _) => check(
            "daemon.http",
            "doctor.daemon_http",
            CheckStatus::Skipped,
            Some("disabled in settings".into()),
            false,
        ),
        (true, Some(port)) => check(
            "daemon.http",
            "doctor.daemon_http",
            CheckStatus::Ok,
            Some(format!("http://127.0.0.1:{port}")),
            false,
        ),
        (true, None) => check(
            "daemon.http",
            "doctor.daemon_http",
            CheckStatus::Warning,
            Some(format!(
                "port {} could not be bound",
                settings.mcp.http_port
            )),
            true,
        ),
    });

    // Canonical store readable.
    let store = state.store();
    checks.push(
        match store
            .graph(GraphQuery {
                limit: Some(1),
                ..GraphQuery::default()
            })
            .await
        {
            Ok(_) => check(
                "sqlite.readable",
                "doctor.sqlite",
                CheckStatus::Ok,
                None,
                false,
            ),
            Err(e) => check(
                "sqlite.readable",
                "doctor.sqlite",
                CheckStatus::Error,
                Some(e.to_string()),
                false,
            ),
        },
    );

    // Embedding model installed + retrieval answering.
    let model_state = state.engines.model_state(&settings.embedding_model_id);
    checks.push(if model_state == EngineState::Installed {
        check(
            "engine.model",
            "doctor.engine_model",
            CheckStatus::Ok,
            Some(settings.embedding_model_id.clone()),
            false,
        )
    } else {
        check(
            "engine.model",
            "doctor.engine_model",
            CheckStatus::Error,
            Some(format!(
                "{} is {model_state}; reinstall it from Settings",
                settings.embedding_model_id
            )),
            false,
        )
    });
    let probe = store
        .search(SearchRequest {
            query: "cobalt doctor probe".into(),
            scope: ProjectScope::All,
            branch_id: None,
            top_k: Some(1),
            include_archived: false,
            filter: SearchFilter::default(),
            rrf_override: None,
            record_hits: false,
        })
        .await;
    checks.push(match probe {
        Ok(r) => check(
            "engine.retrieval",
            "doctor.engine_retrieval",
            CheckStatus::Ok,
            Some(format!("{} ms", r.latency_ms)),
            false,
        ),
        Err(e) => check(
            "engine.retrieval",
            "doctor.engine_retrieval",
            CheckStatus::Error,
            Some(e.to_string()),
            model_state == EngineState::Installed,
        ),
    });

    // Vault metadata.
    checks.push(if state.vault.is_initialized() {
        check(
            "vault",
            "doctor.vault",
            CheckStatus::Ok,
            Some(
                if state.vault.is_unlocked() {
                    "unlocked"
                } else {
                    "locked"
                }
                .into(),
            ),
            false,
        )
    } else {
        check(
            "vault",
            "doctor.vault",
            CheckStatus::Skipped,
            Some("not set up".into()),
            false,
        )
    });

    // AI clients.
    if let Ok(dirs) = PlatformDirs::detect() {
        let exe = std::env::current_exe()?;
        for st in connectors::status_all(&dirs, &exe) {
            let id = format!("client.{}", st.client.as_str());
            let path = st.config_path.clone().unwrap_or_default();
            checks.push(if let Some(err) = st.error {
                check(&id, "doctor.client", CheckStatus::Error, Some(err), false)
            } else if st.connected && !st.broken {
                check(&id, "doctor.client", CheckStatus::Ok, Some(path), false)
            } else if st.broken {
                check(
                    &id,
                    "doctor.client",
                    CheckStatus::Warning,
                    Some(format!("{path}: entry points to an old or missing binary")),
                    true,
                )
            } else if st.detected {
                check(
                    &id,
                    "doctor.client",
                    CheckStatus::Skipped,
                    Some(format!("{path}: installed, not connected")),
                    false,
                )
            } else {
                check(
                    &id,
                    "doctor.client",
                    CheckStatus::Skipped,
                    Some("not installed".into()),
                    false,
                )
            });
        }
    }

    let healthy = checks.iter().all(|c| c.status != CheckStatus::Error);
    Ok(DoctorReport {
        generated_at: now(),
        healthy,
        checks,
    })
}

pub async fn fix(state: &AppState, check_id: &str) -> Result<()> {
    match check_id {
        "daemon.socket" | "daemon.http" => state.start_servers().await,
        "engine.retrieval" => state.activate_engine().await.map(|_| ()),
        id if id.starts_with("client.") => {
            let client: AiClient = id.trim_start_matches("client.").parse()?;
            let dirs = PlatformDirs::detect()?;
            connectors::toggle(client, true, &dirs, &std::env::current_exe()?).map(|_| ())
        }
        other => Err(CobaltError::Unsupported(format!(
            "no automatic fix for '{other}'"
        ))),
    }
}
