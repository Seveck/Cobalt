//! `EngineManager` (feature `engines`): verified on-demand downloads of embedding models and
//! engine binaries from the pinned catalog, plus the Qdrant sidecar lifecycle.

pub mod downloader;
pub mod manager;
pub mod sidecar;

pub use downloader::{CancelFlag, Downloader};
pub use manager::EngineManager;
pub use sidecar::{QdrantSidecar, SidecarConfig};
