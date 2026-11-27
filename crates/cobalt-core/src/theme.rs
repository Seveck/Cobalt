//! `.cobalt-theme` manifest, remote registry and sandbox limits (see `docs/THEME_SPEC.md`).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::enums::{
    HardwareTier, LayoutType, MemoryCategory, NodeShape, SemanticEdgesMode, ThemeCompatibility,
};
use crate::ids::Timestamp;

/// File extension of theme packages.
pub const THEME_PACKAGE_EXT: &str = "cobalt-theme";
/// Hard cap on the total uncompressed size of a theme.
pub const THEME_MAX_UNPACKED_BYTES: u64 = 25 * 1024 * 1024;
/// Hard cap on the number of entries inside a theme package.
pub const THEME_MAX_ENTRIES: usize = 128;
/// Per-entry compression ratio above which the package is treated as a zip bomb.
pub const THEME_MAX_COMPRESSION_RATIO: u64 = 100;
pub const THEME_MANIFEST_FILE: &str = "manifest.json";
pub const THEME_PREVIEW_FILE: &str = "preview.webp";
/// Only `shaders/<name>.glsl` files are allowed in this directory.
pub const THEME_SHADERS_DIR: &str = "shaders";
/// Only `meshes/<name>.glb` files are allowed in this directory.
pub const THEME_MESHES_DIR: &str = "meshes";
/// Extensions that are always rejected, even if renamed into an allowed directory.
pub const THEME_FORBIDDEN_EXTENSIONS: &[&str] = &[
    "js", "mjs", "cjs", "ts", "tsx", "jsx", "wasm", "html", "htm", "svg", "exe", "dll", "so",
    "dylib", "sh", "bat", "cmd", "ps1", "app", "bin", "py",
];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct LayoutParams {
    /// Vertical distance between tree levels / layers (world units).
    pub level_spacing: f64,
    /// Radial spread of branches / clusters (world units).
    pub radial_spread: f64,
    pub show_virtual_anchors: bool,
    pub semantic_edges_mode: SemanticEdgesMode,
}

impl Default for LayoutParams {
    fn default() -> Self {
        Self {
            level_spacing: 18.0,
            radial_spread: 40.0,
            show_virtual_anchors: true,
            semantic_edges_mode: SemanticEdgesMode::HoverOnly,
        }
    }
}

/// Colors as `#RRGGBB`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ThemePalette {
    pub background: String,
    pub node: String,
    pub core_pin: String,
    pub reusable: String,
    pub edge: String,
    pub text: String,
    pub pulse_read: String,
    pub pulse_reuse: String,
    pub pulse_write: String,
    pub pulse_update: String,
    pub pulse_blocked: String,
    pub category_colors: BTreeMap<MemoryCategory, String>,
}

impl Default for ThemePalette {
    fn default() -> Self {
        Self {
            background: "#05070D".into(),
            node: "#3B82F6".into(),
            core_pin: "#FACC15".into(),
            reusable: "#A78BFA".into(),
            edge: "#1E3A8A".into(),
            text: "#E2E8F0".into(),
            pulse_read: "#0047AB".into(),
            pulse_reuse: "#8B5CF6".into(),
            pulse_write: "#10B981".into(),
            pulse_update: "#F59E0B".into(),
            pulse_blocked: "#EF4444".into(),
            category_colors: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct NodeGeometry {
    pub shape: NodeShape,
    pub base_size: f64,
    /// Scale nodes by `log(1 + hit_count)`.
    pub scale_by_hits: bool,
    /// Tessellation detail for sphere / icosahedron.
    pub detail: u32,
}

impl Default for NodeGeometry {
    fn default() -> Self {
        Self {
            shape: NodeShape::Sphere,
            base_size: 0.6,
            scale_by_hits: true,
            detail: 1,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct CameraSpec {
    pub position: [f64; 3],
    pub target: [f64; 3],
    pub fov: f64,
    pub auto_rotate: bool,
    pub auto_rotate_speed: f64,
}

impl Default for CameraSpec {
    fn default() -> Self {
        Self {
            position: [0.0, 40.0, 160.0],
            target: [0.0, 0.0, 0.0],
            fov: 55.0,
            auto_rotate: false,
            auto_rotate_speed: 0.3,
        }
    }
}

/// Paths relative to the theme root; each must be `shaders/<name>.glsl`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ShaderSpec {
    pub node_vertex: Option<String>,
    pub node_fragment: Option<String>,
    pub edge_vertex: Option<String>,
    pub edge_fragment: Option<String>,
    pub background_fragment: Option<String>,
}

/// `manifest.json` of a `.cobalt-theme` package.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ThemeManifest {
    /// `^[a-z0-9][a-z0-9-]{1,63}$`; also the install folder name.
    pub id: String,
    pub name: String,
    pub author: String,
    /// SemVer.
    pub version: String,
    #[serde(default)]
    pub description: Option<String>,
    /// Minimum recommended tier.
    pub hardware_tier: HardwareTier,
    pub layout_type: LayoutType,
    #[serde(default)]
    pub layout_params: LayoutParams,
    #[serde(default)]
    pub palette: ThemePalette,
    #[serde(default)]
    pub node_geometry: NodeGeometry,
    #[serde(default)]
    pub camera: CameraSpec,
    #[serde(default)]
    pub shaders: ShaderSpec,
    /// Required when `layout_type` is `custom_mesh`; must be `meshes/<name>.glb`.
    #[serde(default)]
    pub mesh_path: Option<String>,
    /// Whole-app interface style (THEME_SPEC v1.2). `None` = the 3D brain only; the app chrome
    /// keeps the default style.
    #[serde(default)]
    pub ui: Option<ThemeUi>,
}

/// App chrome style generated from a few inputs (THEME_SPEC §3.1, v1.2).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ThemeUi {
    pub mode: UiMode,
    /// OKLCH hue of the neutral surfaces, 0–360.
    pub base_hue: f64,
    /// How much of that hue the neutrals carry, 0 (grey) – 100.
    pub base_tint: f64,
    /// Lightness spread between background, surfaces and text, 0–100.
    pub contrast: f64,
    /// `#RRGGBB`; used only for interactive elements, selection and focus.
    pub accent: String,
    /// Corner radius in px, 0–16.
    pub radius: f64,
    pub density: UiDensity,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UiMode {
    Light,
    Dark,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UiDensity {
    Compact,
    Comfortable,
    Spacious,
}

impl ThemeUi {
    /// Range checks applied when a theme is installed.
    pub fn validate(&self) -> crate::error::Result<()> {
        let in_range = |v: f64, max: f64| v.is_finite() && (0.0..=max).contains(&v);
        let hex = self.accent.len() == 7
            && self.accent.starts_with('#')
            && self.accent[1..].bytes().all(|b| b.is_ascii_hexdigit());
        if in_range(self.base_hue, 360.0)
            && in_range(self.base_tint, 100.0)
            && in_range(self.contrast, 100.0)
            && in_range(self.radius, 16.0)
            && hex
        {
            Ok(())
        } else {
            Err(crate::error::CobaltError::InvalidInput(
                "theme ui values out of range".into(),
            ))
        }
    }
}

/// Remote `registry.json` (fetched into memory only, never written to disk).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RegistryIndex {
    pub schema_version: u32,
    pub updated_at: Timestamp,
    pub themes: Vec<RegistryEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RegistryEntry {
    pub id: String,
    pub name: String,
    pub author: String,
    pub version: String,
    pub description: Option<String>,
    /// Exact download size of the `.cobalt-theme` package.
    pub size_bytes: u64,
    /// Declared uncompressed size (verified again during extraction).
    pub unpacked_size_bytes: u64,
    pub hardware_tier: HardwareTier,
    pub layout_type: LayoutType,
    /// HTTPS URL of `preview.webp`.
    pub preview_url: String,
    /// HTTPS URL of the `.cobalt-theme` package.
    pub download_url: String,
    /// Lowercase hex SHA-256 of the package.
    pub sha256: String,
}

/// Transparency card shown in the theme store.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ThemeCard {
    pub entry: RegistryEntry,
    pub compatibility: ThemeCompatibility,
    pub installed: bool,
    pub installed_version: Option<String>,
}
