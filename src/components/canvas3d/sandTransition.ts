import type { GraphNode } from "@/types/contracts";

/** Maximum per-node stagger delay (seconds) for the organic sand ripple. */
export const SAND_MAX_STAGGER_SEC = 1.2;
/** Base travel duration per node (seconds). Combined with stagger, total is ~2.4-2.88 s. */
export const SAND_BASE_TRAVEL_SEC = 1.45;
/** Fractional per-node travel duration variation (+/- 16%). */
export const SAND_SPEED_VARIATION = 0.16;
/** Total duration (seconds) for the plain fade used when reduced motion is enabled. */
export const REDUCED_MOTION_FADE_SEC = 0.28;

const MAX_ARC_OFFSET_WORLD = 26;

/**
 * Stable deterministic 32-bit FNV-1a hash with Murmur3 avalanche finalizer.
 * Produces uniform distribution even for UUIDs sharing prefixes.
 */
export function hashString32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Derive an independent 32-bit value from a seed via SplitMix32 mixing. */
function mixU32(seed: number): number {
  let z = (seed + 0x9e3779b9) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
  return (z ^ (z >>> 15)) >>> 0;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return x >= edge1 ? 1 : 0;
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export interface PrepareSandTransitionParams {
  nodes: readonly GraphNode[];
  prevPositions: Float32Array;
  targetPositions: Float32Array;
  arcOffsets: Float32Array;
  nodeDelays: Float32Array;
  nodeDurations: Float32Array;
}

/**
 * Populate per-node stagger delays, travel durations, and perpendicular 3D curve
 * offsets in place so `useFrame` stays allocation-free and GPU-buffer driven.
 *
 * Returns the maximum end time (seconds) across all nodes.
 */
export function prepareSandTransition({
  nodes,
  prevPositions,
  targetPositions,
  arcOffsets,
  nodeDelays,
  nodeDurations,
}: PrepareSandTransitionParams): number {
  const count = nodes.length;
  if (count === 0) return 0;

  // 1. Compute centroid of the destination layout so the sand wave ripples outward
  let sumX = 0;
  let sumY = 0;
  let sumZ = 0;
  for (let i = 0; i < count; i += 1) {
    const i3 = i * 3;
    sumX += targetPositions[i3] ?? 0;
    sumY += targetPositions[i3 + 1] ?? 0;
    sumZ += targetPositions[i3 + 2] ?? 0;
  }
  const cx = sumX / count;
  const cy = sumY / count;
  const cz = sumZ / count;

  let sumDist = 0;
  let maxDist = 0;
  for (let i = 0; i < count; i += 1) {
    const i3 = i * 3;
    const d = Math.hypot(
      (targetPositions[i3] ?? 0) - cx,
      (targetPositions[i3 + 1] ?? 0) - cy,
      (targetPositions[i3 + 2] ?? 0) - cz,
    );
    sumDist += d;
    if (d > maxDist) maxDist = d;
  }
  const meanDist = sumDist / count;
  const refDist = maxDist > 1e-4 ? Math.max(1e-4, Math.min(maxDist, meanDist * 2.4)) : 1;

  // 2. Populate per-node delay, duration, and perpendicular arc vector
  let maxEndTimeSec = 0;
  for (let i = 0; i < count; i += 1) {
    const node = nodes[i];
    const i3 = i * 3;

    const h1 = hashString32(node ? node.id : String(i));
    const h2 = mixU32(h1);

    const randDelay = (h1 & 0xffff) / 0xffff;
    const randSpeed = ((h1 >>> 16) & 0xffff) / 0xffff;
    const sideSign = (h2 & 1) === 0 ? 1 : -1;
    const randVerticalSkew = (((h2 >>> 1) & 0x7fff) / 0x7fff) * 0.44 - 0.22;
    const randArcMag = 0.72 + (((h2 >>> 16) & 0xffff) / 0xffff) * 0.48;

    const px = prevPositions[i3] ?? 0;
    const py = prevPositions[i3 + 1] ?? 0;
    const pz = prevPositions[i3 + 2] ?? 0;
    const tx = targetPositions[i3] ?? 0;
    const ty = targetPositions[i3 + 1] ?? 0;
    const tz = targetPositions[i3 + 2] ?? 0;

    // Ripple outward from new center (65%) + organic stable hash scatter (35%)
    const distFromCenter = maxDist > 1e-4 ? Math.hypot(tx - cx, ty - cy, tz - cz) : 0;
    const normDist = Math.min(1, distFromCenter / refDist);
    const delaySec = (normDist * 0.65 + randDelay * 0.35) * SAND_MAX_STAGGER_SEC;
    const travelSec = SAND_BASE_TRAVEL_SEC * (1 + (randSpeed * 2 - 1) * SAND_SPEED_VARIATION);

    nodeDelays[i] = delaySec;
    nodeDurations[i] = travelSec;

    const endTime = delaySec + travelSec;
    if (endTime > maxEndTimeSec) {
      maxEndTimeSec = endTime;
    }

    // Perpendicular curved-path offset (orthogonal to displacement, decays to 0 at endpoints)
    const dx = tx - px;
    const dy = ty - py;
    const dz = tz - pz;
    const moveDist = Math.hypot(dx, dy, dz);

    if (moveDist < 1e-4) {
      arcOffsets[i3] = 0;
      arcOffsets[i3 + 1] = 0;
      arcOffsets[i3 + 2] = 0;
      continue;
    }

    const invDist = 1 / moveDist;
    const ux = dx * invDist;
    const uy = dy * invDist;
    const uz = dz * invDist;

    let rx = 0;
    let ry = 1;
    let rz = 0;
    if (Math.abs(uy) > 0.9) {
      rx = 1;
      ry = 0;
      rz = 0;
    }

    // Orthonormal basis (p1, p2) in the plane perpendicular to travel direction u
    let p1x = uy * rz - uz * ry;
    let p1y = uz * rx - ux * rz;
    let p1z = ux * ry - uy * rx;
    const p1Len = Math.hypot(p1x, p1y, p1z) || 1;
    p1x /= p1Len;
    p1y /= p1Len;
    p1z /= p1Len;

    const p2x = uy * p1z - uz * p1y;
    const p2y = uz * p1x - ux * p1z;
    const p2z = ux * p1y - uy * p1x;

    // Horizontal-biased sideways arc (like the style-lab sine sweep) with subtle 3D depth
    const baseAmp = Math.max(moveDist * 0.18, Math.min(moveDist * 0.45, 11));
    const amp = Math.min(baseAmp * randArcMag, MAX_ARC_OFFSET_WORLD);

    arcOffsets[i3] = (p1x * sideSign + p2x * randVerticalSkew) * amp;
    arcOffsets[i3 + 1] = (p1y * sideSign + p2y * randVerticalSkew) * amp;
    arcOffsets[i3 + 2] = (p1z * sideSign + p2z * randVerticalSkew) * amp;
  }

  return maxEndTimeSec;
}

/**
 * Advance all nodes one step along their staggered, cubic-eased curved sand paths,
 * writing directly into the GPU `positions` Float32Array.
 *
 * Returns `true` when every node has reached its target position.
 */
export function stepSandTransition(
  count: number,
  elapsedSec: number,
  positions: Float32Array,
  prevPositions: Float32Array,
  targetPositions: Float32Array,
  arcOffsets: Float32Array,
  nodeDelays: Float32Array,
  nodeDurations: Float32Array,
): boolean {
  let anyRemaining = false;

  for (let i = 0; i < count; i += 1) {
    const i3 = i * 3;
    const delay = nodeDelays[i] ?? 0;
    const duration = nodeDurations[i] ?? SAND_BASE_TRAVEL_SEC;
    const rawT = (elapsedSec - delay) / duration;

    if (rawT <= 0) {
      positions[i3] = prevPositions[i3] ?? 0;
      positions[i3 + 1] = prevPositions[i3 + 1] ?? 0;
      positions[i3 + 2] = prevPositions[i3 + 2] ?? 0;
      anyRemaining = true;
    } else if (rawT >= 1) {
      positions[i3] = targetPositions[i3] ?? 0;
      positions[i3 + 1] = targetPositions[i3 + 1] ?? 0;
      positions[i3 + 2] = targetPositions[i3 + 2] ?? 0;
    } else {
      // Cubic ease-in-out
      const u = rawT < 0.5 ? 4 * rawT * rawT * rawT : 1 - Math.pow(-2 * rawT + 2, 3) / 2;
      // Smooth sine sideways-arc envelope: 0 at start & landing, peaks mid-flight (style-lab)
      const arcScale = Math.sin(u * Math.PI);

      const px = prevPositions[i3] ?? 0;
      const py = prevPositions[i3 + 1] ?? 0;
      const pz = prevPositions[i3 + 2] ?? 0;
      const tx = targetPositions[i3] ?? 0;
      const ty = targetPositions[i3 + 1] ?? 0;
      const tz = targetPositions[i3 + 2] ?? 0;

      positions[i3] = px + (tx - px) * u + (arcOffsets[i3] ?? 0) * arcScale;
      positions[i3 + 1] = py + (ty - py) * u + (arcOffsets[i3 + 1] ?? 0) * arcScale;
      positions[i3 + 2] = pz + (tz - pz) * u + (arcOffsets[i3 + 2] ?? 0) * arcScale;
      anyRemaining = true;
    }
  }

  return !anyRemaining;
}
