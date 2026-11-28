//! Phase 2 IPC commands: memories, graph, governance, branches, snapshots, read-only mode,
//! daemon status and 3D replay. User edits from the UI go through the daemon so live events
//! stay consistent; they are scrubbed but never blocked by Read-Only mode (which only pauses
//! AI writes).

use cobalt_core::CobaltError;
use cobalt_core::enums::MemoryChangeKind;
use cobalt_core::events::{DaemonStatus, EVENT_MCP_ACTIVITY};
use cobalt_core::ipc::{
    CreateSnapshotArgs, IdArgs, IdsArgs, MergeDuplicatesArgs, PatchMemoryArgs,
    SetMemoryEncryptedArgs, SetReadOnlyArgs,
};
use cobalt_core::model::{
    Branch, BranchMergeReport, DuplicateCluster, GraphData, GraphQuery, Memory, MemoryChanged,
    NewBranch, NewMemory, SaveOutcome, Snapshot, UpdateMemoryRequest,
};
use cobalt_core::scrubber::scrub;
use cobalt_core::search::{SearchRequest, SearchResponse};
use cobalt_core::telemetry::{MatchedNode, McpActivity};
use tauri::{AppHandle, Emitter, State};

use crate::state::{AppState, blocking};

type CmdResult<T> = Result<T, CobaltError>;

const UI_CLIENT: &str = "cobalt-ui";

fn changed(state: &AppState, kind: MemoryChangeKind, ids: Vec<cobalt_core::Id>) {
    state.daemon.emit_memory_changed(MemoryChanged {
        kind,
        memory_ids: ids,
        source_client: Some(UI_CLIENT.into()),
    });
}

fn not_found(id: cobalt_core::Id) -> CobaltError {
    CobaltError::NotFound(format!("memory {id}"))
}

#[tauri::command]
pub async fn get_graph(state: State<'_, AppState>, args: GraphQuery) -> CmdResult<GraphData> {
    state.store().graph(args).await
}

#[tauri::command]
pub async fn get_memory(state: State<'_, AppState>, args: IdArgs) -> CmdResult<Memory> {
    state
        .store()
        .get_memory(args.id)
        .await?
        .ok_or_else(|| not_found(args.id))
}

#[tauri::command]
pub async fn get_memory_history(
    state: State<'_, AppState>,
    args: IdArgs,
) -> CmdResult<Vec<Memory>> {
    state.store().memory_history(args.id).await
}

#[tauri::command]
pub async fn save_memory(state: State<'_, AppState>, args: NewMemory) -> CmdResult<SaveOutcome> {
    state.daemon.save_from_user(args, UI_CLIENT).await
}

#[tauri::command]
pub async fn update_memory(
    state: State<'_, AppState>,
    mut args: UpdateMemoryRequest,
) -> CmdResult<SaveOutcome> {
    args.new_content = scrub(&args.new_content).text;
    args.source_client = Some(UI_CLIENT.into());
    let outcome = {
        let _slot = state.daemon.write_slot().await;
        state.store().update_memory(args).await?
    };
    let ids = std::iter::once(outcome.memory.id)
        .chain(outcome.previous_id)
        .collect();
    changed(&state, MemoryChangeKind::Superseded, ids);
    Ok(outcome)
}

#[tauri::command]
pub async fn patch_memory(state: State<'_, AppState>, args: PatchMemoryArgs) -> CmdResult<Memory> {
    let memory = {
        let _slot = state.daemon.write_slot().await;
        state.store().patch_memory(args.id, args.patch).await?
    };
    changed(&state, MemoryChangeKind::Updated, vec![memory.id]);
    Ok(memory)
}

#[tauri::command]
pub async fn delete_memory(state: State<'_, AppState>, args: IdArgs) -> CmdResult<()> {
    {
        let _slot = state.daemon.write_slot().await;
        state.store().delete_memory(args.id).await?;
    }
    changed(&state, MemoryChangeKind::Deleted, vec![args.id]);
    Ok(())
}

/// Encrypts a memory into the vault (or decrypts it back to plaintext permanently).
#[tauri::command]
pub async fn set_memory_encrypted(
    state: State<'_, AppState>,
    args: SetMemoryEncryptedArgs,
) -> CmdResult<Memory> {
    let memory = state
        .store()
        .get_memory(args.id)
        .await?
        .ok_or_else(|| not_found(args.id))?;
    let vault = state.vault.clone();
    let aad = args.id.as_bytes().to_vec();
    let updated = if args.encrypted {
        if memory.is_encrypted {
            return Ok(memory);
        }
        let plaintext = memory.content.clone();
        let (ct, nonce) = blocking(move || vault.encrypt(&aad, plaintext.as_bytes())).await?;
        let _slot = state.daemon.write_slot().await;
        state
            .store()
            .set_encrypted_payload(args.id, ct, nonce)
            .await?
    } else {
        if !memory.is_encrypted {
            return Ok(memory);
        }
        let plaintext = decrypt_memory(&memory, vault, aad).await?;
        let _slot = state.daemon.write_slot().await;
        state
            .store()
            .clear_encrypted_payload(args.id, plaintext)
            .await?
    };
    changed(&state, MemoryChangeKind::Updated, vec![args.id]);
    Ok(updated)
}

async fn decrypt_memory(
    memory: &Memory,
    vault: std::sync::Arc<cobalt_core::vault::Vault>,
    aad: Vec<u8>,
) -> CmdResult<String> {
    let (Some(ct), Some(nonce)) = (memory.ciphertext.clone(), memory.nonce.clone()) else {
        return Err(CobaltError::Integrity(
            "encrypted memory without payload".into(),
        ));
    };
    let bytes = blocking(move || vault.decrypt(&aad, &ct, &nonce)).await?;
    String::from_utf8(bytes)
        .map_err(|_| CobaltError::Integrity("decrypted text is not UTF-8".into()))
}

/// Decrypts for display only (nothing is persisted).
#[tauri::command]
pub async fn reveal_memory(state: State<'_, AppState>, args: IdArgs) -> CmdResult<String> {
    let memory = state
        .store()
        .get_memory(args.id)
        .await?
        .ok_or_else(|| not_found(args.id))?;
    if !memory.is_encrypted {
        return Ok(memory.content);
    }
    decrypt_memory(&memory, state.vault.clone(), args.id.as_bytes().to_vec()).await
}

/// RAG debugger / simulator (`record_hits` decides whether stats are touched).
#[tauri::command]
pub async fn search_memories(
    state: State<'_, AppState>,
    args: SearchRequest,
) -> CmdResult<SearchResponse> {
    state.store().search(args).await
}

#[tauri::command]
pub async fn list_branches(state: State<'_, AppState>) -> CmdResult<Vec<Branch>> {
    state.store().list_branches().await
}

#[tauri::command]
pub async fn create_branch(state: State<'_, AppState>, args: NewBranch) -> CmdResult<Branch> {
    state.store().create_branch(args).await
}

#[tauri::command]
pub async fn switch_branch(state: State<'_, AppState>, args: IdArgs) -> CmdResult<Branch> {
    let branch = {
        let _slot = state.daemon.write_slot().await;
        state.store().switch_branch(args.id).await?
    };
    changed(&state, MemoryChangeKind::Updated, Vec::new());
    Ok(branch)
}

#[tauri::command]
pub async fn merge_branch(
    state: State<'_, AppState>,
    args: IdArgs,
) -> CmdResult<BranchMergeReport> {
    let report = {
        let _slot = state.daemon.write_slot().await;
        state.store().merge_branch(args.id).await?
    };
    changed(&state, MemoryChangeKind::Updated, Vec::new());
    Ok(report)
}

#[tauri::command]
pub async fn discard_branch(state: State<'_, AppState>, args: IdArgs) -> CmdResult<()> {
    {
        let _slot = state.daemon.write_slot().await;
        state.store().discard_branch(args.id).await?;
    }
    changed(&state, MemoryChangeKind::Deleted, Vec::new());
    Ok(())
}

#[tauri::command]
pub async fn list_snapshots(state: State<'_, AppState>) -> CmdResult<Vec<Snapshot>> {
    state.store().list_snapshots().await
}

#[tauri::command]
pub async fn create_snapshot(
    state: State<'_, AppState>,
    args: CreateSnapshotArgs,
) -> CmdResult<Snapshot> {
    state.store().create_snapshot(args.label.trim()).await
}

/// Time-Travel: writes are paused (queued) while the database is restored.
#[tauri::command]
pub async fn restore_snapshot(state: State<'_, AppState>, args: IdArgs) -> CmdResult<Snapshot> {
    let snapshot = {
        let _pause = state.daemon.pause_writes().await;
        state.store().restore_snapshot(args.id).await?
    };
    changed(&state, MemoryChangeKind::Restored, Vec::new());
    Ok(snapshot)
}

#[tauri::command]
pub async fn delete_snapshot(state: State<'_, AppState>, args: IdArgs) -> CmdResult<()> {
    state.store().delete_snapshot(args.id).await
}

#[tauri::command]
pub async fn find_duplicates(state: State<'_, AppState>) -> CmdResult<Vec<DuplicateCluster>> {
    state.store().find_duplicates().await
}

/// Pairs of memories that look contradictory (Limpiar cerebro → Contradicciones, v1.15.0).
#[tauri::command]
pub async fn find_conflicts(
    state: State<'_, AppState>,
) -> CmdResult<Vec<cobalt_core::model::ConflictPair>> {
    state.store().find_conflicts(50).await
}

/// Moves memories and whole documents to another folder/project (v1.18.0).
#[tauri::command]
pub async fn move_to_project(
    state: State<'_, AppState>,
    args: cobalt_core::model::MoveToProjectRequest,
) -> CmdResult<cobalt_core::model::MoveReport> {
    let ids = args.memory_ids.clone();
    let report = {
        let _slot = state.daemon.write_slot().await;
        state.store().move_to_project(args).await?
    };
    changed(&state, MemoryChangeKind::Updated, ids);
    Ok(report)
}

#[tauri::command]
pub async fn merge_duplicates(
    state: State<'_, AppState>,
    args: MergeDuplicatesArgs,
) -> CmdResult<Memory> {
    let kept = {
        let _slot = state.daemon.write_slot().await;
        state
            .store()
            .merge_duplicates(args.keep_id, &args.merge_ids)
            .await?
    };
    let ids = std::iter::once(kept.id).chain(args.merge_ids).collect();
    changed(&state, MemoryChangeKind::Superseded, ids);
    Ok(kept)
}

#[tauri::command]
pub async fn archive_memories(state: State<'_, AppState>, args: IdsArgs) -> CmdResult<u64> {
    let n = {
        let _slot = state.daemon.write_slot().await;
        state.store().archive_memories(&args.ids).await?
    };
    changed(&state, MemoryChangeKind::Archived, args.ids);
    Ok(n)
}

#[tauri::command]
pub async fn restore_memories(state: State<'_, AppState>, args: IdsArgs) -> CmdResult<u64> {
    let n = {
        let _slot = state.daemon.write_slot().await;
        state.store().restore_memories(&args.ids).await?
    };
    changed(&state, MemoryChangeKind::Restored, args.ids);
    Ok(n)
}

#[tauri::command]
pub fn get_read_only(state: State<'_, AppState>) -> CmdResult<bool> {
    Ok(state.daemon.is_read_only())
}

#[tauri::command]
pub async fn set_read_only(state: State<'_, AppState>, args: SetReadOnlyArgs) -> CmdResult<bool> {
    state.daemon.set_read_only(args.read_only).await
}

#[tauri::command]
pub fn get_daemon_status(state: State<'_, AppState>) -> CmdResult<DaemonStatus> {
    Ok(state.daemon.status())
}

/// Re-emits a past operation as a live pulse (`is_replay = true`) for the 3D view.
#[tauri::command]
pub async fn replay_activity(
    app: AppHandle,
    state: State<'_, AppState>,
    args: IdArgs,
) -> CmdResult<McpActivity> {
    let log = state
        .store()
        .get_telemetry_log(args.id)
        .await?
        .ok_or_else(|| CobaltError::NotFound(format!("telemetry log {}", args.id)))?;
    let activity = McpActivity {
        log_id: log.id,
        timestamp: log.timestamp,
        client_name: log.client_name,
        operation: log.operation,
        query_text: log.query_text,
        matched_nodes: log
            .returned_items
            .iter()
            .map(|i| MatchedNode {
                memory_id: i.memory_id,
                similarity_score: i.similarity_score,
            })
            .collect(),
        injected_tokens: log.injected_tokens,
        avoided_full_tokens: log.avoided_full_tokens,
        saved_tokens: log.saved_tokens,
        latency_ms: log.latency_ms,
        is_replay: true,
    };
    if let Err(err) = app.emit(EVENT_MCP_ACTIVITY, &activity) {
        tracing::warn!(%err, "failed to emit replay");
    }
    Ok(activity)
}

#[tauri::command]
pub async fn get_source_document(
    state: State<'_, AppState>,
    args: IdArgs,
) -> CmdResult<cobalt_core::model::SourceDocument> {
    state
        .store()
        .get_source_document(args.id)
        .await?
        .ok_or_else(|| CobaltError::NotFound(format!("source document {}", args.id)))
}

#[tauri::command]
pub async fn verify_source_document(
    state: State<'_, AppState>,
    args: IdArgs,
) -> CmdResult<cobalt_core::enums::FileAvailability> {
    state.store().verify_source_document(args.id).await
}

#[tauri::command]
pub async fn get_archive_impact(
    state: State<'_, AppState>,
    args: IdArgs,
) -> CmdResult<cobalt_core::mcp::ArchiveImpact> {
    state.daemon.archive_impact(args.id, None).await
}

/// Everything the user must know before an irreversible delete.
#[tauri::command]
pub async fn get_deletion_impact(
    state: State<'_, AppState>,
    args: IdArgs,
) -> CmdResult<cobalt_core::model::DeletionImpact> {
    let store = state.store();
    let m = store
        .get_memory(args.id)
        .await?
        .ok_or_else(|| not_found(args.id))?;
    let used_by = store.memory_usage_by_client(args.id).await?;
    let history_versions = store
        .memory_history(args.id)
        .await?
        .iter()
        .filter(|v| v.id != m.id)
        .count() as u64;
    let snapshots_possibly_containing = store
        .list_snapshots()
        .await?
        .iter()
        .filter(|s| s.created_at >= m.created_at)
        .count() as u64;
    let mut consequences = vec!["delete.consequence.irreversible".to_owned()];
    if m.is_core_pin {
        consequences.push("delete.consequence.core_law".into());
    }
    if m.is_reusable {
        consequences.push("delete.consequence.reusable".into());
    }
    if !used_by.is_empty() {
        consequences.push("delete.consequence.used_by_agents".into());
    }
    if history_versions > 0 {
        consequences.push("delete.consequence.history".into());
    }
    if snapshots_possibly_containing > 0 {
        consequences.push("delete.consequence.snapshots".into());
    }
    if m.is_encrypted {
        consequences.push("delete.consequence.encrypted".into());
    }
    Ok(cobalt_core::model::DeletionImpact {
        memory_id: m.id,
        preview: if m.is_encrypted {
            String::new()
        } else {
            m.content.chars().take(160).collect()
        },
        is_core_pin: m.is_core_pin,
        is_reusable: m.is_reusable,
        reuse_count: m.reuse_count,
        hit_count: m.hit_count,
        is_encrypted: m.is_encrypted,
        used_by,
        history_versions,
        snapshots_possibly_containing,
        consequences,
    })
}

// ------------------------------------------------------------------ memory proposals (v1.14.0)

/// Inbox of decisions, fixes and preferences noticed in AI sessions.
#[tauri::command]
pub async fn list_proposals(
    state: State<'_, AppState>,
    args: cobalt_core::ipc::ListProposalsArgs,
) -> CmdResult<Vec<cobalt_core::model::MemoryProposal>> {
    state.store().list_proposals(args.status, 200).await
}

/// Saves the proposal (optionally edited) through the normal write path — scrubber, firewall,
/// Check-Before-Write — credited to the AI whose session produced it.
#[tauri::command]
pub async fn accept_proposal(
    state: State<'_, AppState>,
    args: cobalt_core::ipc::AcceptProposalArgs,
) -> CmdResult<cobalt_core::model::MemoryProposal> {
    use cobalt_core::enums::{MemoryCategory, ProposalKind, ProposalStatus};
    let proposal = state
        .store()
        .get_proposal(args.id)
        .await?
        .ok_or_else(|| CobaltError::NotFound(format!("proposal {}", args.id)))?;
    if proposal.status != ProposalStatus::Pending {
        return Err(CobaltError::Conflict(
            "this proposal was already reviewed".into(),
        ));
    }
    let content = args
        .content
        .map(|c| c.trim().to_owned())
        .filter(|c| !c.is_empty())
        .unwrap_or_else(|| proposal.content.clone());
    let category = match proposal.kind {
        ProposalKind::Preference => MemoryCategory::Preference,
        ProposalKind::Decision | ProposalKind::Fix => MemoryCategory::Decision,
        // The user reviewed instruction-like text and chose to keep it: store it as a note.
        ProposalKind::Suspicious => MemoryCategory::Note,
    };
    let outcome = {
        let _slot = state.daemon.write_slot().await;
        state
            .daemon
            .save_from_app(
                cobalt_core::model::NewMemory {
                    content,
                    category,
                    project_id: proposal.project_id,
                    branch_id: None,
                    source_doc_id: None,
                    source_type: None,
                    confidence: Some(0.9),
                    is_core_pin: false,
                    is_reusable: false,
                    reusable_snippet: None,
                    source_client: None,
                },
                &proposal.client_name,
            )
            .await?
    };
    let updated = state
        .store()
        .set_proposal_status(
            proposal.id,
            ProposalStatus::Accepted,
            Some(outcome.memory.id),
        )
        .await?;
    state.daemon.announce_proposals().await;
    Ok(updated)
}

#[tauri::command]
pub async fn reject_proposal(
    state: State<'_, AppState>,
    args: IdArgs,
) -> CmdResult<cobalt_core::model::MemoryProposal> {
    let updated = state
        .store()
        .set_proposal_status(args.id, cobalt_core::enums::ProposalStatus::Rejected, None)
        .await?;
    state.daemon.announce_proposals().await;
    Ok(updated)
}
