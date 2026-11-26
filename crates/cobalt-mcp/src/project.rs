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
}

impl ClientContext {
    pub fn new(transport: McpTransport) -> Self {
        Self {
            client_name: UNKNOWN_CLIENT.to_owned(),
            transport,
            cwd: None,
            roots: Vec::new(),
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
            if let Some(project) = self.store.find_project_by_name(raw).await? {
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
                .store
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
        let existed = self.store.resolve_project_by_path(path, false).await?;
        if let Some(project) = existed {
            return Ok(Resolved::Project {
                project,
                created: false,
            });
        }
        Ok(
            match self.store.resolve_project_by_path(path, true).await? {
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
    fn broad_paths_are_rejected() {
        assert!(is_too_broad("/"));
        assert!(!is_too_broad("/home/someone/projects/cobalt"));
    }
}
