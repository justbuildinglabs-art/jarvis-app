import { CLOUD_R } from "./modes";

// The node cloud's GLSL.
//
// Everything the cloud does visually is here rather than in JS: point size,
// the white-hot centre, the per-node twinkle, and the brightness wave that
// ripples outward per syllable while speaking. Doing it on the GPU is what
// lets ~1100 nodes each keep their own clock without a per-frame JS loop.
//
// Note what the shimmer does NOT do: its hue offset is per-node and static,
// with no uTime term, so the cloud never cycles colour. Speaking makes it
// shimmer within a narrow band of the fixed accent, and that is all.

export const NODE_VERT = /* glsl */ `
uniform float uTime;
attribute float aSeed;
varying float vR;
varying float vSeed;
void main() {
  vR = length(position) / ${CLOUD_R.toFixed(2)};
  vSeed = aSeed;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float big = step(0.86, fract(aSeed * 7.13)); // 14% are hub nodes
  gl_PointSize = (0.5 + big * 0.8) * (58.0 / -mv.z);
  gl_Position = projectionMatrix * mv;
}
`;

export const NODE_FRAG = /* glsl */ `
uniform float uTime;
uniform float uBoost;
uniform float uLevel;
uniform float uHue;
uniform vec3 uInner;
uniform vec3 uOuter;
varying float vR;
varying float vSeed;
vec3 hsl2rgb(vec3 hsl) {
  vec3 rgb = clamp(abs(mod(hsl.x * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  return hsl.z + hsl.y * (rgb - 0.5) * (1.0 - abs(2.0 * hsl.z - 1.0));
}
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float alpha = smoothstep(0.5, 0.22, length(c));
  vec3 col = mix(uInner, uOuter, smoothstep(0.0, 0.95, vR));
  // speaking: nodes shimmer within ±~40° of the fixed accent hue. The offset
  // is per-node and STATIC — no uTime term, so hue never animates.
  float off = (fract(vSeed * 3.17) - 0.5) * 0.22;
  vec3 shimmer = hsl2rgb(vec3(fract(uHue + off), 0.8, 0.62));
  col = mix(col, shimmer, uLevel * 0.55);
  // white-hot center — nodes near the core bleach toward white for contrast
  // (after shimmer, so the core stays white while speaking)
  col = mix(col, vec3(1.0), 0.85 * (1.0 - smoothstep(0.05, 0.5, vR)));
  // twinkle — every node flickers on its own clock
  alpha *= 0.3 + 0.7 * (0.5 + 0.5 * sin(uTime * (1.0 + vSeed * 2.5) + vSeed * 43.0));
  // speaking: brightness waves ripple outward from the center per syllable
  alpha *= 1.0 + uLevel * 0.45 * sin(vR * 9.0 - uTime * 5.5);
  alpha *= uBoost;
  gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0) * 0.55);
}
`;

// synthetic speech envelope — syllable bursts with pauses
