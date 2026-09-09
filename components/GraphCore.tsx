"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";

import {
  BG_MODES,
  CLOUD_R,
  CYAN_HUE,
  ERROR_HUE,
  FEELS,
  LINKS_PER_NODE,
  N_NODES,
  type BgMode,
  type CoreMode,
} from "./cores/modes";
import { NODE_FRAG, NODE_VERT } from "./cores/shaders";
import { fakeSpeechLevel, glowTexture } from "./cores/textures";

// ---------------------------------------------------------------------------
// The graph core — the volumetric knowledge-graph cloud at the centre of the
// HUD, and the only thing on screen that is not text.
//
// ~1100 nodes, centre-dense, each linked to its nearest neighbours by real
// edges that follow the nodes as they drift. The whole cloud rotates slowly
// while every node also wanders on its own; speech pulses brightness across
// all of it rather than flashing the centre, which is what keeps it reading
// as a thinking system rather than a level meter.
//
// The speech envelope is real when there is audio: the voice client exposes
// an AnalyserNode's RMS through getLevel(). Without audio it falls back to a
// synthetic envelope, so demo mode still looks alive.
//
// The parts that are data rather than plumbing now live in ./cores/ — the
// mode feels, the GLSL, and the generated glow sprite.
// ---------------------------------------------------------------------------

export type { CoreMode, BgMode } from "./cores/modes";
export { BG_MODES } from "./cores/modes";

export default function GraphCore({
  mode = "idle",
  bgMode = "depth",
  getLevel,
}: {
  mode?: CoreMode;
  bgMode?: BgMode;
  /** real speech envelope 0..1, or null when no audio is playing */
  getLevel?: () => number | null;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const modeRef = useRef<CoreMode>(mode);
  const bgRef = useRef<BgMode>(bgMode);
  const getLevelRef = useRef(getLevel);
  modeRef.current = mode;
  bgRef.current = bgMode;
  getLevelRef.current = getLevel;

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    // transparent canvas — the page's backdrop grid (.bg-grid) and stage
    // color show through behind the scene
    const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true });
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();

    const camera = new THREE.PerspectiveCamera(
      45,
      mount.clientWidth / mount.clientHeight,
      0.1,
      100
    );
    camera.position.set(0, 0, 5.7);

    const cloud = new THREE.Group();
    cloud.position.y = 0.32; // sit slightly above screen center, clear of the MRR block
    scene.add(cloud);

    // --- nodes: center-dense volumetric cloud --------------------------------
    const base = new Float32Array(N_NODES * 3);
    for (let i = 0; i < N_NODES; i++) {
      const cosT = Math.random() * 2 - 1;
      const sinT = Math.sqrt(1 - cosT * cosT);
      const phi = Math.random() * Math.PI * 2;
      const r = Math.pow(Math.random(), 0.45) * CLOUD_R;
      base[i * 3] = sinT * Math.cos(phi) * r;
      base[i * 3 + 1] = cosT * r;
      base[i * 3 + 2] = sinT * Math.sin(phi) * r;
    }
    // per-node wander params
    const freq = new Float32Array(N_NODES * 3);
    const phase = new Float32Array(N_NODES * 3);
    const amp = new Float32Array(N_NODES);
    for (let i = 0; i < N_NODES; i++) {
      for (let k = 0; k < 3; k++) {
        freq[i * 3 + k] = 0.3 + Math.random() * 0.55;
        phase[i * 3 + k] = Math.random() * Math.PI * 2;
      }
      amp[i] = 0.04 + Math.random() * 0.05;
    }

    const live = new Float32Array(base); // drifted positions, updated per frame
    const nodeGeo = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(live, 3);
    posAttr.setUsage(THREE.DynamicDrawUsage);
    nodeGeo.setAttribute("position", posAttr);
    const seeds = new Float32Array(N_NODES);
    for (let i = 0; i < N_NODES; i++) seeds[i] = Math.random();
    nodeGeo.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));

    const nodeMat = new THREE.ShaderMaterial({
      vertexShader: NODE_VERT,
      fragmentShader: NODE_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uBoost: { value: 1 },
        uLevel: { value: 0 },
        // seeded AT the fixed anchor — these lerp toward the live hue each
        // frame, so any other start value would drift on screen at boot
        uHue: { value: CYAN_HUE },
        uInner: { value: new THREE.Color().setHSL(CYAN_HUE, 0.65, 0.84) },
        uOuter: { value: new THREE.Color().setHSL(CYAN_HUE, 0.85, 0.45) },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    cloud.add(new THREE.Points(nodeGeo, nodeMat));

    // --- edges: each node linked to its nearest neighbors --------------------
    // O(n²) once at init (~5M dist checks, fine); edges then follow the drift.
    const edgePairs: number[] = [];
    {
      const seen = new Set<string>();
      const bestIdx = new Array<number>(LINKS_PER_NODE);
      const bestD = new Array<number>(LINKS_PER_NODE);
      for (let i = 0; i < N_NODES; i++) {
        bestIdx.fill(-1);
        bestD.fill(Infinity);
        const ix = base[i * 3];
        const iy = base[i * 3 + 1];
        const iz = base[i * 3 + 2];
        for (let j = 0; j < N_NODES; j++) {
          if (j === i) continue;
          const dx = base[j * 3] - ix;
          const dy = base[j * 3 + 1] - iy;
          const dz = base[j * 3 + 2] - iz;
          const d = dx * dx + dy * dy + dz * dz;
          for (let k = 0; k < LINKS_PER_NODE; k++) {
            if (d < bestD[k]) {
              for (let m = LINKS_PER_NODE - 1; m > k; m--) {
                bestD[m] = bestD[m - 1];
                bestIdx[m] = bestIdx[m - 1];
              }
              bestD[k] = d;
              bestIdx[k] = j;
              break;
            }
          }
        }
        for (let k = 0; k < LINKS_PER_NODE; k++) {
          const j = bestIdx[k];
          if (j < 0) continue;
          const key = i < j ? `${i}:${j}` : `${j}:${i}`;
          if (!seen.has(key)) {
            seen.add(key);
            edgePairs.push(i, j);
          }
        }
      }
    }
    const E = edgePairs.length / 2;
    const edgePos = new Float32Array(E * 6);
    const edgeGeo = new THREE.BufferGeometry();
    const edgeAttr = new THREE.BufferAttribute(edgePos, 3);
    edgeAttr.setUsage(THREE.DynamicDrawUsage);
    edgeGeo.setAttribute("position", edgeAttr);
    const edgeMat = new THREE.LineBasicMaterial({
      color: new THREE.Color().setHSL(CYAN_HUE, 0.85, 0.6),
      transparent: true,
      // Raised from 0.14: at that level the cloud read as loose particles.
      // The links are what make it legible as a knowledge graph.
      opacity: 0.3,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    cloud.add(new THREE.LineSegments(edgeGeo, edgeMat));

    // --- ambient halo (speech swells the whole cloud, no center flash) -------
    const tex = glowTexture();
    const halo = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: tex,
        color: "#1d3fb8",
        transparent: true,
        opacity: 0.16,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    halo.material.opacity = 0.09;
    halo.scale.setScalar(3.0);
    cloud.add(halo);

    // --- background layers (toggled by bgMode) --------------------------------
    // depth: hue-tinted radial glow behind the cloud + distant dust
    const bgGlow = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: tex,
        // seeded at the anchor — it lerps toward the live hue each frame
        color: new THREE.Color().setHSL(CYAN_HUE, 0.85, 0.45),
        transparent: true,
        opacity: 0.07,
        depthWrite: false,
      })
    );
    bgGlow.position.set(0, 0.32, -2.2);
    bgGlow.scale.setScalar(9);
    scene.add(bgGlow);

    // dust lives strictly BEHIND the orb (z < -2.5) — nothing drifts into
    // the foreground and balloons up near the camera
    const DUST = 420;
    const dustGeo = new THREE.BufferGeometry();
    const dustPts = new Float32Array(DUST * 3);
    for (let i = 0; i < DUST; i++) {
      dustPts[i * 3] = (Math.random() - 0.5) * 18;
      dustPts[i * 3 + 1] = (Math.random() - 0.5) * 10 + 0.32;
      dustPts[i * 3 + 2] = -2.5 - Math.random() * 6.5;
    }
    dustGeo.setAttribute("position", new THREE.BufferAttribute(dustPts, 3));
    const dustMat = new THREE.PointsMaterial({
      color: "#7a8cc8",
      size: 0.018,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const dust = new THREE.Points(dustGeo, dustMat);
    scene.add(dust);

    // (the perspective floor grid that used to live here is gone — the flat
    // backdrop grid in globals.css (.bg-grid) is the only grid now)

    // nebula: slow fbm fog plane far behind the cloud
    const nebMat = new THREE.ShaderMaterial({
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uCol;
        varying vec2 vUv;
        float hash(vec2 p) {
          p = fract(p * vec2(0.3183099, 0.3678794)) + 0.1;
          p += dot(p, p + 19.19);
          return fract(p.x * p.y);
        }
        float vnoise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(hash(i), hash(i + vec2(1, 0)), f.x),
            mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x),
            f.y);
        }
        float fbm(vec2 p) {
          float v = 0.0;
          float a = 0.5;
          for (int i = 0; i < 4; i++) {
            v += a * vnoise(p);
            p *= 2.1;
            a *= 0.5;
          }
          return v;
        }
        void main() {
          vec2 uv = vUv * 3.4;
          float n = fbm(uv + vec2(uTime * 0.018, -uTime * 0.011));
          n = smoothstep(0.35, 0.95, n);
          // fade toward edges so the plane never shows
          float edge = smoothstep(0.0, 0.25, vUv.x) * smoothstep(1.0, 0.75, vUv.x)
                     * smoothstep(0.0, 0.25, vUv.y) * smoothstep(1.0, 0.75, vUv.y);
          gl_FragColor = vec4(uCol, n * edge * 0.34);
        }`,
      uniforms: {
        uTime: { value: 0 },
        uCol: { value: new THREE.Color("#16307a") },
      },
      transparent: true,
      depthWrite: false,
    });
    const nebula = new THREE.Mesh(new THREE.PlaneGeometry(20, 11.5), nebMat);
    nebula.position.set(0, 0.32, -3.2);
    scene.add(nebula);

    // --- post: bloom ----------------------------------------------------------
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bloom = new UnrealBloomPass(
      new THREE.Vector2(mount.clientWidth, mount.clientHeight),
      0.45,
      0.5,
      0.2
    );
    composer.addPass(bloom);
    composer.addPass(new OutputPass());

    // --- interaction -----------------------------------------------------------
    const target = { x: 0, y: 0 };
    const onMouse = (e: MouseEvent) => {
      target.x = (e.clientX / window.innerWidth - 0.5) * 0.6;
      target.y = (e.clientY / window.innerHeight - 0.5) * 0.4;
    };
    window.addEventListener("mousemove", onMouse);

    const onResize = () => {
      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(mount.clientWidth, mount.clientHeight);
      composer.setSize(mount.clientWidth, mount.clientHeight);
    };
    window.addEventListener("resize", onResize);

    const tInner = new THREE.Color();
    const tOuter = new THREE.Color();
    const tEdge = new THREE.Color();

    const clock = new THREE.Clock();
    let level = 0;
    let speed = 1;
    let lastT = 0;
    // speed-integrated clock — mode changes alter velocity, never position
    // (t * speed would snap rotation/drift when speed lerps on a mode flip)
    let simT = 0;
    let raf = 0;
    const tick = () => {
      const t = clock.getElapsedTime();
      const dt = Math.min(t - lastT, 0.1);
      lastT = t;
      const feel = FEELS[modeRef.current];

      // voice envelope — fast attack, soft release; real RMS when audio is live
      let targetLevel = 0;
      if (modeRef.current === "speaking") {
        const real = getLevelRef.current?.();
        targetLevel = real ?? fakeSpeechLevel();
      }
      level += (targetLevel - level) * (targetLevel > level ? 0.5 : 0.12);
      speed += (feel.speed - speed) * 0.03;
      simT += dt * speed;

      // Hue is FIXED — no rotation, no voyage. The orb holds its cyan anchor;
      // error is the one semantic exception and parks on red. The HUD chrome
      // is a static white ramp (globals.css) and is no longer driven from here.
      const h = modeRef.current === "error" ? ERROR_HUE : CYAN_HUE;

      // node drift — edges copy endpoints so links follow
      const ts = simT;
      for (let i = 0; i < N_NODES; i++) {
        const a = amp[i];
        const i3 = i * 3;
        live[i3] = base[i3] + a * Math.sin(ts * freq[i3] + phase[i3]);
        live[i3 + 1] = base[i3 + 1] + a * Math.sin(ts * freq[i3 + 1] + phase[i3 + 1]);
        live[i3 + 2] = base[i3 + 2] + a * Math.sin(ts * freq[i3 + 2] + phase[i3 + 2]);
      }
      for (let e = 0; e < E; e++) {
        const ai = edgePairs[e * 2] * 3;
        const bi = edgePairs[e * 2 + 1] * 3;
        const o = e * 6;
        edgePos[o] = live[ai];
        edgePos[o + 1] = live[ai + 1];
        edgePos[o + 2] = live[ai + 2];
        edgePos[o + 3] = live[bi];
        edgePos[o + 4] = live[bi + 1];
        edgePos[o + 5] = live[bi + 2];
      }
      posAttr.needsUpdate = true;
      edgeAttr.needsUpdate = true;

      // palette follows the hue voyage
      tInner.setHSL(h, 0.65, 0.84);
      tOuter.setHSL(h, 0.85, 0.45);
      tEdge.setHSL(h, 0.8, 0.55);
      (nodeMat.uniforms.uInner.value as THREE.Color).lerp(tInner, 0.06);
      (nodeMat.uniforms.uOuter.value as THREE.Color).lerp(tOuter, 0.06);
      edgeMat.color.lerp(tEdge, 0.06);

      nodeMat.uniforms.uTime.value = t;
      nodeMat.uniforms.uLevel.value = level;
      nodeMat.uniforms.uHue.value = h;
      // speech = whole-system brightness pulse, not a center flash
      nodeMat.uniforms.uBoost.value = feel.boost * (1 + level * 0.6);
      edgeMat.opacity = 0.11 + 0.05 * Math.sin(t * 0.7) + level * 0.22;

      // background layers
      const bg = bgRef.current;
      bgGlow.visible = bg !== "flat";
      dust.visible = bg !== "flat";
      nebula.visible = bg === "nebula";
      if (bgGlow.visible) bgGlow.material.color.lerp(tOuter, 0.06);
      if (dust.visible) {
        // slow roll around the view axis — stays in the background plane
        dust.rotation.z = t * 0.008;
        dustMat.color.lerp(tEdge, 0.06);
      }
      if (nebula.visible) {
        nebMat.uniforms.uTime.value = t;
        (nebMat.uniforms.uCol.value as THREE.Color).lerp(tOuter, 0.06);
      }

      halo.material.color.copy(nodeMat.uniforms.uOuter.value as THREE.Color);
      halo.material.opacity = 0.08 + level * 0.1;

      cloud.rotation.y = simT * 0.1;
      cloud.rotation.x = Math.sin(t * 0.07) * 0.08 + target.y * 0.25;
      bloom.strength = 0.45 + level * 0.35;

      camera.position.x += (target.x * 1.1 - camera.position.x) * 0.04;
      camera.position.y += (-target.y * 0.7 - camera.position.y) * 0.04;
      camera.lookAt(0, 0.32, 0);

      composer.render();
      raf = requestAnimationFrame(tick);
    };
    tick();

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("mousemove", onMouse);
      window.removeEventListener("resize", onResize);
      nodeGeo.dispose();
      nodeMat.dispose();
      edgeGeo.dispose();
      edgeMat.dispose();
      tex.dispose();
      halo.material.dispose();
      bgGlow.material.dispose();
      dustGeo.dispose();
      dustMat.dispose();
      nebula.geometry.dispose();
      nebMat.dispose();
      composer.dispose();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
  }, []);

  return (
    <div className="graph-core" aria-hidden="true">
      <div ref={mountRef} className="graph-canvas" />
      {bgMode !== "flat" && <div className="bg-vignette" />}
    </div>
  );
}
