import * as THREE from "three";
import type { CameraSpec, ProjectContainer, Vec3 } from "@/types/contracts";

/** Matches `Sidebar.tsx` widths (`w-60` expanded / `w-12` collapsed). */
export const SIDEBAR_EXPANDED_WIDTH_PX = 240;
export const SIDEBAR_COLLAPSED_WIDTH_PX = 48;

/** Matches `LayoutsPanel.tsx` widths (`w-64` expanded / `w-12` collapsed). */
export const LAYOUTS_PANEL_EXPANDED_WIDTH_PX = 256;
export const LAYOUTS_PANEL_COLLAPSED_WIDTH_PX = 48;

/** Breathing margin around the bounding sphere (~15% viewport padding). */
const FRAMING_MARGIN_FACTOR = 1.15;
const MIN_BOUNDING_RADIUS = 18;
const MIN_CAMERA_DISTANCE = 54;

export interface FramingViewportMetrics {
  canvasWidth: number;
  canvasHeight: number;
  windowWidth: number;
  windowHeight: number;
  sidebarCollapsed: boolean;
  layoutsPanelCollapsed: boolean;
  topInset: number;
  bottomInset: number;
}

export interface LayoutCameraFraming {
  position: Vec3;
  target: Vec3;
  fov: number;
  maxDistance: number;
}

export interface ComputeLayoutCameraFramingParams {
  positions: readonly Vec3[];
  containers: readonly ProjectContainer[];
  isProjectIslands: boolean;
  themeCamera: CameraSpec;
  viewport: FramingViewportMetrics;
}

/**
 * Compute an initial / reset / center camera framing from the current layout's
 * bounding sphere:
 * - Centers on the cloud centroid
 * - Solves distance so the entire sphere fits with ~15% margin for current FOV & aspect
 * - Accounts for collapsible sidebar & layouts panel widths plus HUD top/bottom insets
 * - Falls back cleanly to the theme camera when the brain is empty
 */
export function computeLayoutCameraFraming({
  positions,
  containers,
  isProjectIslands,
  themeCamera,
  viewport,
}: ComputeLayoutCameraFramingParams): LayoutCameraFraming {
  const fovDeg = Math.max(25, Math.min(90, themeCamera.fov));

  // Build effective sample points for centroid & bounding radius
  const hasNodes = positions.length > 0;
  const hasContainers = containers.length > 0;

  if (!hasNodes && !hasContainers) {
    const fallbackDir = new THREE.Vector3(
      themeCamera.position[0] - themeCamera.target[0],
      themeCamera.position[1] - themeCamera.target[1],
      themeCamera.position[2] - themeCamera.target[2],
    );
    const fallbackDist = Math.max(MIN_CAMERA_DISTANCE, fallbackDir.length() * FRAMING_MARGIN_FACTOR);
    if (fallbackDir.lengthSq() < 1e-4) {
      fallbackDir.set(0, 0.25, 1);
    }
    fallbackDir.normalize();
    const [tx, ty, tz] = themeCamera.target;
    return {
      position: [
        tx + fallbackDir.x * fallbackDist,
        ty + fallbackDir.y * fallbackDist,
        tz + fallbackDir.z * fallbackDist,
      ],
      target: [tx, ty, tz],
      fov: fovDeg,
      maxDistance: Math.max(480, Math.ceil(fallbackDist * 2.4)),
    };
  }

  // 1. Centroid of the layout's point cloud (falling back to container centers if nodes empty)
  let sumX = 0;
  let sumY = 0;
  let sumZ = 0;
  let count = 0;

  if (hasNodes) {
    for (const pos of positions) {
      sumX += pos[0];
      sumY += pos[1];
      sumZ += pos[2];
      count += 1;
    }
  } else {
    for (const c of containers) {
      sumX += c.center[0];
      sumY += c.center[1];
      sumZ += c.center[2];
      count += 1;
    }
  }

  const cx = count > 0 ? sumX / count : 0;
  const cy = count > 0 ? sumY / count : 0;
  const cz = count > 0 ? sumZ / count : 0;

  // 2. Bounding sphere radius around the centroid (encompassing nodes + island slabs / cluster shells)
  let radiusSq = 0;
  for (const pos of positions) {
    const dx = pos[0] - cx;
    const dy = pos[1] - cy;
    const dz = pos[2] - cz;
    const dSq = dx * dx + dy * dy + dz * dz;
    if (dSq > radiusSq) radiusSq = dSq;
  }

  let radius = Math.sqrt(radiusSq);

  if (hasContainers) {
    for (const c of containers) {
      const [px, py, pz] = c.center;
      const distToCenter = Math.hypot(px - cx, py - cy, pz - cz);
      // Cover the full disc/sphere container radius
      const containerExtent = distToCenter + c.radius;
      if (containerExtent > radius) {
        radius = containerExtent;
      }
      // For project_islands, also cover the floating billboard label above each island
      if (isProjectIslands) {
        const labelTopY = py + 11.5 + Math.min(5.5, c.radius * 0.14);
        const labelDist = Math.hypot(px - cx, labelTopY - cy, pz - cz) + 4;
        if (labelDist > radius) {
          radius = labelDist;
        }
      }
    }
  }

  radius = Math.max(MIN_BOUNDING_RADIUS, radius);

  // 3. Resolve effective canvas dimensions accounting for sidebar & layouts panel widths
  const sidebarW = viewport.sidebarCollapsed
    ? SIDEBAR_COLLAPSED_WIDTH_PX
    : SIDEBAR_EXPANDED_WIDTH_PX;
  const layoutsW = viewport.layoutsPanelCollapsed
    ? LAYOUTS_PANEL_COLLAPSED_WIDTH_PX
    : LAYOUTS_PANEL_EXPANDED_WIDTH_PX;

  const expectedCanvasWidth =
    viewport.windowWidth > 0
      ? Math.max(240, viewport.windowWidth - sidebarW - layoutsW)
      : Math.max(240, viewport.canvasWidth);

  const effectiveWidth =
    viewport.canvasWidth > 0 && viewport.windowWidth > 0
      ? Math.max(240, Math.min(viewport.canvasWidth, expectedCanvasWidth))
      : expectedCanvasWidth;

  const effectiveHeight = Math.max(
    200,
    viewport.canvasHeight > 0 ? viewport.canvasHeight : viewport.windowHeight || 600,
  );

  // Usable vertical area inside the canvas between top toolbar and bottom FilterDock
  const safeTop = Math.max(0, Math.min(effectiveHeight * 0.28, viewport.topInset));
  const safeBottom = Math.max(0, Math.min(effectiveHeight * 0.28, viewport.bottomInset));
  const usableHeight = Math.max(effectiveHeight * 0.55, effectiveHeight - safeTop - safeBottom);

  const vFov = THREE.MathUtils.degToRad(fovDeg);
  const tanVHalf = Math.tan(vFov * 0.5);

  // Effective vertical half-FOV inside the HUD-free band and horizontal half-FOV for canvas width
  const effectiveVHalf = Math.atan(tanVHalf * (usableHeight / effectiveHeight));
  const effectiveHHalf = Math.atan(tanVHalf * (effectiveWidth / effectiveHeight));
  const limitingHalfFov = Math.max(0.12, Math.min(effectiveVHalf, effectiveHHalf));

  // Exact tangent distance for a bounding sphere of radius R + ~15% margin
  const fitDist = Math.max(
    MIN_CAMERA_DISTANCE,
    (radius / Math.sin(limitingHalfFov)) * FRAMING_MARGIN_FACTOR,
  );

  // 4. Viewing direction: elevated overview for project_islands, theme angle for all other layouts
  const dir = new THREE.Vector3();
  if (isProjectIslands) {
    // ~42 deg elevation looking down onto the island slabs
    dir.set(0, 0.67, 0.74).normalize();
  } else {
    dir.set(
      themeCamera.position[0] - themeCamera.target[0],
      themeCamera.position[1] - themeCamera.target[1],
      themeCamera.position[2] - themeCamera.target[2],
    );
    if (dir.lengthSq() < 1e-4) {
      dir.set(0, 0.25, 1);
    }
    dir.normalize();
  }

  return {
    position: [cx + dir.x * fitDist, cy + dir.y * fitDist, cz + dir.z * fitDist],
    target: [cx, cy, cz],
    fov: fovDeg,
    maxDistance: Math.max(480, Math.ceil(fitDist * 2.4)),
  };
}
