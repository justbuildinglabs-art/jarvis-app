import { NextResponse } from "next/server";

// Shared HTTP conventions for the API routes.
//
// Eight routes were each spelling out the same four things: parse a JSON body
// and turn a syntax error into a 400, phrase an error body as {error}, mark a
// response uncacheable, and turn a thrown VoiceConfigError into a 503. Those
// are conventions, not logic, and having them written eight times meant they
// could drift — one route answering {error} where another answered {ok,error}
// is the kind of difference nobody notices until a client breaks on it.

// NOTE: `export const dynamic` is NOT shared from here. Next statically
// analyses route segment config at build time and rejects an imported
// identifier ("Unknown identifier DYNAMIC"), so each route declares its own
// literal. Everything below is ordinary runtime code and shares fine.

export function ok<T extends Record<string, unknown>>(body: T, init?: ResponseInit) {
  return NextResponse.json(body, init);
}

/** An error body, in the one shape every route uses: {error: "..."}. */
export function fail(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

/** Read a JSON body, or null when it is absent or unparseable.
 *  Callers decide what a missing body means — usually a 400. */
export async function readJsonBody<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

/** A JSON response the browser must not cache — the vault changes underneath. */
export function fresh<T extends Record<string, unknown>>(body: T) {
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}

/** 503 in the {ok:false, error} shape the voice client's probe expects.
 *  Used where the voice stack isn't configured — a setup problem, not a
 *  bad request, and the client disables itself rather than retrying. */
export function unavailable(message: string) {
  return NextResponse.json({ ok: false, error: message }, { status: 503 });
}
