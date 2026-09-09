// Last-mile cleanup before a reply is spoken.
//
// Distinct from lib/spokenText.ts, which rewrites MEANING for the phonemizer
// ("$4,200" → "four thousand dollars"). This strips things that should not
// reach a speaker at all: URLs, markdown chrome, and runaway length.

export function sanitize(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[*_`#>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 800); // briefing replies run long; /api/speak caps at 900
}
