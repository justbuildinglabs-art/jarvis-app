"use client";

import { memo } from "react";
import type { VaultState } from "@/lib/vault";
import type { CoreMode } from "../../GraphCore";



export const WAVE_BARS = 200;

export const VoiceWave = memo(function VoiceWave({ mode }: { mode: CoreMode }) {
  const live = mode === "speaking" || mode === "listening";
  return (
    <div
      className={`voice-wave ${live ? "live" : "idle"} ${mode === "listening" ? "cobalt" : ""}`}
      aria-hidden="true"
    >
      {Array.from({ length: WAVE_BARS }, (_, i) => {
        const t = i / (WAVE_BARS - 1);
        const envelope = Math.pow(Math.sin(Math.PI * t), 0.7); // tallest mid-span
        const jitter = Math.abs((Math.sin(i * 12.9898) * 43758.5453) % 1);
        const a = (0.18 + jitter * 0.82) * envelope;
        return (
          <i
            key={i}
            style={{ "--i": i, "--a": a.toFixed(3) } as React.CSSProperties}
          />
        );
      })}
    </div>
  );
});
