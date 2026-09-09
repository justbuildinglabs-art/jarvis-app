"use client";

import { memo } from "react";
import type { VaultState } from "@/lib/vault";




export const CompassRing = memo(function CompassRing() {
  const C = 500; // viewBox center
  const R = 470; // outer tick ring radius
  const ticks: React.ReactNode[] = [];
  for (let d = 0; d < 360; d += 2) {
    const major = d % 30 === 0;
    const mid = !major && d % 10 === 0;
    const len = major ? 24 : mid ? 14 : 7;
    const a = (d * Math.PI) / 180;
    const sin = Math.sin(a);
    const cos = Math.cos(a);
    ticks.push(
      <line
        key={d}
        x1={C + sin * R}
        y1={C - cos * R}
        x2={C + sin * (R - len)}
        y2={C - cos * (R - len)}
        stroke={
          major
            ? "rgba(255,255,255,0.55)"
            : mid
              ? "rgba(255,255,255,0.3)"
              : "rgba(255,255,255,0.14)"
        }
        strokeWidth={major ? 2 : 1}
      />
    );
  }
  return (
    <svg className="compass" viewBox="0 0 1000 1000" aria-hidden="true">
      <circle cx={C} cy={C} r={R} fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth={1} />
      <circle cx={C} cy={C} r={412} fill="none" stroke="rgba(255,255,255,0.09)" strokeWidth={1} />
      {ticks}
      {Array.from({ length: 12 }, (_, i) => i * 30).map((d) => (
        <g key={d} transform={`rotate(${d} ${C} ${C})`}>
          <text x={C} y={70} textAnchor="middle" className="compass-num">
            {String(d).padStart(3, "0")}
          </text>
        </g>
      ))}
      {[0, 90, 180, 270].map((d) => (
        <g key={d} transform={`rotate(${d} ${C} ${C})`}>
          <polygon
            className={d === 0 ? "cardinal-n" : undefined}
            points={`${C},24 ${C - 7},8 ${C + 7},8`}
            fill="rgba(255,255,255,0.5)"
          />
        </g>
      ))}
      <g className="compass-spin-a">
        <circle
          cx={C}
          cy={C}
          r={483}
          fill="none"
          stroke="rgba(255,255,255,0.2)"
          strokeWidth={4}
          pathLength={360}
          strokeDasharray="58 302"
        />
      </g>
      <g className="compass-spin-b">
        <circle
          cx={C}
          cy={C}
          r={490}
          fill="none"
          stroke="rgba(255,255,255,0.13)"
          strokeWidth={1.5}
          pathLength={360}
          strokeDasharray="24 66"
        />
      </g>
    </svg>
  );
});
