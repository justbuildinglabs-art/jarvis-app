"use client";

import { useEffect, useRef, useState } from "react";
import { fmt, fmtFull } from "./format";

// The small shared pieces every panel builds from.

export function CountUp({ value, full = false }: { value: number; full?: boolean }) {
  const [display, setDisplay] = useState(0);
  const fromRef = useRef(0);
  useEffect(() => {
    const from = fromRef.current;
    if (from === value) {
      setDisplay(value);
      return;
    }
    const start = performance.now();
    const dur = 1400;
    let raf = 0;
    const step = (t: number) => {
      const p = Math.min((t - start) / dur, 1);
      const eased = 1 - Math.pow(1 - p, 4);
      setDisplay(from + (value - from) * eased);
      if (p < 1) raf = requestAnimationFrame(step);
      else fromRef.current = value;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{full ? fmtFull(Math.round(display)) : fmt(display)}</>;
}

// inline sparkline from metric history — real data, no fake bars
export function Sparkline({ points }: { points: number[] }) {
  if (points.length < 2) return <div className="spark spark-flat" />;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const W = 100;
  const H = 16;
  const path = points
    .map((v, i) => {
      const x = (i / (points.length - 1)) * W;
      const y = H - 2 - ((v - min) / range) * (H - 4);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const last = points[points.length - 1];
  const lastY = H - 2 - ((last - min) / range) * (H - 4);
  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <path d={path} fill="none" stroke="currentColor" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
      <circle cx={W} cy={lastY} r="1.8" fill="currentColor" />
    </svg>
  );
}

// section heading — typographic, no box
export function SectionTitle({ title, tick, href }: { title: string; tick?: string; href?: string }) {
  return (
    <div className="sec-title">
      {href ? (
        <a className="sec-link" href={href} target="_blank" rel="noreferrer">
          {title} ↗
        </a>
      ) : (
        <span>{title}</span>
      )}
      {tick && <span className="tick">{tick}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// feed lines (voice transcript + run events)
// ---------------------------------------------------------------------------
