"use client";

import { memo } from "react";
import type { VaultState } from "@/lib/vault";
import { SectionTitle } from "../atoms";

// Signal Scan — today's morning-report headlines, click through to the full
// report. Three only: the panel sits at the viewport edge and more clips.

export const Wire = memo(function Wire({
  state,
  onOpen,
}: {
  state: VaultState;
  onOpen: (path: string) => void;
}) {
  const m = state.morning;
  if (!m || m.heads.length === 0) return null;
  return (
    <section className="block boot-stagger" style={{ animationDelay: "0.5s" }}>
      <SectionTitle title="Signal Scan" tick="AM.INTEL" />
      {/* top 3 only — the panel sits at the viewport's edge and more cuts off */}
      {m.heads.slice(0, 3).map((h, i) => (
        <div className="wire-row" key={i} role="button" onClick={() => onOpen(m.rel)}>
          <span className="wire-bullet">▸</span>
          <span>{h}</span>
        </div>
      ))}
    </section>
  );
});

// compass bezel around the core — degree ticks (minor 2° / mid 10° / major
// 30°), radial numerals, cardinal markers, and two slow counter-drifting arc
// segments. Pure static SVG; all motion is CSS (globals: .compass-spin-*).
