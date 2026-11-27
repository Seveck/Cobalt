import * as THREE from "three";

export const NODE_POINT_VERTEX_SHADER = /* glsl */ `
  attribute vec3 aColor;
  attribute float aSize;
  attribute vec4 aMeta;  // x: isCorePin, y: isReusable, z: focus (0..3), w: opacityScale
  attribute vec4 aPulse; // rgb: pulseColor, a: pulseIntensity (0..1)

  uniform float uPixelRatio;
  uniform float uScaleFactor;
  uniform float uMinPointSize;
  uniform float uMaxPointSize;

  varying vec3 vColor;
  varying vec4 vMeta;
  varying vec4 vPulse;

  void main() {
    if (aSize <= 0.0001) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      return;
    }

    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    float dist = max(1.0, -mvPosition.z);

    // Extra sprite canvas space for halos (Nuclear Law, focus reticle, synaptic pulse)
    float hasAura = max(aMeta.x, max(step(0.5, aMeta.z), step(0.02, aPulse.a)));
    float pulseBoost = 1.0 + aPulse.a * 0.85;
    float auraExpand = mix(1.0, 1.75, hasAura);

    float computedSize = aSize * auraExpand * pulseBoost * uScaleFactor / dist;
    gl_PointSize = clamp(computedSize * uPixelRatio, uMinPointSize * uPixelRatio, uMaxPointSize * uPixelRatio);
    gl_Position = projectionMatrix * mvPosition;

    vColor = aColor;
    vMeta = aMeta;
    vPulse = aPulse;
  }
`;

export const NODE_POINT_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uCorePinColor;
  uniform float uTime;

  varying vec3 vColor;
  varying vec4 vMeta;
  varying vec4 vPulse;

  void main() {
    vec2 centered = gl_PointCoord - vec2(0.5);
    float r = length(centered);
    if (r > 0.5) discard;

    float isCorePin = vMeta.x;
    float isReusable = vMeta.y;
    float focus = vMeta.z;
    float opacityScale = vMeta.w;
    float pulse = clamp(vPulse.a, 0.0, 1.0);

    float hasAura = max(isCorePin, max(step(0.5, focus), step(0.02, pulse)));
    float discRadius = mix(0.35, 0.22, hasAura);

    // Crisp anti-aliased core disc
    float disc = 1.0 - smoothstep(discRadius - 0.05, discRadius + 0.03, r);
    // Subtle core highlight for depth legibility without scene lighting
    float innerCore = 1.0 - smoothstep(0.0, discRadius * 0.72, r);
    vec3 col = mix(vColor, mix(vColor, vec3(1.0), 0.35), innerCore * 0.45);
    float alpha = disc * 0.95;

    // Reusable subtle inner accent ring
    if (isReusable > 0.5 && isCorePin < 0.5) {
      float ring = smoothstep(discRadius - 0.08, discRadius - 0.04, r) *
                   (1.0 - smoothstep(discRadius - 0.03, discRadius + 0.01, r));
      col = mix(col, vec3(0.86, 0.82, 1.0), ring * 0.55);
    }

    // Nuclear Law golden halo ring + soft aura
    if (isCorePin > 0.5) {
      float breathe = 0.5 + 0.5 * sin(uTime * 2.2);
      float haloPos = 0.34 + breathe * 0.02;
      float haloRing = exp(-pow((r - haloPos) / 0.042, 2.0));
      float softGlow = (1.0 - smoothstep(discRadius, 0.5, r)) * 0.38;
      col = mix(col, uCorePinColor, clamp(haloRing * 0.9 + softGlow, 0.0, 1.0));
      alpha = max(alpha, clamp(haloRing * 0.92 + softGlow, 0.0, 0.95));
    }

    // Focus reticle (1 = hover, 2 = selected, 3 = RAG hit highlight)
    if (focus > 0.5) {
      vec3 reticleColor = focus > 2.5
        ? vec3(0.47, 0.66, 1.0)
        : (focus > 1.5 ? vec3(0.95, 0.94, 0.90) : vec3(0.75, 0.86, 1.0));
      float reticle = exp(-pow((r - 0.42) / 0.028, 2.0));
      col = mix(col, reticleColor, reticle * 0.95);
      alpha = max(alpha, reticle * 0.92);
    }

    // Synaptic live mode pulse glow (OPERATION_COLORS weighted by similarity_score)
    if (pulse > 0.01) {
      float wave = exp(-pow((r - (0.28 + (1.0 - pulse) * 0.16)) / 0.065, 2.0));
      float aura = (1.0 - smoothstep(discRadius * 0.8, 0.5, r)) * pulse * 0.78;
      vec3 pulseCol = mix(vPulse.rgb, vec3(1.0), 0.22 * pulse);
      col = mix(col, pulseCol, clamp(pulse * 0.65 + wave * 0.85, 0.0, 1.0));
      alpha = max(alpha, clamp(aura + wave * pulse * 0.95, 0.0, 0.98));
    }

    // Subtle soft ambient rim on regular discs
    if (hasAura < 0.5) {
      float rim = (1.0 - smoothstep(discRadius, 0.5, r)) * 0.22;
      alpha = max(alpha, rim);
    }

    alpha *= opacityScale;
    if (alpha < 0.02) discard;

    gl_FragColor = vec4(col, alpha);
  }
`;

export interface CustomNodeShaderSources {
  vertex?: string | null;
  fragment?: string | null;
}

/**
 * Create a lightweight camera-facing point-sprite ShaderMaterial per THEME_SPEC §6.1–6.2.
 * Accepts optional custom vertex and/or fragment GLSL while preserving all attribute,
 * varying, and uniform contracts. Caller must dispose on unmount or theme change.
 */
export function createNodePointMaterial(
  corePinHex: string,
  custom?: CustomNodeShaderSources,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: custom?.vertex ?? NODE_POINT_VERTEX_SHADER,
    fragmentShader: custom?.fragment ?? NODE_POINT_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.NormalBlending,
    uniforms: {
      uPixelRatio: { value: 1 },
      uScaleFactor: { value: 320 },
      uMinPointSize: { value: 3.0 },
      uMaxPointSize: { value: 44.0 },
      uCorePinColor: { value: new THREE.Color(corePinHex) },
      uTime: { value: 0 },
    },
  });
}
