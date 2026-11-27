//! Project auto-resolution for MCP calls (see `docs/MCP_SPEC.md` §1).
//!
//! Order: explicit `project` argument (`global`, existing name, or absolute path) → MCP roots
//! reported by the client → working directory of the stdio bridge → global only.

use std::path::Path;

use cobalt_core::enums::McpTransport;
use cobalt_core::error::Result;
use cobalt_core::mcp::{ResolvedProject, UNKNOWN_CLIENT};
use cobalt_core::model::{NewProject, Project};
use cobalt_core::search::ProjectScope;

use crate::daemon::Daemon;

/// Who is calling and from where.
#[derive(Debug, Clone)]
pub struct ClientContext {
    pub client_name: String,
    pub transport: McpTransport,
    /// Working directory of the `--mcp-stdio` bridge process, if known.
    pub cwd: Option<String>,
    /// Filesystem roots reported by the client (`roots/list`), as paths.
    pub roots: Vec<String>,
    /// Memories already sent to this client in this session (search answers do not repeat them).
    pub sent: std::sync::Arc<std::sync::Mutex<std::collections::HashSet<cobalt_core::Id>>>,
}

impl ClientContext {
    pub fn new(transport: McpTransport) -> Self {
        Self {
            client_name: UNKNOWN_CLIENT.to_owned(),
            transport,
            cwd: None,
            roots: Vec::new(),
            sent: std::sync::Arc::default(),
        }
    }
}

/// Outcome of resolution.
#[derive(Debug, Clone)]
pub enum Resolved {
    Global,
    Project { project: Project, created: bool },
}

impl Resolved {
    pub fn project_id(&self) -> Option<cobalt_core::Id> {
        match self {
            Self::Global => None,
            Self::Project { project, .. } => Some(project.id),
        }
    }

    /// Search scope: the project plus global, or global only.
    pub fn scope(&self) -> ProjectScope {
        match self {
            Self::Global => ProjectScope::Global,
            Self::Project { project, .. } => ProjectScope::ProjectAndGlobal(project.id),
        }
    }

    pub fn root_path(&self) -> Option<&str> {
        match self {
            Self::Global => None,
            Self::Project { project, .. } => project.root_path.as_deref(),
        }
    }

    pub fn to_output(&self) -> Option<ResolvedProject> {
        match self {
            Self::Global => None,
            Self::Project { project, created } => Some(ResolvedProject {
                id: project.id,
                name: project.name.clone(),
                root_path: project.root_path.clone(),
                created: *created,
            }),
        }
    }
}

/// Converts a `file://` URI (MCP roots) into a plain path.
pub fn uri_to_path(uri: &str) -> Option<String> {
    let rest = uri.strip_prefix("file://")?;
    let rest = rest.strip_prefix("localhost").unwrap_or(rest);
    let decoded = percent_decode(rest);
    // Windows: file:///C:/x -> C:/x
    let trimmed =
        if decoded.len() > 2 && decoded.as_bytes()[0] == b'/' && decoded.as_bytes()[2] == b':' {
            decoded[1..].to_owned()
        } else {
            decoded
        };
    Some(trimmed)
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16)
        {
            out.push(v);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// For a path inside a linked git worktree (`git worktree add`), the same path inside the
/// main checkout. `None` for main checkouts, submodules and paths outside git.
pub fn main_checkout_path(path: &Path) -> Option<std::path::PathBuf> {
    let worktree = path.ancestors().find(|dir| dir.join(".git").exists())?;
    let dot_git = std::fs::read_to_string(worktree.join(".git")).ok()?; // a dir fails here
    let gitdir = Path::new(dot_git.trim().strip_prefix("gitdir:")?.trim());
    let gitdir = worktree.join(gitdir); // relative gitdirs are relative to the worktree
    // Only linked worktrees have `commondir` (submodules do not).
    let common = std::fs::read_to_string(gitdir.join("commondir")).ok()?;
    let common = std::fs::canonicalize(gitdir.join(common.trim())).ok()?;
    if common.file_name()? != ".git" {
        return None; // bare repository: no main checkout
    }
    let main = common.parent()?;
    Some(main.join(path.strip_prefix(worktree).ok()?))
}

/// Directories too broad to be a project (home, filesystem root).
fn is_too_broad(path: &str) -> bool {
    let p = Path::new(path);
    if p.parent().is_none() {
        return true;
    }
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"));
    home.is_some_and(|h| Path::new(&h) == p)
}

impl Daemon {
    pub async fn resolve_project(
        &self,
        arg: Option<&str>,
        ctx: &ClientContext,
    ) -> Result<Resolved> {
        if let Some(raw) = arg.map(str::trim).filter(|s| !s.is_empty()) {
            if raw.eq_ignore_ascii_case("global") {
                return Ok(Resolved::Global);
            }
            if let Some(project) = self.store().find_project_by_name(raw).await? {
                return Ok(Resolved::Project {
                    project,
                    created: false,
                });
            }
            if Path::new(raw).is_absolute() {
                return self.resolve_path(raw).await;
            }
            // Unknown plain name: create it (AIs often name the project they are working on).
            let project = self
                .store()
                .create_project(NewProject {
                    name: raw.to_owned(),
                    root_path: None,
                    color_hex: None,
                })
                .await?;
            return Ok(Resolved::Project {
                project,
                created: true,
            });
        }
        for root in &ctx.roots {
            if !is_too_broad(root) {
                return self.resolve_path(root).await;
            }
        }
        if let Some(cwd) = ctx.cwd.as_deref().filter(|c| !is_too_broad(c)) {
            return self.resolve_path(cwd).await;
        }
        Ok(Resolved::Global)
    }

    async fn resolve_path(&self, path: &str) -> Result<Resolved> {
        let existed = self.store().resolve_project_by_path(path, false).await?;
        if let Some(project) = existed {
            return Ok(Resolved::Project {
                project,
                created: false,
            });
        }
        // A linked git worktree belongs to the project of its main checkout.
        if let Some(main) = main_checkout_path(Path::new(path))
            && let Some(project) = self
                .store()
                .resolve_project_by_path(&main.to_string_lossy(), false)
                .await?
        {
            return Ok(Resolved::Project {
                project,
                created: false,
            });
        }
        Ok(
            match self.store().resolve_project_by_path(path, true).await? {
                Some(project) => Resolved::Project {
                    project,
                    created: true,
                },
                None => Resolved::Global,
            },
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_file_uris() {
        assert_eq!(
            uri_to_path("file:///home/a/my%20app").as_deref(),
            Some("/home/a/my app")
        );
        assert_eq!(
            uri_to_path("file:///C:/Users/a/app").as_deref(),
            Some("C:/Users/a/app")
        );
        assert_eq!(uri_to_path("https://x"), None);
    }

    #[test]
    fn linked_worktrees_map_to_the_main_checkout() {
        let tmp = tempfile::tempdir().unwrap();
        let main = tmp.path().join("app");
        let wt = tmp.path().join("app-agent");
        let admin = main.join(".git/worktrees/app-agent");
        std::fs::create_dir_all(&admin).unwrap();
        std::fs::create_dir_all(wt.join("src")).unwrap();
        std::fs::write(admin.join("commondir"), "../..\n").unwrap();
        std::fs::write(wt.join(".git"), format!("gitdir: {}\n", admin.display())).unwrap();
        let main = std::fs::canonicalize(&main).unwrap();

        assert_eq!(main_checkout_path(&wt), Some(main.clone()));
        assert_eq!(main_checkout_path(&wt.join("src")), Some(main.join("src")));
        // The main checkout itself and submodules (no commondir) are left alone.
        assert_eq!(main_checkout_path(&main), None);
        let sub = tmp.path().join("sub");
        std::fs::create_dir_all(main.join(".git/modules/sub")).unwrap();
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(
            sub.join(".git"),
            format!("gitdir: {}\n", main.join(".git/modules/sub").display()),
        )
        .unwrap();
        assert_eq!(main_checkout_path(&sub), None);
    }

    #[test]
    fn broad_paths_are_rejected() {
        assert!(is_too_broad("/"));
        assert!(!is_too_broad("/home/someone/projects/cobalt"));
    }
}
