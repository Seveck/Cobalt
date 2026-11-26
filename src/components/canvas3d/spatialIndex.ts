import * as THREE from "three";

const EMPTY = -1;

/**
 * Zero-allocation 3D uniform spatial hash grid for fast ray picking on up to
 * 50,000+ point-sprite nodes without per-node raycasting.
 *
 * Uses a flat linked-list `next: Int32Array` indexed by node index and a
 * 3D DDA traversal (Amanatides & Woo) over the bounding box of the point cloud.
 */
export class SpatialHashGrid {
  private readonly cellSize: number;
  private readonly invCellSize: number;
  private readonly heads = new Map<number, number>();
  private next: Int32Array = new Int32Array(0);
  private count = 0;

  private minX = 0;
  private minY = 0;
  private minZ = 0;
  private maxX = 0;
  private maxY = 0;
  private maxZ = 0;
  private hasBounds = false;

  constructor(cellSize = 14) {
    this.cellSize = Math.max(2, cellSize);
    this.invCellSize = 1 / this.cellSize;
  }

  private packCell(cx: number, cy: number, cz: number): number {
    // Shift signed cell coords into [0..1023] (supports +-7000 world units at cellSize 14)
    const ox = (cx + 512) & 0x3ff;
    const oy = (cy + 512) & 0x3ff;
    const oz = (cz + 512) & 0x3ff;
    return ox + (oy << 10) + (oz << 20);
  }

  /**
   * Rebuild the spatial index in place from flat `positions` (stride 3) and `sizes` (stride 1).
   * Nodes with `sizes[i] <= 0` are skipped so filtered-out nodes are never pickable.
   */
  rebuild(positions: Float32Array, sizes: Float32Array, nodeCount: number): void {
    this.heads.clear();
    this.count = nodeCount;

    if (this.next.length < nodeCount) {
      this.next = new Int32Array(Math.max(1024, nodeCount));
    }

    if (nodeCount === 0) {
      this.hasBounds = false;
      return;
    }

    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    let visibleAny = false;

    const inv = this.invCellSize;

    for (let i = 0; i < nodeCount; i += 1) {
      const size = sizes[i] ?? 0;
      if (size <= 0.0001) {
        this.next[i] = EMPTY;
        continue;
      }

      const i3 = i * 3;
      const x = positions[i3] ?? 0;
      const y = positions[i3 + 1] ?? 0;
      const z = positions[i3 + 2] ?? 0;

      visibleAny = true;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;

      const cx = Math.floor(x * inv);
      const cy = Math.floor(y * inv);
      const cz = Math.floor(z * inv);
      const key = this.packCell(cx, cy, cz);

      const prevHead = this.heads.get(key);
      this.next[i] = prevHead === undefined ? EMPTY : prevHead;
      this.heads.set(key, i);
    }

    const pad = this.cellSize;
    this.hasBounds = visibleAny;
    this.minX = minX - pad;
    this.minY = minY - pad;
    this.minZ = minZ - pad;
    this.maxX = maxX + pad;
    this.maxY = maxY + pad;
    this.maxZ = maxZ + pad;
  }

  /**
   * Pick the closest visible node along `ray`, matching screen-space point sprite
   * radius so picking stays crisp at both close-up and overview zoom distances.
   */
  pickRay(
    ray: THREE.Ray,
    positions: Float32Array,
    sizes: Float32Array,
    fovRad: number,
    viewportHeight: number,
  ): number {
    if (!this.hasBounds || this.count === 0) return -1;

    const ox = ray.origin.x;
    const oy = ray.origin.y;
    const oz = ray.origin.z;
    const dx = ray.direction.x;
    const dy = ray.direction.y;
    const dz = ray.direction.z;

    // Slab intersection with padded AABB
    let tMin = 0.05;
    let tMax = 2000;

    if (Math.abs(dx) < 1e-8) {
      if (ox < this.minX || ox > this.maxX) return -1;
    } else {
      const invDx = 1 / dx;
      let t1 = (this.minX - ox) * invDx;
      let t2 = (this.maxX - ox) * invDx;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
      }
      if (t1 > tMin) tMin = t1;
      if (t2 < tMax) tMax = t2;
      if (tMin > tMax) return -1;
    }

    if (Math.abs(dy) < 1e-8) {
      if (oy < this.minY || oy > this.maxY) return -1;
    } else {
      const invDy = 1 / dy;
      let t1 = (this.minY - oy) * invDy;
      let t2 = (this.maxY - oy) * invDy;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
      }
      if (t1 > tMin) tMin = t1;
      if (t2 < tMax) tMax = t2;
      if (tMin > tMax) return -1;
    }

    if (Math.abs(dz) < 1e-8) {
      if (oz < this.minZ || oz > this.maxZ) return -1;
    } else {
      const invDz = 1 / dz;
      let t1 = (this.minZ - oz) * invDz;
      let t2 = (this.maxZ - oz) * invDz;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
      }
      if (t1 > tMin) tMin = t1;
      if (t2 < tMax) tMax = t2;
      if (tMin > tMax) return -1;
    }

    // World units per pixel at distance 1
    const worldPerPxAtUnitDist = (2 * Math.tan(fovRad * 0.5)) / Math.max(1, viewportHeight);
    const minPickPixels = 8.5;

    // 3D DDA setup starting at tMin
    const startX = ox + dx * tMin;
    const startY = oy + dy * tMin;
    const startZ = oz + dz * tMin;

    let cx = Math.floor(startX * this.invCellSize);
    let cy = Math.floor(startY * this.invCellSize);
    let cz = Math.floor(startZ * this.invCellSize);

    const stepX = dx >= 0 ? 1 : -1;
    const stepY = dy >= 0 ? 1 : -1;
    const stepZ = dz >= 0 ? 1 : -1;

    const nextBoundaryX = (cx + (stepX > 0 ? 1 : 0)) * this.cellSize;
    const nextBoundaryY = (cy + (stepY > 0 ? 1 : 0)) * this.cellSize;
    const nextBoundaryZ = (cz + (stepZ > 0 ? 1 : 0)) * this.cellSize;

    let tMaxX = Math.abs(dx) < 1e-8 ? Infinity : tMin + (nextBoundaryX - startX) / dx;
    let tMaxY = Math.abs(dy) < 1e-8 ? Infinity : tMin + (nextBoundaryY - startY) / dy;
    let tMaxZ = Math.abs(dz) < 1e-8 ? Infinity : tMin + (nextBoundaryZ - startZ) / dz;

    const tDeltaX = Math.abs(dx) < 1e-8 ? Infinity : Math.abs(this.cellSize / dx);
    const tDeltaY = Math.abs(dy) < 1e-8 ? Infinity : Math.abs(this.cellSize / dy);
    const tDeltaZ = Math.abs(dz) < 1e-8 ? Infinity : Math.abs(this.cellSize / dz);

    let bestIndex = -1;
    let bestScore = Infinity;

    const testCell = (tx: number, ty: number, tz: number) => {
      let idx = this.heads.get(this.packCell(tx, ty, tz));
      while (idx !== undefined && idx !== EMPTY) {
        const size = sizes[idx] ?? 0;
        if (size > 0.0001) {
          const i3 = idx * 3;
          const vx = (positions[i3] ?? 0) - ox;
          const vy = (positions[i3 + 1] ?? 0) - oy;
          const vz = (positions[i3 + 2] ?? 0) - oz;
          const proj = vx * dx + vy * dy + vz * dz;
          if (proj > 0.1) {
            const px = vx - dx * proj;
            const py = vy - dy * proj;
            const pz = vz - dz * proj;
            const distSq = px * px + py * py + pz * pz;

            const screenTolerance = proj * worldPerPxAtUnitDist * minPickPixels;
            const worldRadius = Math.max(size * 1.45, screenTolerance);
            if (distSq <= worldRadius * worldRadius) {
              // Favor front-most node tightly aligned to the ray
              const normalizedOffset = Math.sqrt(distSq) / worldRadius;
              const score = proj * (0.8 + normalizedOffset * 0.45);
              if (score < bestScore) {
                bestScore = score;
                bestIndex = idx;
              }
            }
          }
        }
        idx = this.next[idx];
      }
    };

    // Traverse cells along the ray (capped for safety)
    let tCurrent = tMin;
    for (let step = 0; step < 192 && tCurrent <= tMax; step += 1) {
      // Check current cell and immediate 6-neighbors on first hit proximity
      testCell(cx, cy, cz);
      testCell(cx + 1, cy, cz);
      testCell(cx - 1, cy, cz);
      testCell(cx, cy + 1, cz);
      testCell(cx, cy - 1, cz);
      testCell(cx, cy, cz + 1);
      testCell(cx, cy, cz - 1);

      // Early exit once we've moved past the best candidate depth by one cell
      if (bestIndex !== -1 && tCurrent > bestScore + this.cellSize) {
        break;
      }

      if (tMaxX < tMaxY) {
        if (tMaxX < tMaxZ) {
          tCurrent = tMaxX;
          tMaxX += tDeltaX;
          cx += stepX;
        } else {
          tCurrent = tMaxZ;
          tMaxZ += tDeltaZ;
          cz += stepZ;
        }
      } else if (tMaxY < tMaxZ) {
        tCurrent = tMaxY;
        tMaxY += tDeltaY;
        cy += stepY;
      } else {
        tCurrent = tMaxZ;
        tMaxZ += tDeltaZ;
        cz += stepZ;
      }
    }

    return bestIndex;
  }
}
