"use client";

import { memo } from "react";
import type { VaultState } from "@/lib/vault";
import { useState } from "react";
import { DECK_SKILLS as REGISTRY_DECK_SKILLS } from "@/skills/index.js";
import { SectionTitle } from "../atoms";

// The Ops Board. Every button writes a REAL intent into system/queue/ and the
// runner picks it up — there is no demo mode.
//
// The roster comes from the skill registry (skills/), the same source the
// runner and the queue API read. A 15s cooldown per button is the only guard
// against a double-tap becoming two runs.

export const DECK_SKILLS = REGISTRY_DECK_SKILLS;

export function CommandDeck({
  state,
  hot,
  onQueued,
}: {
  state: VaultState | null;
  hot?: boolean;
  onQueued: (skill: string, ok: boolean) => void;
}) {
  const [cooldown, setCooldown] = useState<Record<string, boolean>>({});

  const fire = async (skill: string) => {
    if (cooldown[skill]) return;
    setCooldown((c) => ({ ...c, [skill]: true }));
    try {
      const res = await fetch("/api/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skill }),
      });
      onQueued(skill, res.ok);
    } catch {
      onQueued(skill, false);
    }
    setTimeout(() => setCooldown((c) => ({ ...c, [skill]: false })), 15000);
  };

  const r = state?.runner;
  return (
    <section className={`block boot-stagger ${hot ? "voice-hot" : ""}`} style={{ animationDelay: "0.26s" }}>
      <SectionTitle
        title="Ops Board"
        tick={r ? `${r.busy ? "ENGAGED" : "IDLE"} · ${r.active}/${r.max_concurrent} ACTIVE · ${r.pending} QUEUED` : "RUNNER OFFLINE"}
      />
      {state && state.queue.length > 0 && (
        <div className="queue-list">
          {state.queue.slice(0, 3).map((q) => (
            <span key={q.id}>▸ {q.label ?? q.skill}</span>
          ))}
          {state.queue.length > 3 && <span className="dim">+{state.queue.length - 3} more</span>}
        </div>
      )}
      <div className="deck">
        {DECK_SKILLS.map((d) => (
          <button
            key={d.skill}
            className={`deck-btn ${cooldown[d.skill] ? "fired" : ""}`}
            onClick={() => fire(d.skill)}
            disabled={cooldown[d.skill]}
          >
            <span className="deck-dot" />
            <span className="deck-label">{cooldown[d.skill] ? "QUEUED" : d.label}</span>
            <span className="deck-arrow">→</span>
          </button>
        ))}
      </div>
      <div className="deck-hint">each tap queues a real job — the runner takes it from there</div>
    </section>
  );
}

// Centered voice waveform — thin bars straddling the core, sized to sit
// inside the compass ring. No header, no labels: the bars alone carry state.
// Each bar gets a deterministic --a amplitude (a hash, not Math.random, so
// the shape is stable across renders) shaped by a sine envelope, which makes
// the middle taller than the edges instead of a flat block of spikes.
