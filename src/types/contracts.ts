/**
 * Cobalt frozen contracts — exact TypeScript mirror of `crates/cobalt-core`.
 *
 * OWNED BY [CLAUDE]. Read-only for every other agent. Any change here must be made together
 * with the Rust source and `docs/CONTRACTS.md` (CONTRACT_VERSION below).
 *
 * Wire conventions:
 *  - Field names are snake_case (serde default). Frontend-only types (layouts) use camelCase.
 *  - Ids are UUID strings, timestamps RFC 3339 strings, blobs base64 strings.
 *  - Rust `Option<T>` => `T | null` (always present in payloads coming from Rust).
 *    In argument payloads sent to Rust, `null` and omission are equivalent unless the field
 *    is a patch field typed `PatchField<T>` (omitted = unchanged, null = clear).
 *  - i64/u64 counters are JS numbers (safe below 2^53).
 */

export const CONTRACT_VERSION = "1.3.2";
export const SCHEMA_VERSION = 1;

export type Uuid = string;
export type IsoDateTime = string;
export type Base64 = string;
/** Patch semantics: omitted = unchanged, `null` = clear, value = set. */
export type PatchField<T> = T | null | undefined;

// ============================================================================ enums

export const SOURCE_TYPES = [
  "md", "sql", "bash", "rs", "ts", "js", "py", "java", "json", "yaml", "toml",
  "html", "css", "dockerfile", "pdf", "image", "note", "other",
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const MEMORY_CATEGORIES = ["preference", "decision", "code", "doc", "note", "ocr"] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export const MEMORY_STATUSES = ["active", "superseded", "archived"] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export type EdgeType = "semantic" | "supersedes" | "same_project";

export const TELEMETRY_OPERATIONS = [
  "read", "write", "update", "reuse", "handoff", "blocked_firewall",
] as const;
export type TelemetryOperation = (typeof TELEMETRY_OPERATIONS)[number];

export const HARDWARE_TIERS = ["eco", "balanced", "ultra"] as const;
export type HardwareTier = (typeof HARDWARE_TIERS)[number];

export const ENGINE_KINDS = [
  "sqlite_vec", "usearch", "qdrant_sidecar", "lance_db", "qdrant_remote", "chroma_db",
] as const;
export type EngineKind = (typeof ENGINE_KINDS)[number];

export type EmbeddingProvider = "fastembed" | "ollama";
export type Quantization = "int8" | "fp16" | "fp32";
export type Pooling = "mean" | "cls";
export type TokenEncoding = "cl100k_base" | "o200k_base";

export const LANGUAGES = ["es", "en"] as const;
export type Language = (typeof LANGUAGES)[number];

export type FileAvailability = "available" | "modified" | "snippet_only" | "missing";

export const LAYOUT_TYPES = [
  "galaxy", "brain", "neural_net", "knowledge_tree", "project_clusters", "custom_mesh",
] as const;
export type LayoutType = (typeof LAYOUT_TYPES)[number];

export type WriteAction = "inserted" | "updated_existing" | "superseded" | "duplicate";

export const AI_CLIENTS = [
  "claude_desktop", "claude_code", "cursor", "windsurf", "cline", "gemini_cli", "codex_cli",
] as const;
export type AiClient = (typeof AI_CLIENTS)[number];

export type GpuDeviceType = "discrete_gpu" | "integrated_gpu" | "virtual_gpu" | "cpu" | "other";
export type GpuBackend = "vulkan" | "metal" | "dx12" | "gl" | "browser_webgpu" | "other";

export type DownloadPhase =
  | "queued" | "downloading" | "verifying" | "extracting" | "retrying" | "completed"
  | "failed" | "cancelled";

export type EngineState =
  | "not_installed" | "downloading" | "installed" | "running" | "stopped" | "error";

export type EngineSwapPhase =
  | "queueing_writes" | "staging" | "reindexing" | "verifying" | "swapping" | "draining"
  | "completed" | "rolling_back" | "rolled_back" | "failed";

export type CheckStatus = "ok" | "warning" | "error" | "skipped";
export type ThemeCompatibility = "compatible" | "degraded" | "incompatible";

export type PastLifeSource =
  | "chatgpt_export" | "claude_export" | "cursor_rules" | "claude_md" | "markdown_folder";

export type MemoryChangeKind =
  | "created" | "updated" | "superseded" | "archived" | "deleted" | "restored";

export type DuplicateKind = "duplicate" | "conflict";
export type SemanticEdgesMode = "always" | "hover_only" | "never";
export type ClusterSizeMetric = "vectors" | "tokens";
export type NodeShape = "sphere" | "icosahedron" | "octahedron" | "box" | "point" | "mesh";
export type ConfigFormat = "json" | "toml";
export type McpTransport = "stdio" | "streamable_http" | "sse";

export type ErrorKind =
  | "not_found" | "invalid_input" | "conflict" | "read_only" | "firewall_blocked"
  | "vault_locked" | "crypto" | "storage" | "engine" | "embedding" | "download"
  | "integrity" | "sandbox" | "daemon" | "io" | "serialization" | "cancelled"
  | "unsupported" | "internal";

/** Shape of every rejected `invoke()` promise. */
export interface ErrorPayload {
  kind: ErrorKind;
  message: string;
}

/** Fixed id of the `main` memory branch (identical on every installation). */
export const MAIN_BRANCH_ID: Uuid = "00000000-0000-7000-8000-000000000001";
export const MAIN_BRANCH_NAME = "main";
export const BUILTIN_THEME_ID = "cobalt-minimal";

// ============================================================================ entities

export interface Project {
  id: Uuid;
  name: string;
  root_path: string | null;
  color_hex: string;
  is_archived: boolean;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}

export interface NewProject {
  name: string;
  root_path: string | null;
  color_hex: string | null;
}

export interface ProjectPatch {
  name?: string | null;
  root_path?: PatchField<string>;
  color_hex?: string | null;
  is_archived?: boolean | null;
}

export interface ProjectStats {
  project: Project;
  vector_count: number;
  total_tokens: number;
  reusable_count: number;
}

export interface Branch {
  id: Uuid;
  name: string;
  parent_branch_id: Uuid | null;
  created_at: IsoDateTime;
  is_active: boolean;
}

export interface NewBranch {
  name: string;
  parent_branch_id: Uuid | null;
}

export interface BranchMergeReport {
  source_branch_id: Uuid;
  target_branch_id: Uuid;
  merged: number;
  superseded: number;
  skipped_duplicates: number;
}

export interface SourceDocument {
  id: Uuid;
  project_id: Uuid | null;
  file_path: string;
  is_dir: boolean;
  source_type: SourceType;
  file_hash: string | null;
  total_tokens: number;
  is_watched: boolean;
  updated_at: IsoDateTime;
}

export interface Memory {
  id: Uuid;
  branch_id: Uuid;
  project_id: Uuid | null;
  source_doc_id: Uuid | null;
  /** Empty string when `is_encrypted`. */
  content: string;
  content_hash: string;
  source_type: SourceType;
  category: MemoryCategory;
  confidence: number;
  status: MemoryStatus;
  superseded_by: Uuid | null;
  version_reason: string | null;
  is_core_pin: boolean;
  is_reusable: boolean;
  reusable_snippet: string | null;
  reuse_count: number;
  is_encrypted: boolean;
  ciphertext: Base64 | null;
  nonce: Base64 | null;
  chunk_tokens: number;
  hit_count: number;
  relevance_score: number;
  pos_x: number | null;
  pos_y: number | null;
  pos_z: number | null;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
  last_accessed_at: IsoDateTime | null;
  source_client: string | null;
}

export interface NewMemory {
  content: string;
  category: MemoryCategory;
  project_id: Uuid | null;
  branch_id: Uuid | null;
  source_doc_id: Uuid | null;
  source_type: SourceType | null;
  confidence: number | null;
  is_core_pin: boolean;
  is_reusable: boolean;
  reusable_snippet: string | null;
  source_client: string | null;
}

export interface UpdateMemoryRequest {
  memory_id: Uuid;
  new_content: string;
  reason: string;
  confidence: number | null;
  source_client: string | null;
}

export interface MemoryPatch {
  category?: MemoryCategory | null;
  confidence?: number | null;
  status?: MemoryStatus | null;
  is_core_pin?: boolean | null;
  is_reusable?: boolean | null;
  reusable_snippet?: PatchField<string>;
  project_id?: PatchField<Uuid>;
  branch_id?: Uuid | null;
}

export interface SaveOutcome {
  action: WriteAction;
  memory: Memory;
  previous_id: Uuid | null;
  matched_similarity: number | null;
  redacted_secrets: number;
  truncated: boolean;
}

export interface MemoryEdge {
  source_id: Uuid;
  target_id: Uuid;
  edge_type: EdgeType;
  weight: number;
}

export interface Handoff {
  id: Uuid;
  project_id: Uuid | null;
  source_client: string;
  summary: string;
  last_error: string | null;
  open_files: string[];
  created_at: IsoDateTime;
  expires_at: IsoDateTime;
  consumed_by: string | null;
}

export interface Snapshot {
  id: Uuid;
  label: string;
  created_at: IsoDateTime;
  memory_count: number;
  file_path: string;
}

export interface InstalledTheme {
  id: string;
  name: string;
  author: string;
  version: string;
  size_bytes: number;
  hardware_tier: HardwareTier;
  local_path: string;
  installed_at: IsoDateTime;
}

// ============================================================================ graph / governance

export type Vec3 = [number, number, number];

export interface GraphNode {
  id: Uuid;
  branch_id: Uuid;
  project_id: Uuid | null;
  source_doc_id: Uuid | null;
  source_type: SourceType;
  category: MemoryCategory;
  status: MemoryStatus;
  confidence: number;
  is_core_pin: boolean;
  is_reusable: boolean;
  is_encrypted: boolean;
  reuse_count: number;
  hit_count: number;
  relevance_score: number;
  chunk_tokens: number;
  superseded_by: Uuid | null;
  /** Cached projection inside a sphere of radius 100. */
  position: Vec3 | null;
  preview: string;
  updated_at: IsoDateTime;
}

export interface GraphQuery {
  branch_id: Uuid | null;
  include_archived: boolean;
  include_superseded: boolean;
  min_edge_weight: number | null;
  limit: number | null;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: MemoryEdge[];
  projects: ProjectStats[];
  branch: Branch;
}

export interface DuplicateCluster {
  kind: DuplicateKind;
  memory_ids: Uuid[];
  max_similarity: number;
  suggested_keep_id: Uuid;
}

export interface DecayReport {
  evaluated: number;
  decayed: number;
  archived: number;
}

export interface MemoryChanged {
  kind: MemoryChangeKind;
  memory_ids: Uuid[];
  source_client: string | null;
}

export interface VaultStatus {
  initialized: boolean;
  unlocked: boolean;
  auto_lock_minutes: number;
  encrypted_count: number;
}

// ============================================================================ search

export type ProjectScope =
  | { kind: "all" }
  | { kind: "global" }
  | { kind: "project"; project_id: Uuid }
  | { kind: "project_and_global"; project_id: Uuid }
  | { kind: "all_except"; project_id: Uuid };

export interface SearchFilter {
  source_types: SourceType[];
  categories: MemoryCategory[];
  only_reusable: boolean;
  min_confidence: number | null;
}

export interface RrfWeights {
  k: number;
  vector_weight: number;
  fts_weight: number;
}

export interface SearchRequest {
  query: string;
  scope: ProjectScope;
  branch_id: Uuid | null;
  top_k: number | null;
  include_archived: boolean;
  filter: SearchFilter;
  rrf_override: RrfWeights | null;
  record_hits: boolean;
}

export interface SearchHit {
  memory: Memory;
  score: number;
  similarity_score: number;
  vector_rank: number | null;
  fts_rank: number | null;
  bm25: number | null;
  rrf_score: number;
}

export interface TokenSavings {
  injected_tokens: number;
  avoided_full_tokens: number;
  saved_tokens: number;
}

export interface SearchResponse {
  hits: SearchHit[];
  core_rules: Memory[];
  savings: TokenSavings;
  latency_ms: number;
}

export interface ReusableAsset {
  memory_id: Uuid;
  summary: string;
  source_type: SourceType;
  origin_project_id: Uuid | null;
  origin_project_name: string | null;
  origin_project_color: string | null;
  source_doc_id: Uuid | null;
  file_path: string | null;
  availability: FileAvailability;
  snippet: string | null;
  reuse_count: number;
  output_tokens_saved: number;
  similarity_score: number;
  status: MemoryStatus;
}

export interface LibraryFilter {
  query: string | null;
  source_types: SourceType[];
  project_ids: Uuid[];
  availability: FileAvailability[];
  limit: number | null;
  offset: number | null;
}

export interface WebContextRequest {
  task: string;
  project_id: Uuid | null;
  max_tokens: number | null;
}

export interface WebContext {
  text: string;
  tokens: number;
  memory_ids: Uuid[];
}

// ============================================================================ telemetry

export interface ReturnedItem {
  memory_id: Uuid;
  source_doc_id: Uuid | null;
  similarity_score: number;
  chunk_tokens: number;
  content_snapshot: string | null;
}

export interface TelemetryLog {
  id: Uuid;
  timestamp: IsoDateTime;
  client_name: string;
  operation: TelemetryOperation;
  query_text: string | null;
  returned_items: ReturnedItem[];
  injected_tokens: number;
  avoided_full_tokens: number;
  saved_tokens: number;
  latency_ms: number;
  project_id: Uuid | null;
}

export interface TelemetryQuery {
  client_name: string | null;
  project_id: Uuid | null;
  operations: TelemetryOperation[];
  from: IsoDateTime | null;
  to: IsoDateTime | null;
  text: string | null;
  limit: number | null;
  offset: number | null;
}

export interface Page<T> {
  items: T[];
  total: number;
}

export interface TelemetryRange {
  from: IsoDateTime | null;
  to: IsoDateTime | null;
  session_only: boolean;
}

export interface ClientStats {
  client_name: string;
  reads: number;
  writes: number;
  updates: number;
  reuses: number;
  handoffs: number;
  blocked: number;
  saved_tokens: number;
}

export interface NodeValue {
  memory_id: Uuid;
  preview: string;
  hit_count: number;
  reuse_count: number;
  project_id: Uuid | null;
}

export interface TimeBucket {
  bucket_start: IsoDateTime;
  saved_tokens: number;
  injected_tokens: number;
  avoided_full_tokens: number;
  operations: number;
}

export interface TelemetrySummary {
  total_saved_tokens: number;
  session_saved_tokens: number;
  saved_from_reads: number;
  saved_from_reuse: number;
  total_injected_tokens: number;
  total_avoided_tokens: number;
  compression_ratio: number;
  by_client: ClientStats[];
  top_nodes: NodeValue[];
  timeline: TimeBucket[];
}

export interface MatchedNode {
  memory_id: Uuid;
  similarity_score: number;
}

/** Payload of `cobalt://mcp-activity`. */
export interface McpActivity {
  log_id: Uuid;
  timestamp: IsoDateTime;
  client_name: string;
  operation: TelemetryOperation;
  query_text: string | null;
  matched_nodes: MatchedNode[];
  injected_tokens: number;
  avoided_full_tokens: number;
  saved_tokens: number;
  latency_ms: number;
  is_replay: boolean;
}

// ============================================================================ hardware / engines

export interface GpuInfo {
  name: string;
  vendor_id: number;
  device_type: GpuDeviceType;
  backend: GpuBackend;
}

export interface TierRecommendation {
  tier: HardwareTier;
  engine: EngineKind;
  model_id: string;
  download_bytes: number;
  reason_key: string;
}

export interface HardwareProfile {
  os: string;
  os_version: string | null;
  arch: string;
  total_ram_bytes: number;
  available_ram_bytes: number;
  cpu_brand: string;
  physical_cores: number | null;
  logical_cores: number;
  gpus: GpuInfo[];
  recommendation: TierRecommendation;
}

export interface EmbeddingModelSpec {
  id: string;
  provider: EmbeddingProvider;
  display_name: string;
  dimensions: number;
  size_bytes: number;
  quantization: Quantization;
  recommended_tier: HardwareTier;
  multilingual: boolean;
  /** Pooling over `last_hidden_state` (e5 = mean, bge = cls); output is L2-normalized. */
  pooling: Pooling;
  hf_repo: string | null;
  /** `"query: "` for the e5 family. */
  query_prefix: string | null;
  /** `"passage: "` for the e5 family. */
  document_prefix: string | null;
}

/** Default embedding models (multilingual on every tier; English-only ones are Pro-only). */
export const DEFAULT_MODEL_BY_TIER: Record<HardwareTier, string> = {
  eco: "multilingual-e5-small",
  balanced: "multilingual-e5-base",
  ultra: "bge-m3",
};
export const DEFAULT_ENGINE_BY_TIER: Record<HardwareTier, EngineKind> = {
  eco: "sqlite_vec",
  balanced: "usearch",
  ultra: "qdrant_sidecar",
};
export const PRO_ENGLISH_MODELS = ["all-minilm-l6-v2", "bge-small-en-v1.5", "bge-large-en-v1.5"] as const;

export interface DownloadProgress {
  artifact_id: string;
  phase: DownloadPhase;
  downloaded_bytes: number;
  total_bytes: number | null;
  attempt: number;
  message: string | null;
}

export interface EngineInstallRequest {
  engine: EngineKind;
  model_id: string;
}

export interface EngineStatus {
  engine: EngineKind;
  engine_state: EngineState;
  model_id: string;
  model_state: EngineState;
  dimensions: number;
  vector_count: number;
  installed_bytes: number;
  sidecar_endpoint: string | null;
  last_error: string | null;
}

export interface EngineSwapRequest {
  target_engine: EngineKind;
  target_model_id: string;
  external_endpoint: string | null;
}

export interface EngineSwapProgress {
  swap_id: Uuid;
  phase: EngineSwapPhase;
  processed: number;
  total: number;
  queued_writes: number;
  message: string | null;
}

export interface EngineSwapReport {
  swap_id: Uuid;
  from_engine: EngineKind;
  to_engine: EngineKind;
  from_model_id: string;
  to_model_id: string;
  reembedded: number;
  verified_count: number;
  rolled_back: boolean;
  started_at: IsoDateTime;
  finished_at: IsoDateTime;
  reclaimable_bytes: number;
}

// ============================================================================ settings

export interface SearchSettings {
  top_k: number;
  min_similarity: number;
  dedup_threshold: number;
  duplicate_threshold: number;
  import_collision_threshold: number;
  semantic_edge_threshold: number;
  rrf: RrfWeights;
  confidence_weight: number;
  core_pin_boost: number;
}

export interface ChunkingSettings {
  max_chunk_tokens: number;
  overlap_tokens: number;
}

export interface DecaySettings {
  enabled: boolean;
  inactive_days: number;
  decay_rate: number;
  archive_threshold: number;
}

export interface RetentionSettings {
  detailed_log_limit: number;
  detailed_log_days: number;
}

export interface FirewallSettings {
  max_tokens_per_memory: number;
  max_writes_per_minute: number;
  max_reads_per_minute: number;
  repeated_write_window_secs: number;
  notify_on_block: boolean;
}

export interface VaultSettings {
  auto_lock_minutes: number;
}

export interface ShortcutSettings {
  quick_note: string;
  toggle_read_only: string;
}

export interface McpSettings {
  http_enabled: boolean;
  http_port: number;
  rest_enabled: boolean;
  handoff_ttl_hours: number;
  tool_docstring_overrides: Record<string, string>;
}

export interface OllamaSettings {
  base_url: string;
}

export interface AppSettings {
  onboarding_completed: boolean;
  hardware_tier: HardwareTier;
  vector_engine: EngineKind;
  embedding_model_id: string;
  token_encoding: TokenEncoding;
  language: Language;
  active_theme_id: string;
  read_only: boolean;
  pro_mode: boolean;
  search: SearchSettings;
  chunking: ChunkingSettings;
  decay: DecaySettings;
  retention: RetentionSettings;
  firewall: FirewallSettings;
  vault: VaultSettings;
  shortcuts: ShortcutSettings;
  mcp: McpSettings;
  ollama: OllamaSettings;
}

// ============================================================================ themes

export interface LayoutParams {
  level_spacing: number;
  radial_spread: number;
  show_virtual_anchors: boolean;
  semantic_edges_mode: SemanticEdgesMode;
}

export interface ThemePalette {
  background: string;
  node: string;
  core_pin: string;
  reusable: string;
  edge: string;
  text: string;
  pulse_read: string;
  pulse_reuse: string;
  pulse_write: string;
  pulse_update: string;
  pulse_blocked: string;
  category_colors: Partial<Record<MemoryCategory, string>>;
}

export interface NodeGeometry {
  shape: NodeShape;
  base_size: number;
  scale_by_hits: boolean;
  detail: number;
}

export interface CameraSpec {
  position: Vec3;
  target: Vec3;
  fov: number;
  auto_rotate: boolean;
  auto_rotate_speed: number;
}

export interface ShaderSpec {
  node_vertex: string | null;
  node_fragment: string | null;
  edge_vertex: string | null;
  edge_fragment: string | null;
  background_fragment: string | null;
}

export interface ThemeManifest {
  id: string;
  name: string;
  author: string;
  version: string;
  description: string | null;
  hardware_tier: HardwareTier;
  layout_type: LayoutType;
  layout_params: LayoutParams;
  palette: ThemePalette;
  node_geometry: NodeGeometry;
  camera: CameraSpec;
  shaders: ShaderSpec;
  mesh_path: string | null;
}

export interface RegistryEntry {
  id: string;
  name: string;
  author: string;
  version: string;
  description: string | null;
  size_bytes: number;
  unpacked_size_bytes: number;
  hardware_tier: HardwareTier;
  layout_type: LayoutType;
  preview_url: string;
  download_url: string;
  sha256: string;
}

export interface ThemeCard {
  entry: RegistryEntry;
  compatibility: ThemeCompatibility;
  installed: boolean;
  installed_version: string | null;
}

// ============================================================================ transfer / ingest

export interface IngestRequest {
  paths: string[];
  project_id: Uuid | null;
  watch: boolean;
  mark_reusable: boolean;
  ocr: boolean;
}

export interface IngestProgress {
  job_id: Uuid;
  processed: number;
  total: number;
  current_path: string | null;
  stage: string;
}

export interface IngestIssue {
  path: string;
  message: string;
}

export interface IngestReport {
  documents_created: number;
  documents_updated: number;
  documents_unchanged: number;
  memories_created: number;
  memories_superseded: number;
  skipped_ignored: number;
  redacted_secrets: number;
  total_tokens: number;
  errors: IngestIssue[];
}

export interface PastLifeImportRequest {
  source: PastLifeSource;
  path: string;
  project_id: Uuid | null;
}

export interface PromoteFileRequest {
  path: string;
  project_id: Uuid | null;
  summary: string | null;
}

export interface CapsuleExportRequest {
  project_id: Uuid | null;
  memory_ids: Uuid[];
  dest_path: string;
}

export interface CapsuleManifest {
  format_version: number;
  schema_version: number;
  app_version: string;
  created_at: IsoDateTime;
  project: Project | null;
  memory_count: number;
  source_document_count: number;
  embedding_model_id: string;
  dimensions: number;
  checksums: Record<string, string>;
}

export interface BackupExportRequest {
  dest_path: string;
  password: string | null;
  include_history: boolean;
}

export interface BackupCounts {
  projects: number;
  branches: number;
  source_documents: number;
  memories: number;
  memory_edges: number;
  handoffs: number;
  telemetry_logs: number;
  snapshots: number;
}

export interface BackupManifest {
  format_version: number;
  schema_version: number;
  app_version: string;
  created_at: IsoDateTime;
  source_os: string;
  embedding_model_id: string;
  dimensions: number;
  vector_engine: string;
  encrypted: boolean;
  counts: BackupCounts;
  checksums: Record<string, string>;
  theme_ids: string[];
}

export interface BackupImportRequest {
  path: string;
  password: string | null;
}

export interface ImportReport {
  inserted: number;
  skipped_identical: number;
  superseded: number;
  isolated: number;
  review_branch: string | null;
  reembedded: number;
  projects_created: number;
  warnings: string[];
}

// ============================================================================ connectors / doctor

export interface ConnectorStatus {
  client: AiClient;
  detected: boolean;
  config_path: string | null;
  config_format: ConfigFormat;
  connected: boolean;
  broken: boolean;
  last_backup_path: string | null;
  error: string | null;
}

export interface ConnectorToggleRequest {
  client: AiClient;
  enable: boolean;
}

export interface ConnectorToggleResult {
  status: ConnectorStatus;
  backup_path: string | null;
}

export interface DoctorCheck {
  id: string;
  label_key: string;
  status: CheckStatus;
  detail: string | null;
  fixable: boolean;
}

export interface DoctorReport {
  generated_at: IsoDateTime;
  healthy: boolean;
  checks: DoctorCheck[];
}

// ============================================================================ MCP archive (v1.3.0)

export interface ClientUsage {
  client_name: string;
  uses: number;
  last_used_at: IsoDateTime;
}

/** Who depends on a memory (shown before an agent archives it). */
export interface ArchiveImpact {
  memory_id: Uuid;
  preview: string;
  is_core_pin: boolean;
  is_reusable: boolean;
  hit_count: number;
  reuse_count: number;
  last_accessed_at: IsoDateTime | null;
  other_clients: ClientUsage[];
}

/** Shown before a permanent (irreversible) delete. */
export interface DeletionImpact {
  memory_id: Uuid;
  preview: string;
  is_core_pin: boolean;
  is_reusable: boolean;
  reuse_count: number;
  hit_count: number;
  is_encrypted: boolean;
  used_by: ClientUsage[];
  history_versions: number;
  snapshots_possibly_containing: number;
  /** i18n keys `delete.consequence.*` */
  consequences: string[];
}

// ============================================================================ events

export const EVENTS = {
  mcpActivity: "cobalt://mcp-activity",
  memoryChanged: "cobalt://memory-changed",
  downloadProgress: "cobalt://download-progress",
  engineSwapProgress: "cobalt://engine-swap-progress",
  ingestProgress: "cobalt://ingest-progress",
  readOnlyChanged: "cobalt://read-only-changed",
  vaultStatus: "cobalt://vault-status",
  daemonStatus: "cobalt://daemon-status",
} as const;

export interface ReadOnlyChanged {
  read_only: boolean;
}

export interface ConnectedClient {
  client_name: string;
  transport: McpTransport;
  connected_at: IsoDateTime;
}

export interface DaemonStatus {
  running: boolean;
  started_at: IsoDateTime;
  read_only: boolean;
  http_port: number | null;
  queued_writes: number;
  clients: ConnectedClient[];
}

export interface EventPayloadMap {
  "cobalt://mcp-activity": McpActivity;
  "cobalt://memory-changed": MemoryChanged;
  "cobalt://download-progress": DownloadProgress;
  "cobalt://engine-swap-progress": EngineSwapProgress;
  "cobalt://ingest-progress": IngestProgress;
  "cobalt://read-only-changed": ReadOnlyChanged;
  "cobalt://vault-status": VaultStatus;
  "cobalt://daemon-status": DaemonStatus;
}
export type EventName = keyof EventPayloadMap;

// ============================================================================ IPC

export interface AppInfo {
  name: string;
  version: string;
  os: string;
  arch: string;
  contract_version: string;
  schema_version: number;
  data_dir: string;
}

export interface IdArgs { id: Uuid }
export interface IdsArgs { ids: Uuid[] }
export interface PathArgs { path: string }
export interface ThemeIdArgs { theme_id: string }
export interface ThemeSearchArgs { query: string | null }
export interface CancelDownloadArgs { artifact_id: string }
export interface VaultPasswordArgs { password: string }
export interface PatchMemoryArgs { id: Uuid; patch: MemoryPatch }
export interface SetMemoryEncryptedArgs { id: Uuid; encrypted: boolean }
export interface CreateSnapshotArgs { label: string }
export interface MergeDuplicatesArgs { keep_id: Uuid; merge_ids: Uuid[] }
export interface SetReadOnlyArgs { read_only: boolean }
export interface ListProjectsArgs { include_archived: boolean }
export interface UpdateProjectArgs { id: Uuid; patch: ProjectPatch }
export interface RelinkArgs { source_doc_id: Uuid; new_path: string }
export interface SetWatchedArgs { source_doc_id: Uuid; watched: boolean }
export interface DoctorFixArgs { check_id: string }
export interface RemoveEngineArtifactsArgs { engine: EngineKind | null; model_id: string | null }
export interface QuickNoteArgs { content: string; project_id: Uuid | null }
export interface McpToolDoc {
  name: string;
  default_description: string;
  override_description: string | null;
}

/**
 * Every Tauri command: `invoke(name, { args })` (or no payload when `args` is `void`).
 * The phase in which each command becomes available is documented in `docs/CONTRACTS.md`.
 */
export interface IpcCommandMap {
  // Phase 0/1 — app, hardware, settings, engines, vault
  app_info: { args: void; result: AppInfo };
  get_hardware_profile: { args: void; result: HardwareProfile };
  get_settings: { args: void; result: AppSettings };
  update_settings: { args: AppSettings; result: AppSettings };
  list_embedding_models: { args: void; result: EmbeddingModelSpec[] };
  install_engine: { args: EngineInstallRequest; result: EngineStatus };
  cancel_download: { args: CancelDownloadArgs; result: void };
  get_engine_status: { args: void; result: EngineStatus };
  vault_status: { args: void; result: VaultStatus };
  vault_setup: { args: VaultPasswordArgs; result: VaultStatus };
  vault_unlock: { args: VaultPasswordArgs; result: VaultStatus };
  vault_lock: { args: void; result: VaultStatus };
  // Phase 2 — memories, graph, governance, daemon
  get_graph: { args: GraphQuery; result: GraphData };
  get_memory: { args: IdArgs; result: Memory };
  get_memory_history: { args: IdArgs; result: Memory[] };
  save_memory: { args: NewMemory; result: SaveOutcome };
  update_memory: { args: UpdateMemoryRequest; result: SaveOutcome };
  patch_memory: { args: PatchMemoryArgs; result: Memory };
  delete_memory: { args: IdArgs; result: void };
  set_memory_encrypted: { args: SetMemoryEncryptedArgs; result: Memory };
  reveal_memory: { args: IdArgs; result: string };
  search_memories: { args: SearchRequest; result: SearchResponse };
  list_branches: { args: void; result: Branch[] };
  create_branch: { args: NewBranch; result: Branch };
  switch_branch: { args: IdArgs; result: Branch };
  merge_branch: { args: IdArgs; result: BranchMergeReport };
  discard_branch: { args: IdArgs; result: void };
  list_snapshots: { args: void; result: Snapshot[] };
  create_snapshot: { args: CreateSnapshotArgs; result: Snapshot };
  restore_snapshot: { args: IdArgs; result: Snapshot };
  delete_snapshot: { args: IdArgs; result: void };
  find_duplicates: { args: void; result: DuplicateCluster[] };
  merge_duplicates: { args: MergeDuplicatesArgs; result: Memory };
  archive_memories: { args: IdsArgs; result: number };
  restore_memories: { args: IdsArgs; result: number };
  get_read_only: { args: void; result: boolean };
  set_read_only: { args: SetReadOnlyArgs; result: boolean };
  get_daemon_status: { args: void; result: DaemonStatus };
  replay_activity: { args: IdArgs; result: McpActivity };
  get_source_document: { args: IdArgs; result: SourceDocument };
  get_archive_impact: { args: IdArgs; result: ArchiveImpact };
  get_deletion_impact: { args: IdArgs; result: DeletionImpact };
  verify_source_document: { args: IdArgs; result: FileAvailability };
  // Phase 3 — projects, library, telemetry, connectors, themes, transfer
  list_projects: { args: ListProjectsArgs; result: ProjectStats[] };
  create_project: { args: NewProject; result: Project };
  update_project: { args: UpdateProjectArgs; result: Project };
  list_library: { args: LibraryFilter; result: ReusableAsset[] };
  relink_source_document: { args: RelinkArgs; result: SourceDocument };
  set_watched: { args: SetWatchedArgs; result: SourceDocument };
  promote_file_to_reusable: { args: PromoteFileRequest; result: Memory };
  get_telemetry_summary: { args: TelemetryRange; result: TelemetrySummary };
  query_telemetry: { args: TelemetryQuery; result: Page<TelemetryLog> };
  list_connectors: { args: void; result: ConnectorStatus[] };
  toggle_connector: { args: ConnectorToggleRequest; result: ConnectorToggleResult };
  run_doctor: { args: void; result: DoctorReport };
  doctor_fix: { args: DoctorFixArgs; result: DoctorReport };
  get_mcp_tool_docs: { args: void; result: McpToolDoc[] };
  search_theme_registry: { args: ThemeSearchArgs; result: ThemeCard[] };
  install_theme: { args: ThemeIdArgs; result: InstalledTheme };
  install_theme_file: { args: PathArgs; result: InstalledTheme };
  uninstall_theme: { args: ThemeIdArgs; result: void };
  list_installed_themes: { args: void; result: InstalledTheme[] };
  get_theme_manifest: { args: ThemeIdArgs; result: ThemeManifest };
  ingest_paths: { args: IngestRequest; result: IngestReport };
  /** Cancels a running ingest/import by `IngestProgress.job_id`; `false` if not running. */
  cancel_ingest: { args: IdArgs; result: boolean };
  import_past_life: { args: PastLifeImportRequest; result: IngestReport };
  export_capsule: { args: CapsuleExportRequest; result: CapsuleManifest };
  import_capsule: { args: PathArgs; result: ImportReport };
  export_backup: { args: BackupExportRequest; result: BackupManifest };
  import_backup: { args: BackupImportRequest; result: ImportReport };
  swap_engine: { args: EngineSwapRequest; result: EngineSwapReport };
  remove_engine_artifacts: { args: RemoveEngineArtifactsArgs; result: number };
  build_web_context: { args: WebContextRequest; result: WebContext };
  submit_quick_note: { args: QuickNoteArgs; result: SaveOutcome };
}
export type IpcCommand = keyof IpcCommandMap;

// ============================================================================ frontend-only (3D)

/** Fixed anchor rendered by a layout (tree root, project hub, brain region...). */
export interface VirtualAnchor {
  id: string;
  label: string;
  position: Vec3;
  kind: "root" | "project" | "category" | "region" | "layer";
  color?: string;
}

export interface ProjectContainer {
  id: string;
  /** `null` = the global container. */
  projectId: Uuid | null;
  label: string;
  center: Vec3;
  radius: number;
  vectorCount: number;
  totalTokens: number;
  color: string;
}

export interface LayoutResult {
  nodePositions: Record<string, Vec3>;
  virtualAnchors?: VirtualAnchor[];
  structuralEdges?: Array<[string, string]>;
  projectContainers?: ProjectContainer[];
}

/** Pure layout function: same input => same output (no physics state between calls). */
export type LayoutFn = (input: {
  nodes: GraphNode[];
  edges: MemoryEdge[];
  projects: ProjectStats[];
  params: LayoutParams;
  sizeMetric: ClusterSizeMetric;
}) => LayoutResult;

/** Visual-only filter state of the Filter Dock (never affects MCP queries). */
export interface VisualFilters {
  sourceTypes: SourceType[];
  projectIds: Array<Uuid | null>;
  categories: MemoryCategory[];
  statuses: MemoryStatus[];
  onlyReusable: boolean;
  /** "Solo" isolation of a single chip, if any. */
  solo: { dimension: "source_type" | "project" | "category" | "status"; value: string } | null;
}

/** Pulse colors per operation (synaptic mode). */
export const OPERATION_COLORS: Record<TelemetryOperation, string> = {
  read: "#0047AB",
  reuse: "#8B5CF6",
  write: "#10B981",
  update: "#F59E0B",
  handoff: "#38BDF8",
  blocked_firewall: "#EF4444",
};
