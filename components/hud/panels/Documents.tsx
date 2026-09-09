"use client";

import { memo } from "react";
import type { VaultState } from "@/lib/vault";
import { SectionTitle } from "../atoms";
import { fmtAge } from "../format";

// Paper Trail — every run that produced a document, newest first.
// The reveal chip beside the core is one-shot; this is the persistent list.

export const Documents = memo(function Documents({
  state,
  hot,
  onOpen,
}: {
  state: VaultState;
  hot?: boolean;
  onOpen: (path: string) => void;
}) {
  const docs: { path: string; skill: string; ts: string | null }[] = [];
  for (const r of state.runs) {
    if (r.status !== "ok" || !r.deliverable_path) continue;
    if (docs.some((d) => d.path === r.deliverable_path)) continue;
    docs.push({ path: r.deliverable_path, skill: r.label ?? r.skill, ts: r.ts_completed });
    if (docs.length >= 5) break;
  }
  if (docs.length === 0) return null;
  return (
    <section className={`block boot-stagger ${hot ? "voice-hot" : ""}`} style={{ animationDelay: "0.26s" }}>
      <SectionTitle title="Paper Trail" tick="LATEST.DROPS" />
      {docs.map((doc) => (
        <div className="doc-row" key={doc.path} role="button" onClick={() => onOpen(doc.path)}>
          <span className="doc-skill">{doc.skill.replace(/-/g, " ")}</span>
          <span className="doc-age">{fmtAge(doc.ts).label}</span>
        </div>
      ))}
    </section>
  );
});

// AI Wire — today's morning-report headlines, click → full report overlay
