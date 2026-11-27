import * as THREE from "three";
import type { ProjectContainer, Vec3 } from "@/types/contracts";

const ISLAND_SEGMENTS = 48;
const SLAB_TOP_Y = 0.0;
const SLAB_BOTTOM_Y = -1.35;

/**
 * Build a single merged BufferGeometry for all flat island slabs on the XZ plane
 * (1 draw call for any number of projects). Caller must dispose.
 */
export function buildIslandSlabsGeometry(
  containers: readonly ProjectContainer[],
): THREE.BufferGeometry | null {
  if (containers.length === 0) return null;

  const positions: number[] = [];
  const colors: number[] = [];

  const baseDark = new THREE.Color("#0d111a");
  const projColor = new THREE.Color();
  const topColor = new THREE.Color();
  const sideColor = new THREE.Color();

  for (const c of containers) {
    projColor.set(c.color);
    topColor.copy(baseDark).lerp(projColor, 0.2);
    sideColor.copy(baseDark).lerp(projColor, 0.38);

    const [cx, cy, cz] = c.center;
    const r = c.radius;
    const topY = cy + SLAB_TOP_Y;
    const botY = cy + SLAB_BOTTOM_Y;

    for (let s = 0; s < ISLAND_SEGMENTS; s += 1) {
      const a0 = (s / ISLAND_SEGMENTS) * Math.PI * 2;
      const a1 = ((s + 1) / ISLAND_SEGMENTS) * Math.PI * 2;
      const x0 = cx + Math.cos(a0) * r;
      const z0 = cz + Math.sin(a0) * r;
      const x1 = cx + Math.cos(a1) * r;
      const z1 = cz + Math.sin(a1) * r;

      // Top disc cap (CCW facing +Y)
      positions.push(cx, topY, cz, x1, topY, z1, x0, topY, z0);
      for (let v = 0; v < 3; v += 1) {
        colors.push(topColor.r, topColor.g, topColor.b);
      }

      // Thin side bevel quad (2 triangles)
      positions.push(
        x0, topY, z0,
        x1, topY, z1,
        x1, botY, z1,
        x0, topY, z0,
        x1, botY, z1,
        x0, botY, z0,
      );
      for (let v = 0; v < 6; v += 1) {
        colors.push(sideColor.r, sideColor.g, sideColor.b);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  return geometry;
}

/** Ensure custom dark project colors remain clearly readable on the dark obsidian backdrop. */
function ensureLegibleLabelHex(hex: string): string {
  const c = new THREE.Color();
  try {
    c.set(hex);
  } catch {
    return "#79A8FF";
  }
  const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  if (lum < 0.22) {
    c.lerp(new THREE.Color("#FFFFFF"), 0.42);
  }
  return `#${c.getHexString()}`;
}

export interface IslandLabelSpriteAsset {
  id: string;
  position: Vec3;
  scale: Vec3;
  texture: THREE.CanvasTexture;
  material: THREE.SpriteMaterial;
}

/**
 * Create a crisp hi-DPI floating billboard sprite for a project island
 * displaying `<name> · <N nodes>` in the project's `color_hex`.
 * Caller must dispose `texture` and `material`.
 */
export function createIslandLabelSprite(
  container: ProjectContainer,
  displayName: string,
  nodesCountLabel: string,
): IslandLabelSpriteAsset {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");

  const height = 112;
  const padX = 34;
  const dotRadius = 9;
  const dotGap = 18;
  const sepText = "  ·  ";

  const titleFont = '600 40px "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif';
  const countFont = '500 32px "IBM Plex Mono", ui-monospace, monospace';

  let titleWidth = 180;
  let sepWidth = 40;
  let countWidth = 140;

  const trimmedName =
    displayName.length > 28 ? `${displayName.slice(0, 27)}…` : displayName;

  if (ctx) {
    ctx.font = titleFont;
    titleWidth = ctx.measureText(trimmedName).width;
    ctx.font = countFont;
    sepWidth = ctx.measureText(sepText).width;
    countWidth = ctx.measureText(nodesCountLabel).width;
  }

  const contentWidth = dotRadius * 2 + dotGap + titleWidth + sepWidth + countWidth;
  const width = Math.min(1152, Math.max(320, Math.ceil(contentWidth + padX * 2)));

  canvas.width = width;
  canvas.height = height;

  if (ctx) {
    const legibleHex = ensureLegibleLabelHex(container.color);
    const radius = 14;

    ctx.clearRect(0, 0, width, height);

    // Pill backdrop
    ctx.beginPath();
    ctx.roundRect(4, 6, width - 8, height - 12, radius);
    ctx.fillStyle = "rgba(11, 12, 14, 0.86)";
    ctx.fill();

    // Accent border in project color
    ctx.lineWidth = 3;
    ctx.strokeStyle = legibleHex;
    ctx.globalAlpha = 0.78;
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Color dot
    const startX = (width - contentWidth) / 2;
    const centerY = height / 2;
    ctx.beginPath();
    ctx.arc(startX + dotRadius, centerY, dotRadius, 0, Math.PI * 2);
    ctx.fillStyle = legibleHex;
    ctx.fill();

    // Project name in its color_hex
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.font = titleFont;
    ctx.fillStyle = legibleHex;
    const textStartX = startX + dotRadius * 2 + dotGap;
    ctx.fillText(trimmedName, textStartX, centerY + 1);

    // Separator + node count
    ctx.font = countFont;
    ctx.fillStyle = "rgba(164, 160, 150, 0.75)";
    ctx.fillText(sepText, textStartX + titleWidth, centerY + 2);

    ctx.fillStyle = "#ECE9E1";
    ctx.fillText(nodesCountLabel, textStartX + titleWidth + sepWidth, centerY + 2);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;

  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: true,
    depthWrite: false,
  });

  const aspect = width / height;
  const worldHeight = Math.min(8.5, Math.max(6.2, 5.2 + container.radius * 0.085));
  const worldWidth = worldHeight * aspect;
  const [cx, cy, cz] = container.center;
  const labelY = cy + 9.5 + Math.min(5.5, container.radius * 0.14);

  return {
    id: container.id,
    position: [cx, labelY, cz],
    scale: [worldWidth, worldHeight, 1],
    texture,
    material,
  };
}

export interface IslandCameraFraming {
  position: Vec3;
  target: Vec3;
  maxDistance: number;
}

/**
 * Compute an elevated overview camera position that cleanly frames every island
 * on the XZ plane, accounting for viewport aspect ratio and floating labels.
 */
export function computeIslandsCameraFraming(
  containers: readonly ProjectContainer[],
  fovDeg: number,
  aspect: number,
): IslandCameraFraming | null {
  if (containers.length === 0) return null;

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;

  for (const c of containers) {
    const [cx, , cz] = c.center;
    if (cx - c.radius < minX) minX = cx - c.radius;
    if (cx + c.radius > maxX) maxX = cx + c.radius;
    if (cz - c.radius < minZ) minZ = cz - c.radius;
    if (cz + c.radius > maxZ) maxZ = cz + c.radius;
  }

  const centerX = (minX + maxX) / 2;
  const centerZ = (minZ + maxZ) / 2;
  const halfW = Math.max(20, (maxX - minX) / 2 + 10);
  const halfD = Math.max(20, (maxZ - minZ) / 2 + 12);

  const safeAspect = Math.max(0.6, aspect);
  const vFov = THREE.MathUtils.degToRad(Math.max(25, Math.min(90, fovDeg)));
  const hFov = 2 * Math.atan(Math.tan(vFov * 0.5) * safeAspect);

  // Camera sits at ~42 deg elevation looking down toward (centerX, 0, centerZ)
  const elevY = 0.67;
  const elevZ = 0.74;
  const distForWidth = halfW / Math.tan(hFov * 0.5);
  // Projected vertical footprint of the tilted XZ plane + floating labels
  const projectedHalfHeight = halfD * elevY + 14;
  const distForDepth = projectedHalfHeight / Math.tan(vFov * 0.5) + halfD * elevZ;

  const dist = Math.max(72, Math.max(distForWidth, distForDepth) * 1.16);

  return {
    position: [centerX, dist * elevY, centerZ + dist * elevZ],
    target: [centerX, 0, centerZ],
    maxDistance: Math.max(420, dist * 2.6),
  };
}
