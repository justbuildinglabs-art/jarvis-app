import * as THREE from "three";

// Small generated inputs the core needs at startup.
//
// The glow sprite is drawn to a canvas rather than shipped as a PNG: it is a
// radial gradient, so generating it costs nothing, avoids a network request
// before the first frame, and keeps the falloff editable as numbers.

export function fakeSpeechLevel(): number {
  const t = performance.now() * 0.001;
  const gate = Math.sin(t * 0.9) > -0.6 ? 1 : 0.08;
  const syllables = (0.45 + 0.55 * Math.sin(t * 6.1)) * (0.4 + 0.6 * Math.sin(t * 2.3));
  return gate * Math.max(0, syllables);
}

export function glowTexture(): THREE.Texture {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.25, "rgba(255,255,255,0.4)");
  g.addColorStop(0.6, "rgba(255,255,255,0.08)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}
