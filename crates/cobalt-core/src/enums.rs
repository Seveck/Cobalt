//! String-backed enums shared by SQL columns, IPC payloads, MCP arguments and TypeScript.
//!
//! Every enum serializes to the exact `snake_case` literal used in SQL `CHECK` constraints
//! and in `src/types/contracts.ts`. Use `as_str()` / `FromStr` for SQL mapping.

use std::path::Path;

use crate::error::CobaltError;

macro_rules! string_enum {
    (
        $(#[$meta:meta])*
        pub enum $name:ident {
            $( $(#[$vmeta:meta])* $variant:ident => $lit:literal ),+ $(,)?
        }
    ) => {
        $(#[$meta])*
        #[derive(
            Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord,
            serde::Serialize, serde::Deserialize,
        )]
        pub enum $name {
            $( $(#[$vmeta])* #[serde(rename = $lit)] $variant ),+
        }

        impl $name {
            /// Every variant, in declaration order.
            pub const ALL: &'static [$name] = &[ $( $name::$variant ),+ ];

            /// Exact wire / SQL literal.
            pub const fn as_str(self) -> &'static str {
                match self { $( $name::$variant => $lit ),+ }
            }
        }

        impl ::std::fmt::Display for $name {
            fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
                f.write_str(self.as_str())
            }
        }

        impl ::std::str::FromStr for $name {
            type Err = CobaltError;
            fn from_str(s: &str) -> Result<Self, Self::Err> {
                match s {
                    $( $lit => Ok($name::$variant), )+
                    other => Err(CobaltError::InvalidInput(format!(
                        concat!("invalid ", stringify!($name), " value: '{}'"), other
                    ))),
                }
            }
        }
    };
}

string_enum! {
    /// Kind of source a memory or document comes from (`source_documents.source_type`,
    /// `memories.source_type`).
    #[derive(Default)]
    pub enum SourceType {
        Md => "md", Sql => "sql", Bash => "bash", Rs => "rs", Ts => "ts", Js => "js",
        Py => "py", Java => "java", Json => "json", Yaml => "yaml", Toml => "toml",
        Html => "html", Css => "css", Dockerfile => "dockerfile", Pdf => "pdf",
        Image => "image", #[default] Note => "note", Other => "other",
    }
}

impl SourceType {
    /// Infers the source type from a file extension (case-insensitive, without the dot).
    pub fn from_extension(ext: &str) -> Self {
        match ext.to_ascii_lowercase().as_str() {
            "md" | "markdown" | "mdx" | "mdc" => Self::Md,
            "sql" => Self::Sql,
            "sh" | "bash" | "zsh" | "fish" => Self::Bash,
            "rs" => Self::Rs,
            "ts" | "tsx" | "mts" | "cts" => Self::Ts,
            "js" | "jsx" | "mjs" | "cjs" => Self::Js,
            "py" | "pyi" => Self::Py,
            "java" => Self::Java,
            "json" | "jsonc" | "json5" => Self::Json,
            "yaml" | "yml" => Self::Yaml,
            "toml" => Self::Toml,
            "html" | "htm" => Self::Html,
            "css" | "scss" | "sass" | "less" => Self::Css,
            "dockerfile" | "containerfile" => Self::Dockerfile,
            "pdf" => Self::Pdf,
            "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp" | "tif" | "tiff" => Self::Image,
            "txt" => Self::Note,
            _ => Self::Other,
        }
    }

    /// Infers the source type from a path (extension first, then well-known file names).
    pub fn from_path(path: &Path) -> Self {
        let file_name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if file_name == "dockerfile"
            || file_name == "containerfile"
            || file_name.starts_with("dockerfile.")
        {
            return Self::Dockerfile;
        }
        if file_name == ".cursorrules"
            || file_name == ".windsurfrules"
            || file_name == ".clinerules"
        {
            return Self::Md;
        }
        match path.extension().and_then(|e| e.to_str()) {
            Some(ext) => Self::from_extension(ext),
            None => Self::Other,
        }
    }
}

string_enum! {
    /// `memories.category`.
    pub enum MemoryCategory {
        Preference => "preference", Decision => "decision", Code => "code",
        Doc => "doc", Note => "note", Ocr => "ocr",
    }
}

string_enum! {
    /// `memories.status`.
    pub enum MemoryStatus { Active => "active", Superseded => "superseded", Archived => "archived" }
}

string_enum! {
    /// `memory_edges.edge_type`.
    pub enum EdgeType { Semantic => "semantic", Supersedes => "supersedes", SameProject => "same_project" }
}

string_enum! {
    /// `telemetry_logs.operation` (also drives synaptic pulse colors in the 3D view).
    pub enum TelemetryOperation {
        Read => "read", Write => "write", Update => "update", Reuse => "reuse",
        Handoff => "handoff", BlockedFirewall => "blocked_firewall",
    }
}

string_enum! {
    /// Adaptive hardware profile.
    pub enum HardwareTier { Eco => "eco", Balanced => "balanced", Ultra => "ultra" }
}

string_enum! {
    /// Vector engine behind the `VectorStore` trait. SQLite (WAL + FTS5) is always the
    /// canonical store regardless of this choice.
    pub enum EngineKind {
        /// Bundled `sqlite-vec` (`vec_memories` table). Eco profile.
        SqliteVec => "sqlite_vec",
        /// Bundled USearch HNSW index memory-mapped from disk. Balanced profile.
        Usearch => "usearch",
        /// Official Qdrant binary downloaded on demand and run as a local sidecar. Ultra profile.
        QdrantSidecar => "qdrant_sidecar",
        /// External LanceDB connector (Pro mode).
        LanceDb => "lance_db",
        /// Remote Qdrant connector (Pro mode).
        QdrantRemote => "qdrant_remote",
        /// External ChromaDB connector (Pro mode).
        ChromaDb => "chroma_db",
    }
}

string_enum! {
    /// Embedding backend.
    pub enum EmbeddingProvider { Fastembed => "fastembed", Ollama => "ollama" }
}

string_enum! {
    /// Weight precision of an ONNX embedding model.
    pub enum Quantization { Int8 => "int8", Fp16 => "fp16", Fp32 => "fp32" }
}

string_enum! {
    /// Sentence-embedding pooling over the ONNX `last_hidden_state`.
    pub enum Pooling { Mean => "mean", Cls => "cls" }
}

string_enum! {
    /// BPE encoding used by `tiktoken-rs`.
    pub enum TokenEncoding { Cl100kBase => "cl100k_base", O200kBase => "o200k_base" }
}

string_enum! {
    /// UI language.
    pub enum Language { Es => "es", En => "en" }
}

impl Language {
    /// Maps a BCP-47 / POSIX locale (`es-CO`, `es_ES.UTF-8`, `en-US`, `fr`) to a supported
    /// language: Spanish for any `es*`, English otherwise.
    pub fn from_locale(locale: &str) -> Self {
        if locale.trim().to_ascii_lowercase().starts_with("es") {
            Self::Es
        } else {
            Self::En
        }
    }

    /// Language of the operating system (English when unknown or unsupported).
    pub fn detect_system() -> Self {
        sys_locale::get_locale().map_or(Self::En, |l| Self::from_locale(&l))
    }
}

string_enum! {
    /// On-disk state of a reusable asset's source file.
    pub enum FileAvailability {
        /// File exists and its SHA-256 matches `source_documents.file_hash`.
        Available => "available",
        /// File exists but its hash changed since indexing.
        Modified => "modified",
        /// File is gone but `memories.reusable_snippet` is available.
        SnippetOnly => "snippet_only",
        /// Neither the file nor a snippet is available.
        Missing => "missing",
    }
}

string_enum! {
    /// 3D layout identifiers (theme manifests and the visualizer).
    pub enum LayoutType {
        Galaxy => "galaxy", Brain => "brain", NeuralNet => "neural_net",
        KnowledgeTree => "knowledge_tree", ProjectClusters => "project_clusters",
        /// Each project as a separate flat "island" laid out on a grid, labelled above.
        ProjectIslands => "project_islands",
        CustomMesh => "custom_mesh",
    }
}

string_enum! {
    /// What a write operation ended up doing (Check-Before-Write result).
    pub enum WriteAction {
        /// A new memory row was created.
        Inserted => "inserted",
        /// A near-identical memory was updated in place (same meaning, refreshed metadata).
        UpdatedExisting => "updated_existing",
        /// A new version was created and the previous one marked `superseded`.
        Superseded => "superseded",
        /// Exact duplicate (same `content_hash`); nothing written.
        Duplicate => "duplicate",
    }
}

string_enum! {
    /// AI clients supported by the 1-Click connector.
    pub enum AiClient {
        ClaudeDesktop => "claude_desktop", ClaudeCode => "claude_code", Cursor => "cursor",
        Windsurf => "windsurf", Cline => "cline", GeminiCli => "gemini_cli", CodexCli => "codex_cli",
    }
}

string_enum! {
    /// `wgpu` adapter device type.
    pub enum GpuDeviceType {
        DiscreteGpu => "discrete_gpu", IntegratedGpu => "integrated_gpu",
        VirtualGpu => "virtual_gpu", Cpu => "cpu", Other => "other",
    }
}

string_enum! {
    /// `wgpu` graphics backend.
    pub enum GpuBackend {
        Vulkan => "vulkan", Metal => "metal", Dx12 => "dx12", Gl => "gl",
        BrowserWebGpu => "browser_webgpu", Other => "other",
    }
}

string_enum! {
    /// Phase of a verified download handled by the `EngineManager`.
    pub enum DownloadPhase {
        Queued => "queued", Downloading => "downloading", Verifying => "verifying",
        Extracting => "extracting", Retrying => "retrying", Completed => "completed",
        Failed => "failed", Cancelled => "cancelled",
    }
}

string_enum! {
    /// Lifecycle state of an engine or model artifact.
    pub enum EngineState {
        NotInstalled => "not_installed", Downloading => "downloading", Installed => "installed",
        Running => "running", Stopped => "stopped", Error => "error",
    }
}

string_enum! {
    /// Phase of the 1-Click atomic engine/model migration.
    pub enum EngineSwapPhase {
        QueueingWrites => "queueing_writes", Staging => "staging", Reindexing => "reindexing",
        Verifying => "verifying", Swapping => "swapping", Draining => "draining",
        Completed => "completed", RollingBack => "rolling_back", RolledBack => "rolled_back",
        Failed => "failed",
    }
}

string_enum! {
    /// Result level of an MCP Doctor check.
    pub enum CheckStatus { Ok => "ok", Warning => "warning", Error => "error", Skipped => "skipped" }
}

string_enum! {
    /// Compatibility of a theme with the detected hardware tier.
    pub enum ThemeCompatibility { Compatible => "compatible", Degraded => "degraded", Incompatible => "incompatible" }
}

string_enum! {
    /// Supported "Past Life" import sources.
    pub enum PastLifeSource {
        ChatgptExport => "chatgpt_export", ClaudeExport => "claude_export",
        CursorRules => "cursor_rules", ClaudeMd => "claude_md", MarkdownFolder => "markdown_folder",
    }
}

string_enum! {
    /// Kind of change broadcast through `cobalt://memory-changed`.
    pub enum MemoryChangeKind {
        Created => "created", Updated => "updated", Superseded => "superseded",
        Archived => "archived", Deleted => "deleted", Restored => "restored",
    }
}

string_enum! {
    /// Kind of cluster found by "Clean Brain".
    pub enum DuplicateKind { Duplicate => "duplicate", Conflict => "conflict" }
}

string_enum! {
    /// How semantic edges are drawn by a layout.
    pub enum SemanticEdgesMode { Always => "always", HoverOnly => "hover_only", Never => "never" }
}

string_enum! {
    /// Size metric for `project_clusters` containers.
    pub enum ClusterSizeMetric { Vectors => "vectors", Tokens => "tokens" }
}

string_enum! {
    /// Base node geometry of a theme.
    pub enum NodeShape {
        Sphere => "sphere", Icosahedron => "icosahedron", Octahedron => "octahedron",
        Box => "box", Point => "point", Mesh => "mesh",
    }
}

string_enum! {
    /// On-disk format of an AI client's MCP configuration.
    pub enum ConfigFormat { Json => "json", Toml => "toml" }
}

string_enum! {
    /// MCP transport used by a client session.
    pub enum McpTransport { Stdio => "stdio", StreamableHttp => "streamable_http", Sse => "sse" }
}

string_enum! {
    /// What happened in a CLI session (`cobalt://cli-activity`).
    pub enum CliActivityKind {
        SessionStart => "session_start", FileEdit => "file_edit", Command => "command",
        TurnEnd => "turn_end", SessionEnd => "session_end", GitCommit => "git_commit",
    }
}

string_enum! {
    /// Automatic capture integrations installed by Cobalt (no AI cooperation needed).
    pub enum CaptureIntegration {
        /// Short rule block in the client's global instructions file.
        GlobalInstructions => "global_instructions",
        /// Client hooks (Claude Code hooks, Codex `notify`) calling `cobalt --hook`.
        SessionHooks => "session_hooks",
        /// `post-commit` hook in a project's git repository.
        GitHooks => "git_hooks",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    #[test]
    fn literals_roundtrip_through_serde_and_fromstr() {
        for v in SourceType::ALL {
            let json = serde_json::to_string(v).unwrap();
            assert_eq!(json, format!("\"{}\"", v.as_str()));
            assert_eq!(SourceType::from_str(v.as_str()).unwrap(), *v);
        }
        for v in TelemetryOperation::ALL {
            assert_eq!(TelemetryOperation::from_str(v.as_str()).unwrap(), *v);
        }
        assert!(MemoryStatus::from_str("nope").is_err());
    }

    #[test]
    fn maps_locales_to_supported_languages() {
        for (loc, lang) in [
            ("es-CO", Language::Es),
            ("es_ES.UTF-8", Language::Es),
            ("ES", Language::Es),
            ("en-US", Language::En),
            ("fr-FR", Language::En),
            ("pt_BR", Language::En),
            ("", Language::En),
        ] {
            assert_eq!(Language::from_locale(loc), lang, "{loc}");
        }
    }

    #[test]
    fn infers_source_type_from_paths() {
        let cases = [
            ("src/main.rs", SourceType::Rs),
            ("web/App.TSX", SourceType::Ts),
            ("db/schema.sql", SourceType::Sql),
            ("scripts/deploy.sh", SourceType::Bash),
            ("Dockerfile", SourceType::Dockerfile),
            ("docker/Dockerfile.prod", SourceType::Dockerfile),
            ("CLAUDE.md", SourceType::Md),
            (".cursorrules", SourceType::Md),
            ("docs/paper.pdf", SourceType::Pdf),
            ("shot.png", SourceType::Image),
            ("config.yml", SourceType::Yaml),
            ("Makefile", SourceType::Other),
            ("notes.txt", SourceType::Note),
        ];
        for (path, expected) in cases {
            assert_eq!(SourceType::from_path(Path::new(path)), expected, "{path}");
        }
    }
}
