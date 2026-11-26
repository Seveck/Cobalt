//! Non-MCP write paths that still go through the daemon so live events and telemetry stay
//! consistent:
//! - `save_from_app`: external programs (REST API). Same policy as MCP: Read-Only mode,
//!   Secret Scrubber and Token Firewall.
//! - `save_from_user`: the user acting in the Cobalt UI / quick note. Scrubbed, never blocked
//!   by Read-Only mode (which only pauses AI writes) nor by the firewall.

use std::time::Instant;

use cobalt_core::enums::{McpTransport, MemoryChangeKind, TelemetryOperation, WriteAction};
use cobalt_core::error::Result;
use cobalt_core::model::{MemoryChanged, NewMemory, SaveOutcome};
use cobalt_core::scrubber::scrub;
use cobalt_core::telemetry::{MatchedNode, McpActivity, NewTelemetryEvent, ReturnedItem};

use crate::daemon::Daemon;
use crate::project::ClientContext;

impl Daemon {
    pub async fn save_from_app(
        &self,
        mut new: NewMemory,
        client_name: &str,
    ) -> Result<SaveOutcome> {
        if self.is_read_only() {
            return Err(cobalt_core::CobaltError::ReadOnly);
        }
        let mut ctx = ClientContext::new(McpTransport::StreamableHttp);
        ctx.client_name = client_name.to_owned();
        let scrubbed = scrub(&new.content);
        new.content = match self.firewall.check_write(client_name, &scrubbed.text) {
            cobalt_core::firewall::FirewallVerdict::Allow => scrubbed.text,
            cobalt_core::firewall::FirewallVerdict::Truncated { content, .. } => content,
            cobalt_core::firewall::FirewallVerdict::Blocked { detail, .. } => {
                self.emit_firewall_blocked(client_name, &detail);
                return Err(cobalt_core::CobaltError::FirewallBlocked(detail));
            }
        };
        new.source_client = Some(client_name.to_owned());
        self.persist(new, client_name).await
    }

    pub async fn save_from_user(
        &self,
        mut new: NewMemory,
        client_name: &str,
    ) -> Result<SaveOutcome> {
        new.content = scrub(&new.content).text;
        new.reusable_snippet = new.reusable_snippet.map(|s| scrub(&s).text);
        new.source_client = Some(client_name.to_owned());
        self.persist(new, client_name).await
    }

    async fn persist(&self, new: NewMemory, client_name: &str) -> Result<SaveOutcome> {
        let started = Instant::now();
        let outcome = {
            let _slot = self.write_slot().await;
            self.store.save_memory(new).await?
        };
        let m = &outcome.memory;
        let log = self
            .store
            .record_event(NewTelemetryEvent {
                client_name: client_name.to_owned(),
                operation: TelemetryOperation::Write,
                query_text: None,
                returned_items: vec![ReturnedItem {
                    memory_id: m.id,
                    source_doc_id: m.source_doc_id,
                    similarity_score: outcome.matched_similarity.unwrap_or(1.0),
                    chunk_tokens: m.chunk_tokens,
                    content_snapshot: Some(m.content.clone()),
                }],
                injected_tokens: 0,
                output_tokens_saved: 0,
                latency_ms: i64::try_from(started.elapsed().as_millis()).unwrap_or(i64::MAX),
                project_id: m.project_id,
            })
            .await?;
        self.emit_activity(McpActivity {
            log_id: log.id,
            timestamp: log.timestamp,
            client_name: log.client_name,
            operation: log.operation,
            query_text: None,
            matched_nodes: vec![MatchedNode {
                memory_id: m.id,
                similarity_score: 1.0,
            }],
            injected_tokens: 0,
            avoided_full_tokens: log.avoided_full_tokens,
            saved_tokens: log.saved_tokens,
            latency_ms: log.latency_ms,
            is_replay: false,
        });
        if outcome.action != WriteAction::Duplicate {
            self.emit_memory_changed(MemoryChanged {
                kind: match outcome.action {
                    WriteAction::Superseded => MemoryChangeKind::Superseded,
                    WriteAction::UpdatedExisting => MemoryChangeKind::Updated,
                    _ => MemoryChangeKind::Created,
                },
                memory_ids: std::iter::once(m.id).chain(outcome.previous_id).collect(),
                source_client: Some(client_name.to_owned()),
            });
        }
        Ok(outcome)
    }
}
