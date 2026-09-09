"use client";

import { memo } from "react";
import type { VaultState } from "@/lib/vault";
import type { CoreMode } from "../../GraphCore";
import { useClock } from "../hooks";

// The top bar. The wordmark is retired: the clock anchors the left, status
// rides the right.

export function TopBar({
  state,
  online,
  mode,
}: {
  state: VaultState | null;
  online: boolean;
  mode: CoreMode;
}) {
  const now = useClock();
  const r = state?.runner;
  return (
    // wordmark retired — the clock anchors the top-left, status rides right
    <header className="topbar hud-top boot-stagger" style={{ animationDelay: "0.05s" }}>
      <div className="clock-wrap">
        <div className="clock" suppressHydrationWarning>
          {now
            ? `${String(now.getHours()).padStart(2, "0")}:${String(
                now.getMinutes()
              ).padStart(2, "0")}`
            : "--:--"}
          <span className="sec" suppressHydrationWarning>
            {now ? `:${String(now.getSeconds()).padStart(2, "0")}` : ""}
          </span>
        </div>
        <div className="clock-date" suppressHydrationWarning>
          {now
            ? `${["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"][now.getDay()]} · ${
                ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"][
                  now.getMonth()
                ]
              } ${now.getDate()}`
            : ""}
        </div>
      </div>
      <div className="status-line">
        <span className={`mode-chip mode-${mode}`}>
          <i className="status-dot" /> core · {mode}
        </span>
        <span className={`chip ${online ? "on" : "dead"}`}>
          {online ? "link · online" : "link · LOST"}
        </span>
        <span className={`chip ${r?.alive ? "on" : "dead"}`}>
          runner · {r?.alive ? "alive" : "down"}
        </span>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// root
// ---------------------------------------------------------------------------
