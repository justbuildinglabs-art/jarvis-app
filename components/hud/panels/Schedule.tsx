"use client";

import { memo } from "react";
import type { VaultState } from "@/lib/vault";
import { SectionTitle } from "../atoms";
import { useClock } from "../hooks";
import { noteAgeDays } from "../format";

// Timeline — the daily note's schedule, with the current block marked.
// "Current" is the latest item that has already started, so the marker sits
// on what you are in rather than what is next.

export function parseHHMM(t: string): number {
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : -1;
}

export const Schedule = memo(function Schedule({ state, hot }: { state: VaultState; hot?: boolean }) {
  const d = state.daily;
  const now = useClock();
  if (!d || d.schedule.length === 0) return null;
  const nowMin = now && d.isToday ? now.getHours() * 60 + now.getMinutes() : -1;
  const items = d.schedule.map((s) => ({ ...s, min: parseHHMM(s.time) }));
  // current block = latest item that has started
  let currentIdx = -1;
  if (nowMin >= 0) {
    for (let i = 0; i < items.length; i++) {
      if (items[i].min >= 0 && items[i].min <= nowMin) currentIdx = i;
    }
  }
  const ageDays = d.isToday ? 0 : noteAgeDays(d.date);
  return (
    <section
      className={`block boot-stagger ${d.isToday ? "" : "note-stale"} ${hot ? "voice-hot" : ""}`}
      style={{ animationDelay: "0.34s" }}
    >
      <SectionTitle
        title="Timeline"
        tick={d.isToday ? "TODAY" : `${ageDays}D OLD`}
        href="https://calendar.google.com/calendar/u/0/r/day"
      />
      <div className="sched">
        {items.map((s, i) => (
          <div
            key={`${s.time}-${i}`}
            className={`sched-row ${i === currentIdx ? "now" : ""} ${
              currentIdx >= 0 && i < currentIdx ? "past" : ""
            }`}
          >
            <span className="t">{s.time}</span>
            <span className="i">{s.item}</span>
            {i === currentIdx && <span className="now-tag">NOW</span>}
          </div>
        ))}
      </div>
      {d.focus && <div className="focus-line">focus · {d.focus}</div>}
    </section>
  );
});

// State-picked directive: a fresh upload (<48h) takes the board as a live
// velocity battle; otherwise the long campaign — road to the NEXT subscriber
// milestone, with the projected arrival date from the real weekly delta.
