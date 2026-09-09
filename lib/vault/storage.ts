import fs from "fs";
import path from "path";
import { VAULT_ROOT } from "../config";

// The only module in lib/vault that talks to the filesystem.
//
// Every reader used to call fs directly and repeat the same two habits: wrap
// in try/catch because a missing file is normal here (a vault with no runs
// yet is a valid vault, not an error), and re-derive the same guards. Those
// habits are now one place, which also means one place to change if the vault
// ever stops being a folder.

/** Read a file, or null if it isn't there / isn't readable. */
export function readText(abs: string): string | null {
  try {
    return fs.readFileSync(abs, "utf-8");
  } catch {
    return null;
  }
}

/** Read and parse JSON, or null on a missing file OR malformed contents —
 *  a half-written run record must never take the dashboard down. */
export function readJson<T>(abs: string): T | null {
  const raw = readText(abs);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function writeText(abs: string, content: string): void {
  fs.writeFileSync(abs, content, "utf-8");
}

export function exists(abs: string): boolean {
  return fs.existsSync(abs);
}

/** Absolute path for a vault-relative one. */
export function vaultPath(...parts: string[]): string {
  return path.join(VAULT_ROOT, ...parts);
}

/** Directory entries, or [] when the directory doesn't exist yet. */
export function listDir(abs: string): string[] {
  try {
    return fs.readdirSync(abs);
  } catch {
    return [];
  }
}

/** Modification time in ms, or 0 when unavailable — callers sort by it. */
export function mtimeMs(abs: string): number {
  try {
    return fs.statSync(abs).mtimeMs;
  } catch {
    return 0;
  }
}

/** *.json in a directory, newest first (or oldest first), absolute paths. */
export function jsonFilesByMtime(dirAbs: string, order: "asc" | "desc" = "desc"): string[] {
  return listDir(dirAbs)
    .filter((f) => f.endsWith(".json"))
    .map((f) => path.join(dirAbs, f))
    .sort((a, b) => (order === "desc" ? mtimeMs(b) - mtimeMs(a) : mtimeMs(a) - mtimeMs(b)));
}

// The dirs runs write into. Runs process untrusted content — emails, web
// pages — so a path that came out of a run record is never followed outside
// these, and never outside the vault.
export const READABLE_PREFIXES = ["inbox/", "system/runs/"];

/**
 * Resolve a vault-relative path for reading, or null if it escapes the
 * allowed area. Backslashes are normalised first so a Windows-style path
 * can't slip past the prefix check.
 */
export function resolveReadable(rel: string, opts: { requireMd?: boolean } = {}): string | null {
  const clean = rel.replace(/\\/g, "/");
  if (opts.requireMd && !clean.endsWith(".md")) return null;
  if (!READABLE_PREFIXES.some((p) => clean.startsWith(p))) return null;
  const abs = path.resolve(VAULT_ROOT, clean);
  if (!abs.startsWith(path.resolve(VAULT_ROOT) + path.sep)) return null; // no traversal
  return abs;
}

export { VAULT_ROOT };
