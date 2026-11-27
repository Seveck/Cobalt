import { detectOsLanguage } from "@/i18n";
import {
  BUILTIN_THEME_ID,
  DEFAULT_ENGINE_BY_TIER,
  DEFAULT_MODEL_BY_TIER,
  type AiClient,
  type AppSettings,
  type EngineKind,
  type EngineState,
  type EngineStatus,
  type EmbeddingModelSpec,
  type HardwareProfile,
} from "@/types/contracts";

/** Canonical human-readable display names for supported AI clients. */
export const AI_CLIENT_LABELS: Record<AiClient, string> = {
  claude_desktop: "Claude Desktop",
  claude_code: "Claude Code",
  cursor: "Cursor",
  windsurf: "Windsurf",
  cline: "Cline",
  gemini_cli: "Gemini CLI",
  codex_cli: "Codex CLI",
};

/** Common aliases reported by MCP clients beyond the canonical `AiClient` enum. */
const AI_CLIENT_ALIASES: Record<string, string> = {
  codex: "Codex",
  gemini: "Gemini CLI",
  claude: "Claude",
  antigravity: "Antigravity",
  opencode: "OpenCode",
  vscode: "VS Code",
  vs_code: "VS Code",
  roo_code: "Roo Code",
  zed: "Zed",
  cobalt: "Cobalt",
  cobalt_ui: "Cobalt",
};

/** Resolve an AI client identifier (e.g. `claude_code` or `claude-code`) to its display name. */
export function formatAiClientName(client: string): string {
  const normalized = client.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (normalized in AI_CLIENT_LABELS) {
    return AI_CLIENT_LABELS[normalized as AiClient];
  }
  if (normalized in AI_CLIENT_ALIASES) {
    return AI_CLIENT_ALIASES[normalized]!;
  }
  return client;
}

/**
 * Format an integer compactly for tight labels and tooltips (e.g. `840`, `5.2k`, `1.4M`).
 */
export function formatCompactNumber(value: number): string {
  const safe = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  if (safe < 1_000) return String(safe);
  if (safe < 1_000_000) {
    const k = safe / 1_000;
    const rounded = k >= 100 ? Math.round(k) : Math.round(k * 10) / 10;
    return Number.isInteger(rounded) ? `${rounded}k` : `${rounded.toFixed(1)}k`;
  }
  const m = safe / 1_000_000;
  const rounded = m >= 100 ? Math.round(m) : Math.round(m * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}M` : `${rounded.toFixed(1)}M`;
}

/** Format a byte count into a human-readable size string (e.g. `118.4 MB`). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  let value = bytes;
  let unitIdx = 0;
  while (value >= 1024 && unitIdx < units.length - 1) {
    value /= 1024;
    unitIdx += 1;
  }
  const decimals = unitIdx === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2;
  const unit = units[unitIdx] ?? "B";
  return `${value.toFixed(decimals)} ${unit}`;
}

/** Format total RAM bytes into clean gigabytes (e.g. `16`, `7.6`). */
export function formatRamGb(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  if (!Number.isFinite(gb) || gb <= 0) return "0";
  const rounded = Math.round(gb * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** Compute clamped download completion percentage (0..100). */
export function formatPercent(downloaded: number, total: number | null): number {
  if (total === null || total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((downloaded / total) * 100)));
}

/** Approximate extra binary size for engines that ship a sidecar executable. */
export const ENGINE_SIDECAR_BYTES: Record<EngineKind, number> = {
  sqlite_vec: 0,
  usearch: 0,
  qdrant_sidecar: 68_157_440, // ~65 MB
  lance_db: 0,
  qdrant_remote: 0,
  chroma_db: 0,
};

/** Returns `true` when an `EngineState` represents a locally installed artifact. */
export function isEngineStateInstalled(state: EngineState): boolean {
  return state === "installed" || state === "running" || state === "stopped";
}

/**
 * Returns `true` when the selected engine + embedding model pair is already
 * installed locally (either confirmed by `get_engine_status` or indicated by
 * a zero-byte backend `recommendation.download_bytes`).
 */
export function isEngineModelInstalled(
  engine: EngineKind,
  modelId: string,
  engineStatus: EngineStatus | null,
  profile: HardwareProfile | null,
): boolean {
  if (
    engineStatus &&
    engineStatus.engine === engine &&
    engineStatus.model_id === modelId &&
    isEngineStateInstalled(engineStatus.engine_state) &&
    isEngineStateInstalled(engineStatus.model_state)
  ) {
    return true;
  }
  if (
    profile &&
    profile.recommendation.engine === engine &&
    profile.recommendation.model_id === modelId &&
    profile.recommendation.download_bytes === 0
  ) {
    return true;
  }
  return false;
}

/**
 * Compute exact download size for a given engine + model choice.
 * Returns `0` when the engine + model is already installed locally.
 * When the choice matches the backend's `HardwareProfile.recommendation`,
 * prefer the backend's exact `recommendation.download_bytes`.
 */
export function estimateDownloadBytes(
  engine: EngineKind,
  modelId: string,
  models: readonly EmbeddingModelSpec[],
  profile: HardwareProfile | null,
  engineStatus?: EngineStatus | null,
): number {
  if (isEngineModelInstalled(engine, modelId, engineStatus ?? null, profile)) {
    return 0;
  }
  if (
    profile &&
    profile.recommendation.engine === engine &&
    profile.recommendation.model_id === modelId
  ) {
    return profile.recommendation.download_bytes;
  }
  const model = models.find((m) => m.id === modelId);
  const modelBytes = model ? model.size_bytes : 0;
  return modelBytes + ENGINE_SIDECAR_BYTES[engine];
}

/** Exact TypeScript mirror of Rust `AppSettings::default()`. */
export function createDefaultSettings(): AppSettings {
  return {
    onboarding_completed: false,
    user_display_name: null,
    hardware_tier: "eco",
    vector_engine: DEFAULT_ENGINE_BY_TIER.eco,
    embedding_model_id: DEFAULT_MODEL_BY_TIER.eco,
    token_encoding: "cl100k_base",
    language: detectOsLanguage(),
    active_theme_id: BUILTIN_THEME_ID,
    read_only: false,
    pro_mode: false,
    search: {
      top_k: 8,
      min_similarity: 0.3,
      dedup_threshold: 0.85,
      duplicate_threshold: 0.9,
      import_collision_threshold: 0.92,
      semantic_edge_threshold: 0.75,
      rrf: {
        k: 60,
        vector_weight: 1.0,
        fts_weight: 1.0,
      },
      confidence_weight: 0.15,
      core_pin_boost: 0.5,
    },
    chunking: {
      max_chunk_tokens: 400,
      overlap_tokens: 40,
    },
    decay: {
      enabled: true,
      inactive_days: 60,
      decay_rate: 0.5,
      archive_threshold: 0.2,
    },
    retention: {
      detailed_log_limit: 5000,
      detailed_log_days: 90,
    },
    firewall: {
      max_tokens_per_memory: 800,
      max_writes_per_minute: 30,
      max_reads_per_minute: 120,
      repeated_write_window_secs: 60,
      notify_on_block: true,
    },
    vault: {
      auto_lock_minutes: 10,
    },
    shortcuts: {
      quick_note: "Alt+Space",
      toggle_read_only: "CommandOrControl+Shift+M",
    },
    mcp: {
      http_enabled: true,
      http_port: 7437,
      rest_enabled: true,
      handoff_ttl_hours: 48,
      tool_docstring_overrides: {},
    },
    ollama: {
      base_url: "http://127.0.0.1:11434",
    },
    capture: {
      auto_watch_projects: true,
      session_handoffs: true,
      git_commits: true,
      indexing_paused: false,
      ocr_model_id: "paddleocr-latin",
      session_context: true,
    },
  };
}

/** Normalize a filesystem path for cross-platform comparison (forward slashes, no trailing slash). */
export function normalizeFilePath(raw: string): string {
  let path = raw.trim().replace(/\\/g, "/");
  path = path.replace(/\/+/g, "/");
  if (path.length > 1 && path.endsWith("/")) {
    path = path.slice(0, -1);
  }
  if (/^[A-Z]:\//.test(path)) {
    path = `${path[0]!.toLowerCase()}${path.slice(1)}`;
  }
  return path;
}

/**
 * Format a file path compactly for live activity feeds (e.g. `src/api.ts`).
 * Strips `cwd` or `projectRoot` prefix when present; otherwise shows up to the last 2 segments.
 */
export function formatShortFilePath(
  filePath: string,
  cwd?: string | null,
  projectRoot?: string | null,
): string {
  const norm = normalizeFilePath(filePath);
  for (const base of [projectRoot, cwd]) {
    if (!base) continue;
    const normBase = normalizeFilePath(base);
    if (norm.startsWith(`${normBase}/`)) {
      return norm.slice(normBase.length + 1);
    }
  }
  const parts = norm.split("/").filter(Boolean);
  if (parts.length <= 2) return norm;
  return parts.slice(-2).join("/");
}

/** Extract the final folder/file name from a path. */
export function pathBasename(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const norm = normalizeFilePath(raw);
  const parts = norm.split("/").filter(Boolean);
  return parts.length > 0 ? (parts[parts.length - 1] ?? null) : null;
}

/** Returns true when a stored `SourceDocument.file_path` matches a touched CLI file path. */
export function sourcePathMatchesTouched(
  sourceDocPath: string,
  touchedPath: string,
  cwd?: string | null,
): boolean {
  const normDoc = normalizeFilePath(sourceDocPath);
  const normTouched = normalizeFilePath(touchedPath);
  if (!normDoc || !normTouched) return false;

  const candidates = [normTouched];
  const isAbs = normTouched.startsWith("/") || /^[a-z]:\//.test(normTouched);
  if (!isAbs && cwd) {
    const cleanRel = normTouched.replace(/^\.\//, "");
    candidates.push(normalizeFilePath(`${cwd}/${cleanRel}`));
  }

  for (const candidate of candidates) {
    const clean = candidate.replace(/^\.\//, "");
    if (normDoc === clean) return true;
    if (normDoc.endsWith(`/${clean}`) || clean.endsWith(`/${normDoc}`)) return true;
  }
  return false;
}

/** Extract the user's first name for calm greetings (returns `null` when blank). */
export function extractFirstName(fullName: string | null | undefined): string | null {
  if (!fullName) return null;
  const trimmed = fullName.trim();
  if (!trimmed) return null;
  const first = trimmed.split(/\s+/)[0];
  return first && first.length > 0 ? first : null;
}

export type DayPeriod = "morning" | "afternoon" | "evening";

/** Classify a local hour (0..23) into morning / afternoon / evening. */
export function getDayPeriod(date: Date = new Date()): DayPeriod {
  const hour = date.getHours();
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 20) return "afternoon";
  return "evening";
}

/** Format an integer token count with locale separators. */
export function formatTokenCount(count: number, language?: string): string {
  const safe = Number.isFinite(count) ? Math.max(0, Math.round(count)) : 0;
  try {
    return safe.toLocaleString(language === "es" ? "es-ES" : "en-US");
  } catch {
    return String(safe);
  }
}
