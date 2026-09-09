"use client";

import { memo } from "react";
import type { VaultState } from "@/lib/vault";
import { SectionTitle } from "../atoms";
import { noteAgeDays } from "../format";

// Goals — the daily note's Top 3.
//
// Only TODAY's note is interactive; a carried-over note is history and is
// rendered read-only with an increasingly loud staleness banner.

export const Priorities = memo(function Priorities({
  state,
  hot,
  onToggle,
}: {
  state: VaultState;
  hot?: boolean;
  onToggle: (index: number, done: boolean) => void;
}) {
  const d = state.daily;
  const ageDays = d && !d.isToday ? noteAgeDays(d.date) : 0;
  const veryStale = ageDays > 2;
  return (
    <section
      className={`block boot-stagger ${!d || d.isToday ? "" : "note-stale"} ${hot ? "voice-hot" : ""}`}
      style={{ animationDelay: "0.18s" }}
    >
      <SectionTitle title="Goals" tick="TOP.3" />
      {d ? (
        <>
          {!d.isToday && (
            <div className={`stale-banner ${veryStale ? "err" : ""}`}>
              ⚠ note is {ageDays}d old — run /today
            </div>
          )}
          {d.top3.map((p, i) => (
            <div
              className={`prio ${p.done ? "done" : ""} ${d.isToday ? "clickable" : ""}`}
              key={i}
              role={d.isToday ? "button" : undefined}
              title={d.isToday ? (p.done ? "mark open" : "mark done") : undefined}
              onClick={d.isToday ? () => onToggle(i, !p.done) : undefined}
            >
              <span className="box">{p.done ? "■" : "□"}</span>
              <span>{p.text}</span>
            </div>
          ))}
          <div className="prio-date">{d.isToday ? "today" : `carried · ${d.date}`}</div>
        </>
      ) : (
        <div className="prio dim">no daily note found</div>
      )}
    </section>
  );
});

// recent deliverables — every run that produced a document, newest first.
// The reveal chip is one-shot; this is the persistent trail.
