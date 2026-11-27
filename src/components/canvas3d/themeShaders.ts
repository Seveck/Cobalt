import * as THREE from "three";

export interface ShaderValidationResult {
  ok: boolean;
  /** First 20 non-empty compiler/linker log lines when `ok === false`. */
  log: string;
}

const THREE_SHADER_VERTEX_PREFIX = /* glsl */ `
precision highp float;
precision highp int;
uniform mat4 modelMatrix;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform mat4 viewMatrix;
uniform mat3 normalMatrix;
uniform vec3 cameraPosition;
uniform bool isOrthographic;
attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;
`;

const THREE_SHADER_FRAGMENT_PREFIX = /* glsl */ `
precision highp float;
precision highp int;
uniform mat4 viewMatrix;
uniform vec3 cameraPosition;
uniform bool isOrthographic;
`;

export const EDGE_VERTEX_SHADER = /* glsl */ `
  attribute vec3 color;
  uniform float uTime;

  varying vec3 vColor;

  void main() {
    vColor = color;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export const EDGE_FRAGMENT_SHADER = /* glsl */ `
  uniform float uTime;
  uniform float uOpacity;

  varying vec3 vColor;

  void main() {
    gl_FragColor = vec4(vColor, uOpacity);
  }
`;

export const BACKGROUND_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.9999, 1.0);
  }
`;

/** Check whether a GLSL vertex shader already declares `attribute vec3/vec4 color`. */
export function declaresColorAttribute(vertexShader: string): boolean {
  return /\battribute\s+vec[34]\s+color\b/.test(vertexShader);
}

function truncateShaderLog(raw: string, maxLines = 20): string {
  const cleaned = raw
    .replace(/\0/g, "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  return cleaned.slice(0, maxLines).join("\n");
}

/**
 * Compile and link a GLSL ES 1.00 vertex + fragment shader pair against the live
 * WebGL context using Three.js's standard ShaderMaterial prefix declarations.
 * Always deletes every temporary WebGL shader and program handle.
 */
export function validateShaderProgram(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  vertexShader: string,
  fragmentShader: string,
  options?: { vertexColors?: boolean },
): ShaderValidationResult {
  const colorPrefix = options?.vertexColors ? "attribute vec3 color;\n" : "";
  const fullVertex = `${THREE_SHADER_VERTEX_PREFIX}${colorPrefix}\n${vertexShader}`;
  const fullFragment = `${THREE_SHADER_FRAGMENT_PREFIX}\n${fragmentShader}`;

  const vs = gl.createShader(gl.VERTEX_SHADER);
  const fs = gl.createShader(gl.FRAGMENT_SHADER);
  const prog = gl.createProgram();

  if (!vs || !fs || !prog) {
    if (vs) gl.deleteShader(vs);
    if (fs) gl.deleteShader(fs);
    if (prog) gl.deleteProgram(prog);
    return { ok: false, log: "WebGL context failed to allocate shader program." };
  }

  try {
    gl.shaderSource(vs, fullVertex);
    gl.compileShader(vs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
      const log = truncateShaderLog(gl.getShaderInfoLog(vs) ?? "Vertex shader compile failed.");
      return { ok: false, log: log || "Vertex shader compile failed." };
    }

    gl.shaderSource(fs, fullFragment);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      const log = truncateShaderLog(gl.getShaderInfoLog(fs) ?? "Fragment shader compile failed.");
      return { ok: false, log: log || "Fragment shader compile failed." };
    }

    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const log = truncateShaderLog(gl.getProgramInfoLog(prog) ?? "Shader program link failed.");
      return { ok: false, log: log || "Shader program link failed." };
    }

    return { ok: true, log: "" };
  } finally {
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    gl.deleteProgram(prog);
  }
}

/**
 * Create a custom edge ShaderMaterial per THEME_SPEC §6.2.
 * Only used when a custom edge vertex or fragment shader is active.
 * Caller must dispose on unmount or theme change.
 */
export function createEdgeShaderMaterial(
  opacity: number,
  custom?: { vertex?: string | null; fragment?: string | null },
): THREE.ShaderMaterial {
  const vertexShader = custom?.vertex ?? EDGE_VERTEX_SHADER;
  const fragmentShader = custom?.fragment ?? EDGE_FRAGMENT_SHADER;
  const vertexColors = !declaresColorAttribute(vertexShader);

  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    vertexColors,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    uniforms: {
      uTime: { value: 0 },
      uOpacity: { value: opacity },
    },
  });
}

/**
 * Create a full-screen background quad ShaderMaterial per THEME_SPEC §6.2.
 * Exposes varying `vUv` and uniforms `uTime`, `uResolution`, `uBackground`.
 * Caller must dispose on unmount or theme change.
 */
export function createBackgroundShaderMaterial(
  backgroundHex: string,
  customFragment: string,
  width: number,
  height: number,
  pixelRatio: number,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: BACKGROUND_VERTEX_SHADER,
    fragmentShader: customFragment,
    depthTest: false,
    depthWrite: false,
    transparent: false,
    uniforms: {
      uTime: { value: 0 },
      uResolution: {
        value: new THREE.Vector2(
          Math.max(1, width * pixelRatio),
          Math.max(1, height * pixelRatio),
        ),
      },
      uBackground: { value: new THREE.Color(backgroundHex) },
    },
  });
}
