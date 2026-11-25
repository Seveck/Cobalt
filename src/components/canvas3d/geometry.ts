import * as THREE from "three";
import type { NodeGeometry } from "@/types/contracts";

/**
 * Create a Three.js `BufferGeometry` matching the theme manifest's `NodeGeometry`.
 * Caller is responsible for calling `.dispose()` when the geometry is replaced or unmounted.
 */
export function createNodeGeometry(spec: NodeGeometry): THREE.BufferGeometry {
  const detail = Math.max(0, Math.min(3, Math.round(spec.detail)));

  switch (spec.shape) {
    case "sphere": {
      const segments = 8 + detail * 6;
      return new THREE.SphereGeometry(1, segments, segments);
    }
    case "icosahedron":
      return new THREE.IcosahedronGeometry(1, detail);
    case "octahedron":
      return new THREE.OctahedronGeometry(1, detail);
    case "box":
      return new THREE.BoxGeometry(1.5, 1.5, 1.5);
    case "point":
      return new THREE.SphereGeometry(0.65, 6, 6);
    case "mesh":
    default:
      return new THREE.SphereGeometry(1, 12, 12);
  }
}
