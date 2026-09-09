"use client";

import { memo } from "react";
import type { VaultState } from "@/lib/vault";
import { CountUp, SectionTitle } from "../atoms";
import { findMetric, fmt, fmtFull } from "../format";

// The North Star board — one number, picked by what the vault actually holds.
//
// Three mutually exclusive boards, in priority order: revenue when an MRR
// metric exists (the money is the objective and the audience is a means to
// it), otherwise a launch window while an upload is under 48h old, otherwise
// the long subscriber campaign. Each shows an honest projected date derived
// from the real weekly delta — or no date at all when the delta is flat.

export const MILESTONES = [100_000, 250_000, 500_000, 1_000_000, 2_000_000];
export const nextMilestone = (subs: number) =>
  MILESTONES.find((m) => m > subs) ?? Math.ceil(subs / 1_000_000 + 1) * 1_000_000;
export const LIVE_DEPLOY_H = 48;

// revenue ladder — the board's headline when an MRR metric exists
export const MRR_MILESTONES = [10_000, 25_000, 50_000, 100_000, 250_000, 500_000];
export const nextMrrMilestone = (mrr: number) =>
  MRR_MILESTONES.find((m) => m > mrr) ?? Math.ceil(mrr / 500_000 + 1) * 500_000;

export const Objective = memo(function Objective({ state, hot }: { state: VaultState; hot?: boolean }) {
  const subs = findMetric(state.metrics, "youtube", "subscribers");
  const mrr = findMetric(state.metrics, "stripe", "mrr");
  const v = state.latestVideo;

  const ageH = v?.published_at ? (Date.now() - Date.parse(v.published_at)) / 3_600_000 : null;
  // revenue, when tracked, is the standing directive — a fresh upload no
  // longer takes the board out from under it
  const liveDeploy =
    !mrr && v !== null && ageH !== null && ageH >= 0 && ageH <= LIVE_DEPLOY_H;

  const deployLine = v && (
    <div className="video-title">
      latest deploy ·{" "}
      <a href={v.url} target="_blank" rel="noreferrer">
        <b>{v.title}</b>
      </a>{" "}
      — {fmtFull(v.views)} views
    </div>
  );

  if (liveDeploy && v) {
    const days = Math.max(ageH! / 24, 0.25);
    const perDay = Math.round(v.views / days);
    const windowPct = Math.min((ageH! / LIVE_DEPLOY_H) * 100, 100);
    return (
      <section className={`objective boot-stagger ${hot ? "voice-hot" : ""}`} style={{ animationDelay: "0.58s" }}>
        <div className="obj-label">North Star · Launch Window</div>
        <div className="big">
          <CountUp value={v.views} full />
          <span className="unit">VIEWS</span>
        </div>
        <div className="progress">
          <i style={{ width: `${windowPct}%` }} />
        </div>
        <div className="sub">
          <span>
            velocity <b>{fmtFull(perDay)}/day</b>
          </span>
          <span>
            live <b>{Math.round(ageH!)}h</b>
          </span>
          <span>
            spotlight <b>{Math.max(LIVE_DEPLOY_H - Math.round(ageH!), 0)}h left</b>
          </span>
        </div>
        {deployLine}
      </section>
    );
  }

  // revenue outranks the subscriber campaign when an MRR reading exists —
  // the money is the directive, the audience is a means to it
  if (mrr) {
    const mTarget = nextMrrMilestone(mrr.value);
    const mPct = Math.min((mrr.value / mTarget) * 100, 100);
    const mEta =
      mrr.deltaWeek && mrr.deltaWeek > 0
        ? new Date(
            Date.now() + ((mTarget - mrr.value) / mrr.deltaWeek) * 7 * 86_400_000
          ).toLocaleDateString("en-US", { month: "short", year: "numeric" })
        : null;
    return (
      <section className={`objective boot-stagger ${hot ? "voice-hot" : ""}`} style={{ animationDelay: "0.58s" }}>
        <div className="obj-label">North Star · Road to {fmt(mTarget)}</div>
        <div className="big">
          <span className="currency">$</span>
          <CountUp value={mrr.value} full />
          <span className="unit">MRR</span>
        </div>
        <div className="progress">
          <i style={{ width: `${mPct}%` }} />
        </div>
        <div className="sub">
          <span>
            target <b>${fmtFull(mTarget)}</b>
          </span>
          <span>
            this week <b>{mrr.deltaWeek ? `+$${fmtFull(mrr.deltaWeek)}` : "—"}</b>
          </span>
          <span>
            {mEta ? (
              <>
                at this pace <b>{mEta}</b>
              </>
            ) : (
              <b>{mPct.toFixed(1)}%</b>
            )}
          </span>
        </div>
        {deployLine}
      </section>
    );
  }

  const target = subs ? nextMilestone(subs.value) : MILESTONES[0];
  const pct = subs ? Math.min((subs.value / target) * 100, 100) : 0;
  // honest clock: at the current weekly pace, when does the next plaque land?
  const eta =
    subs && subs.deltaWeek && subs.deltaWeek > 0
      ? new Date(
          Date.now() + ((target - subs.value) / subs.deltaWeek) * 7 * 86_400_000
        ).toLocaleDateString("en-US", { month: "short", year: "numeric" })
      : null;
  return (
    <section className={`objective boot-stagger ${hot ? "voice-hot" : ""}`} style={{ animationDelay: "0.58s" }}>
      <div className="obj-label">North Star · Road to {fmt(target)}</div>
      <div className="big">
        {subs ? <CountUp value={subs.value} full /> : "—"}
        <span className="unit">SUBS</span>
      </div>
      <div className="progress">
        <i style={{ width: `${pct}%` }} />
      </div>
      <div className="sub">
        <span>
          target <b>{fmtFull(target)}</b>
        </span>
        <span>
          this week <b>{subs?.deltaWeek ? `+${fmtFull(subs.deltaWeek)}` : "—"}</b>
        </span>
        <span>
          {eta ? (
            <>
              at this pace <b>{eta}</b>
            </>
          ) : (
            <b>{pct.toFixed(1)}%</b>
          )}
        </span>
      </div>
      {deployLine}
    </section>
  );
});
