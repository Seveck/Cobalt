//! `.memoryignore`: `.gitignore`-style rules honored by MCP writes, ingestion and the live
//! file watcher. Sources, in increasing precedence:
//! 1. built-in defaults (VCS/build folders, lockfiles, keys, env files, databases);
//! 2. the global `~/.cobalt/.memoryignore`;
//! 3. `<root>/.memoryignore` of the project.
//!
//! Later rules override earlier ones, so a project can re-include a default with `!pattern`.

use std::path::{Path, PathBuf};

use ignore::gitignore::{Gitignore, GitignoreBuilder};

use crate::error::{CobaltError, Result};
use crate::paths::MEMORY_IGNORE_FILE;

/// Built-in rules applied to every root.
pub const DEFAULT_IGNORES: &[&str] = &[
    ".git/",
    ".hg/",
    ".svn/",
    "node_modules/",
    "target/",
    "dist/",
    "build/",
    ".next/",
    ".venv/",
    "venv/",
    "__pycache__/",
    ".cobalt/",
    ".agent-logs/",
    ".idea/",
    ".DS_Store",
    "*.db",
    "*.db-*",
    "*.sqlite",
    "*.sqlite-*",
    ".env",
    ".env.*",
    "!.env.example",
    "*.pem",
    "*.key",
    "*.p12",
    "*.pfx",
    "*.keystore",
    "id_rsa*",
    "id_ed25519*",
    "id_ecdsa*",
    ".npmrc",
    ".pypirc",
    "*.lock",
    "pnpm-lock.yaml",
    "package-lock.json",
    "*.min.js",
    "*.map",
    // Caches, build outputs and dependency trees of common ecosystems.
    "site-packages/",
    ".cache/",
    "coverage/",
    ".turbo/",
    ".parcel-cache/",
    ".svelte-kit/",
    ".nuxt/",
    ".gradle/",
    ".pytest_cache/",
    ".mypy_cache/",
    ".tox/",
    "*.pyc",
    // Databases, binaries, model weights, archives and media (never useful as memories).
    "*.sqlite3",
    "*.so",
    "*.dll",
    "*.dylib",
    "*.exe",
    "*.bin",
    "*.pack",
    "*.onnx",
    "*.pt",
    "*.pth",
    "*.safetensors",
    "*.parquet",
    "*.zip",
    "*.tar",
    "*.gz",
    "*.7z",
    "*.rar",
    "*.iso",
    "*.mp4",
    "*.mov",
    "*.mkv",
    "*.mp3",
    "*.wav",
];

/// Compiled matcher for one root directory.
#[derive(Debug, Clone)]
pub struct MemoryIgnore {
    root: PathBuf,
    matcher: Gitignore,
}

impl MemoryIgnore {
    /// Builds the matcher for `root`, loading the global file from `global_dir` (usually the
    /// Cobalt home) when given.
    pub fn for_root(root: &Path, global_dir: Option<&Path>) -> Result<Self> {
        let mut builder = GitignoreBuilder::new(root);
        for line in DEFAULT_IGNORES {
            builder
                .add_line(None, line)
                .map_err(|e| CobaltError::Internal(format!("default ignore rule '{line}': {e}")))?;
        }
        let mut files = Vec::new();
        if let Some(dir) = global_dir {
            files.push(dir.join(MEMORY_IGNORE_FILE));
        }
        files.push(root.join(MEMORY_IGNORE_FILE));
        for file in files.into_iter().filter(|f| f.is_file()) {
            if let Some(err) = builder.add(&file) {
                return Err(CobaltError::InvalidInput(format!(
                    "invalid {}: {err}",
                    file.display()
                )));
            }
        }
        let matcher = builder
            .build()
            .map_err(|e| CobaltError::InvalidInput(format!("memoryignore: {e}")))?;
        Ok(Self {
            root: root.to_path_buf(),
            matcher,
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// `true` if `path` (absolute, or relative to the root) or any of its parents is ignored.
    /// Paths outside the root are never ignored by this matcher.
    pub fn is_ignored(&self, path: &Path, is_dir: bool) -> bool {
        let full = if path.is_absolute() {
            path.to_path_buf()
        } else {
            self.root.join(path)
        };
        if !full.starts_with(&self.root) {
            return false;
        }
        self.matcher
            .matched_path_or_any_parents(&full, is_dir)
            .is_ignore()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_and_project_rules() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(
            root.join(MEMORY_IGNORE_FILE),
            "secrets/\n*.log\n!keep.log\n!Cargo.lock\n",
        )
        .unwrap();
        let mi = MemoryIgnore::for_root(root, None).unwrap();

        assert!(mi.is_ignored(&root.join("node_modules/react/index.js"), false));
        assert!(mi.is_ignored(&root.join("target"), true));
        assert!(mi.is_ignored(&root.join(".env"), false));
        assert!(mi.is_ignored(&root.join("config/.env.production"), false));
        assert!(!mi.is_ignored(&root.join(".env.example"), false));
        assert!(mi.is_ignored(&root.join("certs/server.pem"), false));
        assert!(mi.is_ignored(Path::new("secrets/token.txt"), false));
        assert!(mi.is_ignored(Path::new("logs/app.log"), false));
        assert!(!mi.is_ignored(Path::new("logs/keep.log"), false));
        assert!(!mi.is_ignored(Path::new("Cargo.lock"), false));
        assert!(mi.is_ignored(Path::new("yarn.lock"), false));
        assert!(!mi.is_ignored(&root.join("src/main.rs"), false));
        assert!(mi.is_ignored(&root.join(".rag/db/chroma.sqlite3"), false));
        assert!(mi.is_ignored(&root.join("venv/lib/python3/site-packages/x.py"), false));
        assert!(mi.is_ignored(&root.join("lib/libtorch.so"), false));
        assert!(!mi.is_ignored(&root.join("docs/manual.pdf"), false));
        assert!(!mi.is_ignored(&root.join("shots/board.png"), false));
        assert!(!mi.is_ignored(Path::new("/elsewhere/.env"), false));
    }

    #[test]
    fn global_file_is_applied_and_project_overrides_it() {
        let home = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        std::fs::write(home.path().join(MEMORY_IGNORE_FILE), "*.csv\ndrafts/\n").unwrap();
        std::fs::write(project.path().join(MEMORY_IGNORE_FILE), "!data.csv\n").unwrap();
        let mi = MemoryIgnore::for_root(project.path(), Some(home.path())).unwrap();
        assert!(mi.is_ignored(Path::new("export.csv"), false));
        assert!(!mi.is_ignored(Path::new("data.csv"), false));
        assert!(mi.is_ignored(Path::new("drafts/idea.md"), false));
    }
}
