// expectGolden(name, value) — compare a serialized value against
// tests/golden/<name>.golden.txt.
//
// Rules:
//   * UPDATE_GOLDEN=1      creates MISSING goldens only. An existing golden
//                          whose content would change makes the run FAIL —
//                          goldens capture the behavior of the code that
//                          existed before the refactor and must not drift.
//   * UPDATE_GOLDEN=force  overwrites. Only for an intentional behavior change.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { FIXTURE_ROOT } from "./env";
import { FIXTURE_IDS } from "./fixtureVault";

const GOLDEN_DIR = path.resolve(process.cwd(), "tests", "golden");
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export function serialize(value: unknown): string {
  if (typeof value === "string") return value.endsWith("\n") ? value : value + "\n";
  return JSON.stringify(value, null, 2) + "\n";
}

/** Strip the two things that legitimately vary run to run: the tmp fixture
 *  path and freshly generated UUIDs (fixture ids are kept verbatim). */
export function normalize(s: string): string {
  return s
    .replace(/\r\n/g, "\n")
    .split(FIXTURE_ROOT)
    .join("<VAULT>")
    .replace(UUID_RE, (m) => (FIXTURE_IDS.has(m.toLowerCase()) ? m : "<UUID>"));
}

function lineDiff(expected: string, actual: string, max = 40): string {
  const a = expected.split("\n");
  const b = actual.split("\n");
  const out: string[] = [];
  const n = Math.max(a.length, b.length);
  let shown = 0;
  for (let i = 0; i < n && shown < max; i++) {
    if (a[i] === b[i]) continue;
    if (shown === 0 && i > 0) out.push(`  ${i}: ${a[i - 1] ?? ""}`);
    if (a[i] !== undefined) out.push(`- ${i + 1}: ${a[i]}`);
    if (b[i] !== undefined) out.push(`+ ${i + 1}: ${b[i]}`);
    shown++;
  }
  if (shown >= max) out.push("  … (more differences)");
  return out.join("\n");
}

export function goldenPath(name: string): string {
  return path.join(GOLDEN_DIR, `${name}.golden.txt`);
}

export function expectGolden(name: string, value: unknown): void {
  const file = goldenPath(name);
  const actual = normalize(serialize(value));
  const mode = process.env.UPDATE_GOLDEN ?? "";
  const exists = fs.existsSync(file);

  if (mode === "force" || (mode === "1" && !exists)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, actual, "utf-8");
    return;
  }
  if (!exists) {
    assert.fail(`missing golden "${name}" — run once with UPDATE_GOLDEN=1 to capture it`);
  }
  const expected = fs.readFileSync(file, "utf-8").replace(/\r\n/g, "\n");
  if (actual !== expected) {
    assert.fail(
      `golden mismatch: ${name}\n(${file})\n${lineDiff(expected, actual)}\n` +
        (mode === "1"
          ? "UPDATE_GOLDEN=1 does not overwrite an existing golden. If this behavior change is INTENDED, use UPDATE_GOLDEN=force."
          : "")
    );
  }
}
