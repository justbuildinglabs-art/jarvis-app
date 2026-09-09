"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { VaultState, Metric } from "@/lib/vault";
import { voice } from "@/lib/voiceClient";
import { BG_MODES, type BgMode, type CoreMode } from "./GraphCore";
import ReportOverlay from "./ReportOverlay";

import { fmt, fmtFull, fmtAge, fmtDur, fmtClock, noteAgeDays, findMetric } from "./hud/format";
import { useVaultState, useClock } from "./hud/hooks";
import { CountUp, Sparkline, SectionTitle } from "./hud/atoms";
import { nowHHMMSS, runAnnouncement, type FeedLine } from "./hud/feed";
import { Vitals, VitalLabel, SOCIAL_DEFS } from "./hud/panels/Vitals";
import { CommandDeck, DECK_SKILLS } from "./hud/panels/CommandDeck";
import { VoiceWave, WAVE_BARS } from "./hud/panels/VoiceWave";
import { Priorities } from "./hud/panels/Priorities";
import { Documents } from "./hud/panels/Documents";
import { Wire } from "./hud/panels/Wire";
import { CompassRing } from "./hud/panels/CompassRing";
import { Schedule, parseHHMM } from "./hud/panels/Schedule";
import {
  Objective,
  MILESTONES,
  MRR_MILESTONES,
  LIVE_DEPLOY_H,
  nextMilestone,
  nextMrrMilestone,
} from "./hud/panels/Objective";
import { TopBar } from "./hud/panels/TopBar";

const GraphCore = dynamic(() => import("./GraphCore"), { ssr: false });

// ---------------------------------------------------------------------------
// The HUD root.
//
// This file used to be 1,400 lines holding every panel, every formatter and
// every effect. The panels now live in ./hud/panels/, the shared pieces in
// ./hud/, and what is left here is the part that could not be split: the
// state the panels read, and the effects that connect the vault, the voice
// client and the callout cards to each other.
//
// The callouts are the interesting bit. A run's card appears beside the core
// while it works and morphs IN PLACE into its document card when it lands, so
// the eye follows one object rather than watching one disappear and another
// appear. Effect ORDER is load-bearing there and is noted where it matters.
// ---------------------------------------------------------------------------

const MODE_KEYS: Record<string, CoreMode> = {
  "1": "idle",
  "2": "working",
  "3": "listening",
  "4": "speaking",
  "5": "error",
};

export default function HUD() {
  const { state, error, refresh } = useVaultState(5000);
  const [feed, setFeed] = useState<FeedLine[]>([]);
  const [modeOverride, setModeOverride] = useState<CoreMode | null>(null);
  const [bgMode, setBgMode] = useState<BgMode>("depth");
  const [voiceSpeaking, setVoiceSpeaking] = useState(false);
  const [ptt, setPtt] = useState(false);
  const [wakeListening, setWakeListening] = useState(false);
  const [hotPanels, setHotPanels] = useState<string[]>([]);
  // report reveal: callouts = cards branching off the core (max 4 anchor
  // slots around the orb — same hairline language). kind "doc" opens the
  // overlay, kind "link" opens the source in a new tab, kind "task" is a
  // live run (elapsed / ~eta progress) that morphs into its doc card on
  // completion — target stays `run:<id>` until the morph swaps it.
  const [callouts, setCallouts] = useState<
    {
      id: number;
      kind: "doc" | "link" | "task";
      target: string;
      label: string;
      slot: number;
      startedAt?: number;
      etaS?: number | null;
      phase?: "working" | "done" | "failed";
    }[]
  >([]);
  const calloutSeq = useRef(0);
  const addCallout = useCallback(
    (target: string, label: string, kind: "doc" | "link" = "doc") => {
      setCallouts((cur) => {
        if (cur.some((c) => c.target === target)) return cur; // already on screen
        const used = new Set(cur.map((c) => c.slot));
        const free = [0, 1, 2, 3].find((s) => !used.has(s));
        const entry = { id: ++calloutSeq.current, kind, target, label };
        // all four slots taken → oldest card yields its slot, but never a
        // live task (its run is still going — evicting it hides real work)
        if (free === undefined) {
          const victim = cur.find((c) => !(c.kind === "task" && c.phase === "working")) ?? cur[0];
          return [...cur.filter((c) => c !== victim), { ...entry, slot: victim.slot }];
        }
        return [...cur, { ...entry, slot: free }];
      });
    },
    []
  );
  const [report, setReport] = useState<{ path: string; content: string } | null>(null);
  const reportOpenRef = useRef(false);
  reportOpenRef.current = report !== null;
  const seenRunsRef = useRef<Set<string>>(new Set());
  const spokenRunsRef = useRef<Set<string>>(new Set());

  const pushLine = useCallback((cls: string, text: string) => {
    setFeed((f) => [...f.slice(-30), { ts: nowHHMMSS(), cls, text }]);
  }, []);

  const openReport = useCallback(
    async (path: string) => {
      try {
        const res = await fetch(`/api/report?path=${encodeURIComponent(path)}`);
        if (!res.ok) throw new Error(String(res.status));
        const j = (await res.json()) as { path: string; content: string };
        setReport(j);
      } catch {
        pushLine("err", `couldn't open ${path}`);
      }
    },
    [pushLine]
  );

  // bottom-left TRANSCRIPT button — the voice conversation so far, rendered
  // in the same overlay as reports (memory.jsonl survives reloads, so this
  // shows exchanges from before the page opened too)
  const openTranscript = useCallback(async () => {
    try {
      const res = await fetch("/api/transcript", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      setReport((await res.json()) as { path: string; content: string });
    } catch {
      pushLine("err", "couldn't load transcript");
    }
  }, [pushLine]);

  const toggleDirective = useCallback(
    async (index: number, done: boolean) => {
      try {
        const res = await fetch("/api/daily", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ index, done }),
        });
        if (!res.ok) throw new Error(String(res.status));
        await refresh();
      } catch {
        pushLine("err", "directive update failed");
      }
    },
    [refresh, pushLine]
  );

  // ?demo=callouts — seed the doc callouts on demand (filming + layout checks)
  useEffect(() => {
    if (!window.location.search.includes("demo=callouts")) return;
    const seeds: [string, string][] = [
      ["inbox/reports/morning/demo-morning.md", "morning report"],
      ["inbox/voice/demo-voice-ask.md", "voice ask"],
      ["inbox/reports/trend-scan/demo-scan.md", "trend scan"],
      ["inbox/reports/inbox-briefs/demo-inbox.md", "inbox brief"],
    ];
    const timers = seeds.map(([p, l], i) => setTimeout(() => addCallout(p, l), 800 + i * 1400));
    return () => timers.forEach(clearTimeout);
  }, [addCallout]);

  // ?demo=taskwork — full task-callout lifecycle without queueing real runs:
  // two tasks spawn (one with eta, one indeterminate). First fills toward its
  // 10s median, runs OVERDUE at 10s (bar degrades to sweep), completes at 16s
  // and morphs into its doc card; the second fails at 22s
  useEffect(() => {
    if (!window.location.search.includes("demo=taskwork")) return;
    const seed = (label: string, etaS: number | null, slot: number) => ({
      id: ++calloutSeq.current,
      kind: "task" as const,
      target: `run:demo-${slot}`,
      label,
      startedAt: Date.now(),
      etaS,
      phase: "working" as const,
      slot,
    });
    const timers = [
      setTimeout(() => setCallouts((c) => [...c, seed("ai trend scan", 10, 0)]), 800),
      setTimeout(() => setCallouts((c) => [...c, seed("inbox brief", null, 1)]), 2600),
      setTimeout(
        () =>
          setCallouts((cur) =>
            cur.map((c) =>
              c.target === "run:demo-0"
                ? {
                    ...c,
                    kind: "doc" as const,
                    target: "inbox/reports/trend-scan/demo-scan.md",
                    phase: undefined,
                  }
                : c
            )
          ),
        16000
      ),
      setTimeout(
        () =>
          setCallouts((cur) =>
            cur.map((c) =>
              c.target === "run:demo-1" ? { ...c, phase: "failed" as const } : c
            )
          ),
        22000
      ),
    ];
    return () => timers.forEach(clearTimeout);
  }, []);

  // voice link — P1: Jarvis speaks, no mic
  useEffect(() => {
    voice.init();
    voice.onLog(pushLine);
    voice.onPanels(setHotPanels);
    voice.onDeliverable((path, label) => addCallout(path, label));
    voice.onReveal((r) => addCallout(r.target, r.label, r.kind)); // sequenced to speech
    voice.onOpenDoc((path) => void openReport(path)); // "bring up the html" → overlay now
    voice.onListening(setWakeListening); // P4: hands-free wake window
    return voice.onSpeaking(setVoiceSpeaking);
  }, [pushLine, openReport, addCallout]);

  // P3 choreography — highlights arrive with the reply and live for the
  // duration of speech; the grace window covers the response→playback gap
  // (and ends the glow if TTS never starts)
  useEffect(() => {
    if (voiceSpeaking || hotPanels.length === 0) return;
    const id = setTimeout(() => setHotPanels([]), 2000);
    return () => clearTimeout(id);
  }, [voiceSpeaking, hotPanels]);

  // P2 — push-to-talk: hold Space to record, release to send
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat) return;
      e.preventDefault();
      void voice.startCapture().then((ok) => {
        if (ok) setPtt(true);
      });
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      e.preventDefault();
      setPtt(false);
      void voice.finishCapture();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  // demo mode keys: 1 idle / 2 working / 3 listening / 4 speaking / 5 error, 0|Esc auto
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key in MODE_KEYS) {
        setModeOverride(MODE_KEYS[e.key]);
        pushLine("sys", `core mode override → ${MODE_KEYS[e.key].toUpperCase()}`);
      } else if (e.key === "Escape") {
        // overlay open → Esc closes it and does nothing else
        if (reportOpenRef.current) {
          setReport(null);
          return;
        }
        if (voice.stop()) pushLine("sys", "voice — stopped");
        setModeOverride(null);
      } else if (e.key === "0") {
        setModeOverride(null);
        pushLine("sys", "core mode → AUTO");
      } else if (e.key === "b" || e.key === "B") {
        setBgMode((cur) => {
          const next = BG_MODES[(BG_MODES.indexOf(cur) + 1) % BG_MODES.length];
          pushLine("sys", `background → ${next.toUpperCase()}`);
          return next;
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pushLine]);

  // real runs flow into the feed
  useEffect(() => {
    if (!state) return;
    const fresh = state.runs.filter((r) => !seenRunsRef.current.has(r.id));
    if (fresh.length === 0) return;
    [...fresh].reverse().forEach((r) => {
      seenRunsRef.current.add(r.id);
      const cls = r.status === "ok" ? "ok" : r.status === "running" ? "sys" : "err";
      const dur = r.duration_s !== null ? ` · ${fmtDur(r.duration_s)}` : "";
      const text = `run/${r.label ?? r.skill} — ${r.summary || r.status}${dur}`;
      const ts = r.ts_completed
        ? new Date(r.ts_completed).toTimeString().slice(0, 8)
        : nowHHMMSS();
      setFeed((f) => [...f.slice(-30), { ts, cls, text }]);
    });
  }, [state]);

  // task callouts — active runs branch off the core like doc reveals: skill
  // name + elapsed / ~eta bar while the runner works. On completion the card
  // morphs IN PLACE into the deliverable card (same slot, no jump) — this
  // effect must stay ABOVE the speak-completions effect so the morph happens
  // before addCallout's target dedupe sees the deliverable path.
  useEffect(() => {
    if (!state) return;
    setCallouts((cur) => {
      let next = cur;
      for (const r of state.runs) {
        const existing = next.find((c) => c.kind === "task" && c.target === `run:${r.id}`);
        if (r.status === "running" && !existing) {
          const used = new Set(next.map((c) => c.slot));
          const free = [0, 1, 2, 3].find((s) => !used.has(s));
          const entry = {
            id: ++calloutSeq.current,
            kind: "task" as const,
            target: `run:${r.id}`,
            label: r.label ?? r.skill.replace(/-/g, " "),
            startedAt: r.ts_started ? Date.parse(r.ts_started) : Date.now(),
            etaS: state.etas[r.skill] ?? null,
            phase: "working" as const,
            slot: 0,
          };
          if (free === undefined) {
            // same eviction rule as addCallout: oldest non-working card yields
            const victim =
              next.find((c) => !(c.kind === "task" && c.phase === "working")) ?? next[0];
            next = [...next.filter((c) => c !== victim), { ...entry, slot: victim.slot }];
          } else {
            next = [...next, { ...entry, slot: free }];
          }
        } else if (existing && existing.phase === "working" && r.status !== "running") {
          next =
            r.status === "ok" && r.deliverable_path
              ? next.map((c) =>
                  c === existing
                    ? {
                        ...c,
                        kind: (r.link ? "link" : "doc") as "link" | "doc",
                        target: r.link ?? r.deliverable_path!,
                        phase: undefined,
                      }
                    : c
                )
              : next.map((c) =>
                  c === existing
                    ? { ...c, phase: r.status === "ok" ? ("done" as const) : ("failed" as const) }
                    : c
                );
        }
      }
      return next;
    });
  }, [state]);

  // ok-but-no-deliverable tasks flash COMPLETE, then clear themselves
  useEffect(() => {
    if (!callouts.some((c) => c.phase === "done")) return;
    const id = setTimeout(
      () => setCallouts((cur) => cur.filter((c) => c.phase !== "done")),
      6000
    );
    return () => clearTimeout(id);
  }, [callouts]);

  // 1s re-render while a task works — elapsed + bar width derive from Date.now()
  const taskWorking = callouts.some((c) => c.kind === "task" && c.phase === "working");
  const [, setTaskTick] = useState(0);
  useEffect(() => {
    if (!taskWorking) return;
    const id = setInterval(() => setTaskTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [taskWorking]);

  // speak completions — separate from the feed diff: a run can first appear
  // as "running" (id lands in seenRunsRef), so completion is tracked by id
  // here, only once it reaches a terminal status. First snapshot seeds
  // silently — no replaying history out loud on page load.
  const runsPrimedRef = useRef(false);
  useEffect(() => {
    if (!state) return;
    const done = state.runs.filter(
      (r) => (r.status === "ok" || r.status === "error") && !spokenRunsRef.current.has(r.id)
    );
    if (!runsPrimedRef.current) {
      runsPrimedRef.current = true;
      done.forEach((r) => spokenRunsRef.current.add(r.id));
      return;
    }
    done.forEach((r) => {
      spokenRunsRef.current.add(r.id);
      voice.speak(runAnnouncement(r.skill, r.status, r.summary ?? "", r.label));
      // finished run left a document → offer it via the reveal chip. When
      // the run's REAL output lives at a URL (Gmail draft, video), the
      // callout sends you THERE — the md stays in the Documents trail.
      if (r.status === "ok" && r.deliverable_path) {
        addCallout(
          r.link ?? r.deliverable_path,
          r.label ?? r.skill.replace(/-/g, " "),
          r.link ? "link" : "doc"
        );
      }
    });
  }, [state]);

  const onQueued = useCallback(
    (skill: string, ok: boolean) => {
      pushLine(ok ? "sys" : "err", ok ? `intent queued → ${skill}` : `queue write FAILED → ${skill}`);
    },
    [pushLine]
  );

  // auto mode: fetch error → error; PTT held or wake window open → listening;
  // voice playing → speaking (orb mouths it, even mid-work); runner busy →
  // working; else idle
  const autoMode: CoreMode = error
    ? "error"
    : ptt || wakeListening
      ? "listening"
      : voiceSpeaking
        ? "speaking"
        : state?.runner?.busy
          ? "working"
          : "idle";
  const mode = modeOverride ?? autoMode;

  return (
    <main className="stage">
      <div className="bg-grid" aria-hidden="true" />
      <GraphCore mode={mode} bgMode={bgMode} getLevel={voice.getLevel} />
      <CompassRing />
      <VoiceWave mode={mode} />

      <div className="scrim scrim-l" aria-hidden="true" />
      <div className="scrim scrim-r" aria-hidden="true" />
      <div className="scrim scrim-b" aria-hidden="true" />
      <div className="scrim scrim-t" aria-hidden="true" />

      <div className="hud">
        <TopBar state={state} online={!error} mode={mode} />

        {/* sides swapped: command/schedule/audio/wire ride the LEFT rail,
            vitals/directives/documents the RIGHT */}
        <div className="hud-left">
          <CommandDeck
            state={state}
            hot={hotPanels.includes("pipeline") || hotPanels.includes("diagnostics")}
            onQueued={onQueued}
          />
          {state && <Schedule state={state} hot={hotPanels.includes("schedule")} />}
          {state && <Wire state={state} onOpen={openReport} />}
        </div>

        <div className="hud-center">
          {callouts.map((c) => {
            const isTask = c.kind === "task";
            const elapsed =
              isTask && c.startedAt ? Math.max(0, Math.floor((Date.now() - c.startedAt) / 1000)) : 0;
            // ETA is silent: bar fills toward the median (capped at 95 — never
            // claim done before the run lands), and once elapsed passes it the
            // bar degrades to the indeterminate sweep instead of parking at a
            // number it promised. Text never states the estimate.
            const overdue = c.etaS != null && elapsed >= c.etaS;
            const pct = isTask && c.etaS && !overdue ? Math.min(95, (elapsed / c.etaS) * 100) : null;
            return (
              <div key={c.id} className={`callout slot-${c.slot}`}>
                <i className="br br-a" aria-hidden="true" />
                <i className="br br-b" aria-hidden="true" />
                <div
                  className={`callout-box${isTask ? ` task ${c.phase ?? ""}` : ""}`}
                  {...(!isTask && {
                    role: "button",
                    tabIndex: 0,
                    onClick: () =>
                      c.kind === "link"
                        ? window.open(c.target, "_blank", "noopener")
                        : void openReport(c.target),
                  })}
                >
                  <span className="callout-dot" />
                  <span className="callout-text">
                    <span className="callout-label">{c.label}</span>
                    {isTask ? (
                      <span className="task-meta">
                        <span className={`task-bar${pct === null && c.phase === "working" ? " indet" : ""}`}>
                          <i
                            style={
                              c.phase !== "working"
                                ? { width: "100%" }
                                : pct !== null
                                  ? { width: `${pct}%` }
                                  : undefined
                            }
                          />
                        </span>
                        <span className="task-time">
                          {c.phase === "working"
                            ? `${fmtClock(elapsed)} · working`
                            : c.phase === "failed"
                              ? `failed · ${fmtClock(elapsed)}`
                              : `complete · ${fmtClock(elapsed)}`}
                        </span>
                      </span>
                    ) : (
                      <span className="callout-file">
                        {c.kind === "link"
                          ? c.target.replace(/^https?:\/\/(www\.)?/, "").split("/")[0] + " ↗"
                          : c.target.split("/").pop()}
                      </span>
                    )}
                  </span>
                  <button
                    className="callout-x"
                    aria-label="dismiss"
                    onClick={(e) => {
                      e.stopPropagation();
                      setCallouts((cur) => cur.filter((x) => x.id !== c.id));
                    }}
                  >
                    ×
                  </button>
                </div>
              </div>
            );
          })}
          {callouts.length > 1 && (
            <button className="callout-clear" onClick={() => setCallouts([])}>
              clear all ×{callouts.length}
            </button>
          )}
        </div>

        <div className="hud-right">
          {state && <Vitals state={state} hot={hotPanels.includes("vitals")} />}
          {state && (
            <Priorities
              state={state}
              hot={hotPanels.includes("priorities")}
              onToggle={toggleDirective}
            />
          )}
          {state && (
            <Documents state={state} hot={hotPanels.includes("documents")} onOpen={openReport} />
          )}
        </div>

        <div className="hud-bottom">
          {state && <Objective state={state} hot={hotPanels.includes("objective")} />}
        </div>

        <button className="transcript-btn" onClick={() => void openTranscript()}>
          Transcript
        </button>

        <div className="ptt-hint">
          hold <b>SPACE</b> to talk · <b>ESC</b> to stop
        </div>
      </div>

      {report && (
        <ReportOverlay
          report={report}
          onClose={() => setReport(null)}
          action={
            report.path === "system/voice/transcript"
              ? {
                  label: "reset transcript ×",
                  onClick: () => {
                    void fetch("/api/transcript", { method: "DELETE" }).then(() => {
                      setReport(null);
                      pushLine("sys", "voice transcript cleared");
                    });
                  },
                }
              : undefined
          }
        />
      )}

      <div className="grain" aria-hidden="true" />
    </main>
  );
}

// --- test seams ---------------------------------------------------------------
// Re-exported so the golden suite keeps one import site for the HUD's surface
// even though the implementation now lives in ./hud/.
export { fmt, fmtFull, fmtAge, fmtDur, fmtClock, noteAgeDays, findMetric } from "./hud/format";
export { CountUp, Sparkline, SectionTitle } from "./hud/atoms";
export { nowHHMMSS, runAnnouncement } from "./hud/feed";
export { Vitals, VitalLabel, SOCIAL_DEFS } from "./hud/panels/Vitals";
export { CommandDeck, DECK_SKILLS } from "./hud/panels/CommandDeck";
export { VoiceWave, WAVE_BARS } from "./hud/panels/VoiceWave";
export { Priorities } from "./hud/panels/Priorities";
export { Documents } from "./hud/panels/Documents";
export { Wire } from "./hud/panels/Wire";
export { CompassRing } from "./hud/panels/CompassRing";
export { Schedule, parseHHMM } from "./hud/panels/Schedule";
export {
  Objective,
  MILESTONES,
  MRR_MILESTONES,
  LIVE_DEPLOY_H,
  nextMilestone,
  nextMrrMilestone,
} from "./hud/panels/Objective";
export { TopBar } from "./hud/panels/TopBar";
export { MODE_KEYS };
