import * as THREE from "three";

export const NODE_POINT_VERTEX_SHADER = /* glsl */ `
  attribute vec3 aColor;
  attribute float aSize;
  attribute vec4 aMeta;  // x: isCorePin, y: isReusable, z: focus (0..3), w: opacityScale
  attribute vec4 aPulse; // rgb: luminous pulseColor, a: pulseIntensity (0..1)

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

    float pulse = clamp(aPulse.a, 0.0, 1.0);
    float pulsePresence = smoothstep(0.0, 0.08, pulse);

    // Extra sprite canvas space for halos (Nuclear Law, focus reticle, or 3-4x synaptic pulse halo)
    float hasNonPulseAura = max(aMeta.x, step(0.5, aMeta.z));
    float normalExpand = mix(1.0, 1.75, hasNonPulseAura);
    float pulseExpand = mix(3.4, 4.2, pulse);
    float auraExpand = mix(normalExpand, pulseExpand, pulsePresence);

    float computedSize = aSize * auraExpand * uScaleFactor / dist;

    // Guarantee pulsing nodes are never smaller than 10 px on screen (24 px halo canvas)
    float pulseMinPx = max(uMinPointSize, 24.0);
    float pulseMaxPx = max(uMaxPointSize * 3.0, 132.0);
    float minPx = mix(uMinPointSize, pulseMinPx, pulsePresence);
    float maxPx = mix(uMaxPointSize, pulseMaxPx, pulsePresence);

    gl_PointSize = clamp(computedSize * uPixelRatio, minPx * uPixelRatio, maxPx * uPixelRatio);
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
    float pulsePresence = smoothstep(0.0, 0.08, pulse);

    float hasNonPulseAura = max(isCorePin, step(0.5, focus));
    float baseDiscRadius = mix(0.35, 0.22, hasNonPulseAura);
    float discRadius = mix(baseDiscRadius, 0.13, pulsePresence);

    // Crisp anti-aliased core disc
    float disc = 1.0 - smoothstep(discRadius - 0.045, discRadius + 0.025, r);
    // Subtle core highlight for depth legibility without scene lighting
    float innerCore = 1.0 - smoothstep(0.0, discRadius * 0.72, r);
    vec3 col = mix(vColor, mix(vColor, vec3(1.0), 0.35), innerCore * 0.45);
    float alpha = disc * 0.95;

    // Reusable subtle inner accent ring
    if (isReusable > 0.5 && isCorePin < 0.5 && pulsePresence < 0.5) {
      float ring = smoothstep(discRadius - 0.08, discRadius - 0.04, r) *
                   (1.0 - smoothstep(discRadius - 0.03, discRadius + 0.01, r));
      col = mix(col, vec3(0.86, 0.82, 1.0), ring * 0.55);
    }

    // Nuclear Law golden halo ring + soft aura
    if (isCorePin > 0.5 && pulsePresence < 0.5) {
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
      float reticleRadius = mix(0.42, 0.25, pulsePresence);
      float reticle = exp(-pow((r - reticleRadius) / 0.026, 2.0));
      col = mix(col, reticleColor, reticle * 0.95);
      alpha = max(alpha, reticle * 0.92);
    }

    // Synaptic live mode pulse: white-hot core + luminous 3-4x halo + expanding sonar rings
    if (pulse > 0.005) {
      float whiteCore = (1.0 - smoothstep(0.0, discRadius * 1.12, r)) * smoothstep(0.0, 0.22, pulse);
      float coreBloom = exp(-pow(r / 0.175, 2.0)) * pulse;
      float innerHalo = exp(-pow(max(0.0, r - discRadius * 0.7) / 0.145, 1.75)) * pulse * 0.94;
      float outerHalo = (1.0 - smoothstep(discRadius, 0.5, r)) * pulse * 0.52;

      // Two staggered expanding rings radiating from core to halo rim
      float phase1 = fract(uTime * 0.6);
      float phase2 = fract(uTime * 0.6 + 0.5);
      float ring1Pos = mix(discRadius, 0.485, phase1);
      float ring2Pos = mix(discRadius, 0.485, phase2);
      float ring1 = exp(-pow((r - ring1Pos) / 0.027, 2.0)) * (1.0 - smoothstep(0.55, 1.0, phase1));
      float ring2 = exp(-pow((r - ring2Pos) / 0.027, 2.0)) * (1.0 - smoothstep(0.55, 1.0, phase2));
      float expandingRing = max(ring1, ring2 * 0.76) * pulse;

      vec3 pulseTint = mix(vPulse.rgb, vec3(1.0), 0.24 * pulse);
      vec3 ringCol = mix(vPulse.rgb, vec3(1.0), 0.58);
      float haloStrength = clamp(innerHalo + outerHalo, 0.0, 1.0);

      col = mix(col, pulseTint, clamp(pulse * 0.88 + haloStrength * 0.92, 0.0, 1.0));
      col = mix(col, ringCol, clamp(expandingRing * 0.96, 0.0, 1.0));
      col = mix(col, vec3(1.0), clamp(whiteCore * 0.96 + coreBloom * 0.48, 0.0, 1.0));
      alpha = max(alpha, clamp(haloStrength + expandingRing * 0.98 + whiteCore * 0.98, 0.0, 1.0));
    } else if (vPulse.a < -0.005) {
      // Very faint internal change flicker: subtle disc tint only, no halo or size expansion
      float flicker = clamp(-vPulse.a, 0.0, 1.0);
      vec3 flickerTint = mix(vPulse.rgb, vec3(1.0), 0.16);
      col = mix(col, flickerTint, flicker * 0.48 * disc);
    }

    // Subtle soft ambient rim on regular discs
    if (hasNonPulseAura < 0.5 && pulsePresence < 0.5) {
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
