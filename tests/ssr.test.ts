// SSR characterization — the prerendered HTML Next.js emits for the three
// static pages (/, /lab, /orb), reduced to a structural signature and pinned
// as goldens under tests/golden/ssr/.
//
// READ THIS FIRST: this file does not build anything. It reads
//   .next/server/app/index.html, lab.html, orb.html
// and the build manifests next to them, i.e. the output of the LAST
// `next build` that ran in this checkout. `npm run check` runs `next build`
// FIRST, precisely so these goldens describe the tree that is being gated.
// A build that predates the newest source file would make these goldens
// pass against stale HTML, so the first test below fails on exactly that —
// rebuild (`npm run check`, or `npx next build`) and re-run.
//
// The signature (see `signature()` below) is one line per node:
//   * elements: tag name plus a whitelist of attributes, sorted by name —
//     class (next/font `__className_x`/`__variable_x` tokens masked to
//     `__className_<hash>`/`__variable_<hash>`), role, aria-*, style
//     (verbatim), href/src (query string dropped, `/_next/static/<segment>/`
//     collapsed to `/_next/static/<hash>/`, and any 8+ hex run in the rest
//     of a `/_next/static/` path masked to `<hash>` so chunk/css content
//     hashes never diff), id only when it is not hash-like (React useId
//     shapes `_R_x_`, `:Rx:`, `«Rx»` and 8+ hex runs count as hash-like).
//   * text nodes: trimmed, newlines escaped, whitespace-only dropped, as
//     `#text: …`. React's `<!-- -->` separators split adjacent dynamic text
//     into separate nodes; that split is kept as-is.
//   * comments: only React's Suspense markers (`$`, `/$`, `$!`, `$?`, `$~`)
//     survive as `#comment: …`; every other comment (the build id, the
//     `<!-- -->` separators) is dropped.
//   * dropped entirely: <script> elements and their contents,
//     <link rel=preload as=font>, nonce and data-* attributes.
// Indentation is two spaces per ancestor, so a removed wrapper de-indents
// its whole subtree. A second "all-attrs" flavour keeps every attribute
// (except nonce/data-*) with the same masking — it pins SVG geometry, meta
// tags and the like that the whitelist drops.
import "./_util/env";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { freezeClock, thawClock } from "./_util/clock";
import { buildFixtureVault, destroyFixtureVault } from "./_util/fixtureVault";
import { expectGolden } from "./_util/golden";


// --- build freshness ---------------------------------------------------------
// Every golden below describes the output of a PAST `next build`. If any file
// the build reads is newer than the build itself, the goldens are being
// compared against HTML that no longer corresponds to the source, and a real
// regression would pass silently. Fail loudly instead.
const BUILD_INPUT_DIRS = ["app", "components", "lib", "public"];
const BUILD_INPUT_FILES = ["next.config.mjs", "package.json", "tsconfig.json"];

function newestSourceMtime(): { path: string; mtimeMs: number } {
  let newest = { path: "(none)", mtimeMs: 0 };
  const visit = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        visit(full);
        continue;
      }
      const m = fs.statSync(full).mtimeMs;
      if (m > newest.mtimeMs) newest = { path: full, mtimeMs: m };
    }
  };
  for (const d of BUILD_INPUT_DIRS) visit(path.resolve(process.cwd(), d));
  for (const f of BUILD_INPUT_FILES) {
    const full = path.resolve(process.cwd(), f);
    try {
      const m = fs.statSync(full).mtimeMs;
      if (m > newest.mtimeMs) newest = { path: f, mtimeMs: m };
    } catch {
      /* optional */
    }
  }
  return newest;
}

test("the build these goldens describe is newer than every source it renders", () => {
  const buildId = path.resolve(process.cwd(), ".next", "BUILD_ID");
  assert.ok(
    fs.existsSync(buildId),
    "no .next/BUILD_ID — run `npm run check` (which builds first) before the ssr goldens"
  );
  const builtAt = fs.statSync(buildId).mtimeMs;
  const newest = newestSourceMtime();
  assert.ok(
    builtAt >= newest.mtimeMs,
    `.next/ is STALE: built ${new Date(builtAt).toISOString()} but ${newest.path} changed ` +
      `${new Date(newest.mtimeMs).toISOString()}. These goldens would be compared against ` +
      "HTML that no longer matches the source. Run `npm run check` (builds first) and re-run."
  );
});

before(() => {
  buildFixtureVault();
  freezeClock();
});
after(() => {
  thawClock();
  destroyFixtureVault();
});

// ---------------------------------------------------------------------------
// Build output access
// ---------------------------------------------------------------------------

const NEXT_DIR = path.resolve(process.cwd(), ".next");
const PAGES = ["index", "lab", "orb"] as const;
type PageName = (typeof PAGES)[number];

function readBuilt(rel: string): string {
  const abs = path.join(NEXT_DIR, rel);
  if (!fs.existsSync(abs)) {
    assert.fail(
      `missing build output ${abs}\n` +
        "This suite reads the LAST `next build` and never builds on its own. " +
        "Run `npm run check:full` (or `npx next build`) first, then re-run."
    );
  }
  return fs.readFileSync(abs, "utf-8");
}

const readPageHtml = (page: PageName): string => readBuilt(path.join("server", "app", `${page}.html`));
const readJson = (rel: string): unknown => JSON.parse(readBuilt(rel));

// ---------------------------------------------------------------------------
// HTML tokenizer — deliberately tiny. React SSR output is well-formed, so a
// linear scan that understands comments, doctype, open/close/self-closing
// tags, quoted/unquoted attributes and raw-text elements is enough.
// ---------------------------------------------------------------------------

type RawAttr = { name: string; value: string };
type Tok =
  | { kind: "doctype"; value: string }
  | { kind: "comment"; value: string }
  | { kind: "open"; name: string; attrs: RawAttr[]; selfClosing: boolean }
  | { kind: "close"; name: string }
  | { kind: "text"; value: string };

const RAW_TEXT = new Set(["script", "style", "textarea", "title"]);
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

export function tokenize(html: string): Tok[] {
  const out: Tok[] = [];
  const n = html.length;
  let i = 0;
  const isWs = (c: string | undefined) => c === " " || c === "\n" || c === "\r" || c === "\t" || c === "\f";
  while (i < n) {
    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      out.push({ kind: "comment", value: html.slice(i + 4, end < 0 ? n : end) });
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (html.startsWith("<!", i)) {
      const end = html.indexOf(">", i);
      out.push({ kind: "doctype", value: html.slice(i + 2, end < 0 ? n : end).trim() });
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (html.startsWith("</", i)) {
      const end = html.indexOf(">", i);
      out.push({ kind: "close", name: html.slice(i + 2, end < 0 ? n : end).trim().toLowerCase() });
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (html[i] === "<" && /[A-Za-z]/.test(html[i + 1] ?? "")) {
      let j = i + 1;
      while (j < n && !isWs(html[j]) && html[j] !== "/" && html[j] !== ">") j++;
      const name = html.slice(i + 1, j).toLowerCase();
      const attrs: RawAttr[] = [];
      let selfClosing = false;
      for (;;) {
        while (j < n && isWs(html[j])) j++;
        if (j >= n) break;
        if (html.startsWith("/>", j)) {
          selfClosing = true;
          j += 2;
          break;
        }
        if (html[j] === ">") {
          j++;
          break;
        }
        if (html[j] === "/") {
          j++;
          continue;
        }
        let k = j;
        while (k < n && !isWs(html[k]) && html[k] !== "=" && html[k] !== ">" && html[k] !== "/") k++;
        if (k === j) {
          j++;
          continue;
        }
        const aname = html.slice(j, k);
        j = k;
        while (j < n && isWs(html[j])) j++;
        let value = "";
        if (html[j] === "=") {
          j++;
          while (j < n && isWs(html[j])) j++;
          const q = html[j];
          if (q === '"' || q === "'") {
            const end = html.indexOf(q, j + 1);
            value = html.slice(j + 1, end < 0 ? n : end);
            j = end < 0 ? n : end + 1;
          } else {
            let e = j;
            while (e < n && !isWs(html[e]) && html[e] !== ">") e++;
            value = html.slice(j, e);
            j = e;
          }
        }
        attrs.push({ name: aname, value });
      }
      out.push({ kind: "open", name, attrs, selfClosing });
      i = j;
      if (!selfClosing && RAW_TEXT.has(name)) {
        const m = new RegExp(`</${name}\\s*>`, "i").exec(html.slice(i));
        const rawEnd = m ? i + m.index : n;
        out.push({ kind: "text", value: html.slice(i, rawEnd) });
        out.push({ kind: "close", name });
        i = m ? rawEnd + m[0].length : n;
      }
      continue;
    }
    const next = html.indexOf("<", i + 1);
    out.push({ kind: "text", value: html.slice(i, next < 0 ? n : next) });
    i = next < 0 ? n : next;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Normalizer
// ---------------------------------------------------------------------------

const FONT_CLASS_RE = /__(className|variable)_[a-z0-9]+/g;
const HEX_RUN_RE = /[0-9a-f]{8,}/g;
const REACT_USE_ID_RE = /^(:[Rr][0-9a-z]*:|«[Rr][0-9a-z]*»|_[Rr]_[0-9a-z]*_?)$/;
const SUSPENSE_MARKER_RE = /^\/?\$[!?~]?$/;

export function normalizeUrl(value: string): string {
  const q = value.indexOf("?");
  let u = q >= 0 ? value.slice(0, q) : value;
  if (u.startsWith("/_next/static/")) {
    u = u.replace(/^\/_next\/static\/[^/]+\//, "/_next/static/<hash>/");
    u = u.replace(HEX_RUN_RE, "<hash>");
  }
  return u;
}

export function isHashLikeId(id: string): boolean {
  return REACT_USE_ID_RE.test(id) || /[0-9a-f]{8,}/.test(id);
}

function attrValue(lname: string, value: string): string {
  if (lname === "class") return value.replace(FONT_CLASS_RE, "__$1_<hash>");
  if (lname === "href" || lname === "src") return normalizeUrl(value);
  return value;
}

function keepAttr(lname: string, value: string, allAttrs: boolean): boolean {
  if (lname === "nonce" || lname.startsWith("data-")) return false;
  if (lname === "id") return !isHashLikeId(value);
  if (allAttrs) return true;
  return lname === "class" || lname === "role" || lname === "style" || lname === "href" || lname === "src" || lname.startsWith("aria-");
}

function rawAttr(attrs: RawAttr[], lname: string): string | undefined {
  return attrs.find((a) => a.name.toLowerCase() === lname)?.value;
}

function isFontPreload(tok: Extract<Tok, { kind: "open" }>): boolean {
  return (
    tok.name === "link" &&
    (rawAttr(tok.attrs, "rel") ?? "").toLowerCase() === "preload" &&
    (rawAttr(tok.attrs, "as") ?? "").toLowerCase() === "font"
  );
}

export interface SignatureOptions {
  /** Keep every attribute except nonce/data-* instead of the whitelist. */
  allAttrs?: boolean;
}

/** Turn HTML into a structural signature: one line per node. */
export function signature(html: string, opts: SignatureOptions = {}): string[] {
  const allAttrs = opts.allAttrs === true;
  const lines: string[] = [];
  const stack: string[] = [];
  let dropping: string | null = null; // inside a dropped raw-text element
  const indent = () => "  ".repeat(stack.length);

  for (const tok of tokenize(html)) {
    if (dropping) {
      if (tok.kind === "close" && tok.name === dropping) dropping = null;
      continue;
    }
    switch (tok.kind) {
      case "doctype":
        lines.push(`#doctype: ${tok.value.replace(/^doctype\s*/i, "").toLowerCase()}`);
        break;
      case "comment": {
        const v = tok.value.trim();
        if (SUSPENSE_MARKER_RE.test(v)) lines.push(`${indent()}#comment: ${v}`);
        break;
      }
      case "text": {
        const v = tok.value.trim();
        if (v) lines.push(`${indent()}#text: ${v.replace(/\r/g, "").replace(/\n/g, "\\n").replace(/\t/g, "\\t")}`);
        break;
      }
      case "close": {
        const at = stack.lastIndexOf(tok.name);
        if (at >= 0) stack.length = at;
        break;
      }
      case "open": {
        if (tok.name === "script") {
          if (!tok.selfClosing) dropping = "script";
          break;
        }
        if (isFontPreload(tok)) break;
        const kept = tok.attrs
          .map((a) => ({ name: a.name, lname: a.name.toLowerCase(), value: a.value }))
          .filter((a) => keepAttr(a.lname, a.value, allAttrs))
          .map((a) => ({ name: a.name, lname: a.lname, value: attrValue(a.lname, a.value) }))
          .sort((a, b) => (a.lname < b.lname ? -1 : a.lname > b.lname ? 1 : 0));
        lines.push(`${indent()}${tok.name}${kept.map((a) => ` ${a.name}="${a.value}"`).join("")}`);
        if (!tok.selfClosing && !VOID.has(tok.name)) stack.push(tok.name);
        break;
      }
    }
  }
  return lines;
}

export function countStylesheets(html: string): number {
  let n = 0;
  for (const tok of tokenize(html)) {
    if (tok.kind === "open" && tok.name === "link" && (rawAttr(tok.attrs, "rel") ?? "").toLowerCase() === "stylesheet") n++;
  }
  return n;
}

function stats(lines: string[]) {
  let elements = 0;
  let texts = 0;
  let comments = 0;
  let maxDepth = 0;
  for (const l of lines) {
    const depth = (l.length - l.trimStart().length) / 2;
    if (depth > maxDepth) maxDepth = depth;
    const body = l.trimStart();
    if (body.startsWith("#text:")) texts++;
    else if (body.startsWith("#comment:")) comments++;
    else if (!body.startsWith("#doctype:")) elements++;
  }
  return { lines: lines.length, elements, texts, comments, maxDepth };
}

// ---------------------------------------------------------------------------
// Unit tests of the normalizer on a synthetic document. These prove the
// page goldens below mean what they claim: build noise is invisible, while
// a class rename, a removed wrapper, or a changed inline style is a diff.
// ---------------------------------------------------------------------------

const SAMPLE =
  '<!DOCTYPE html><!--BuIlDiD123--><html lang="en"><head><meta charSet="utf-8"/><title>Sample</title>' +
  '<link rel="preload" href="/_next/static/media/0123456789abcdef-s.p.woff2" as="font" crossorigin="" type="font/woff2"/>' +
  '<link rel="stylesheet" href="/_next/static/css/0123456789abcdef.css?v=1" data-precedence="next"/>' +
  '<link rel="preload" as="script" fetchPriority="low" href="/_next/static/chunks/webpack-0123456789abcdef.js"/>' +
  '<script src="/_next/static/chunks/main-app-0123456789abcdef.js" async=""></script>' +
  '<script>self.__next_f.push([1,"<div class=\\"fake\\">"])</script></head>' +
  '<body class="__variable_0d24fa __className_1c9108" nonce="n0nce"><div id="_R_1a_" data-x="1"><!--$-->' +
  '<section id="ops" class="block boot-stagger " style="animation-delay:0.26s" role="region" aria-label="Ops">' +
  "<span>core · <!-- -->idle</span>\n   <br/><img src=\"/img/a.png?w=1\" alt=\"a\"/></section><!--/$--></div>" +
  '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg></body></html>';

const SAMPLE_SIGNATURE = [
  "#doctype: html",
  "html",
  "  head",
  "    meta",
  "    title",
  "      #text: Sample",
  '    link href="/_next/static/<hash>/<hash>.css"',
  '    link href="/_next/static/<hash>/webpack-<hash>.js"',
  '  body class="__variable_<hash> __className_<hash>"',
  "    div",
  "      #comment: $",
  '      section aria-label="Ops" class="block boot-stagger " id="ops" role="region" style="animation-delay:0.26s"',
  "        span",
  "          #text: core ·",
  "          #text: idle",
  "        br",
  '        img src="/img/a.png"',
  "      #comment: /$",
  "    svg",
  "      circle",
];

const SAMPLE_SIGNATURE_ALL_ATTRS = [
  "#doctype: html",
  'html lang="en"',
  "  head",
  '    meta charSet="utf-8"',
  "    title",
  "      #text: Sample",
  '    link href="/_next/static/<hash>/<hash>.css" rel="stylesheet"',
  '    link as="script" fetchPriority="low" href="/_next/static/<hash>/webpack-<hash>.js" rel="preload"',
  '  body class="__variable_<hash> __className_<hash>"',
  "    div",
  "      #comment: $",
  '      section aria-label="Ops" class="block boot-stagger " id="ops" role="region" style="animation-delay:0.26s"',
  "        span",
  "          #text: core ·",
  "          #text: idle",
  "        br",
  '        img alt="a" src="/img/a.png"',
  "      #comment: /$",
  '    svg viewBox="0 0 10 10"',
  '      circle cx="5" cy="5" r="4"',
];

test("normalizer: synthetic document produces the documented signature (both flavours)", () => {
  assert.deepEqual(signature(SAMPLE), SAMPLE_SIGNATURE);
  assert.deepEqual(signature(SAMPLE, { allAttrs: true }), SAMPLE_SIGNATURE_ALL_ATTRS);
  assert.equal(countStylesheets(SAMPLE), 1);
});

test("normalizer: build noise is invisible — hashes, build id, scripts, font preloads, nonce, data-*, query strings, attribute order, useId", () => {
  const noisy = SAMPLE
    .replace("<!--BuIlDiD123-->", "<!--aNoThErBuIlD-->")
    .replace(/0123456789abcdef/g, "fedcba9876543210")
    .replace('data-precedence="next"', 'data-precedence="high" data-extra="yes"')
    .replace("?v=1", "?v=2")
    .replace('<script>self.__next_f.push([1,"<div class=\\"fake\\">"])</script>', '<script nonce="zzz">self.__next_f.push([1,"<p class=\\"other\\">"]);</script>')
    .replace('nonce="n0nce"', 'nonce="changed"')
    .replace("__variable_0d24fa __className_1c9108", "__variable_ffffff __className_000000")
    .replace('id="_R_1a_" data-x="1"', 'data-x="2" id="_R_2b_"')
    .replace('id="ops" class="block boot-stagger " style="animation-delay:0.26s" role="region" aria-label="Ops"', 'aria-label="Ops" role="region" style="animation-delay:0.26s" class="block boot-stagger " id="ops"')
    .replace("?w=1", "?w=99");
  assert.notEqual(noisy, SAMPLE, "the noisy variant must actually differ as raw HTML");
  assert.deepEqual(signature(noisy), SAMPLE_SIGNATURE);
  assert.deepEqual(signature(noisy, { allAttrs: true }), SAMPLE_SIGNATURE_ALL_ATTRS);
});

test("normalizer: a class rename shows up as a diff", () => {
  const renamed = SAMPLE.replace('class="block boot-stagger "', 'class="panel boot-stagger "');
  const sig = signature(renamed);
  assert.notDeepEqual(sig, SAMPLE_SIGNATURE);
  assert.equal(sig.length, SAMPLE_SIGNATURE.length);
  assert.equal(sig[11], '      section aria-label="Ops" class="panel boot-stagger " id="ops" role="region" style="animation-delay:0.26s"');
  // a next/font token rename is NOT a diff (it is a hash) — but a real class
  // token added next to it is.
  assert.deepEqual(signature(SAMPLE.replace("__variable_0d24fa", "__variable_beef01")), SAMPLE_SIGNATURE);
  assert.notDeepEqual(signature(SAMPLE.replace("__variable_0d24fa", "__variable_0d24fa dark")), SAMPLE_SIGNATURE);
});

test("normalizer: a removed wrapper div shows up as a diff and de-indents its subtree", () => {
  // function replacer: a literal "$" in a replacement string is a pattern
  const unwrapped = SAMPLE.replace('<div id="_R_1a_" data-x="1">', "").replace("<!--/$--></div>", () => "<!--/$-->");
  const sig = signature(unwrapped);
  assert.notDeepEqual(sig, SAMPLE_SIGNATURE);
  assert.equal(sig.length, SAMPLE_SIGNATURE.length - 1);
  assert.equal(sig[9], "    #comment: $");
  assert.equal(sig[10], '    section aria-label="Ops" class="block boot-stagger " id="ops" role="region" style="animation-delay:0.26s"');
  assert.equal(sig[11], "      span");
});

test("normalizer: a changed inline style shows up as a diff", () => {
  const restyled = SAMPLE.replace("animation-delay:0.26s", "animation-delay:0.3s");
  const sig = signature(restyled);
  assert.notDeepEqual(sig, SAMPLE_SIGNATURE);
  assert.equal(sig[11], '      section aria-label="Ops" class="block boot-stagger " id="ops" role="region" style="animation-delay:0.3s"');
  // and so does a changed text node
  assert.notDeepEqual(signature(SAMPLE.replace(">idle<", ">busy<")), SAMPLE_SIGNATURE);
});

test("normalizer: url and id helpers behave as documented", () => {
  assert.equal(normalizeUrl("/_next/static/css/b703201ecc5c4611.css"), "/_next/static/<hash>/<hash>.css");
  assert.equal(normalizeUrl("/_next/static/chunks/app/page-a4036bc2762c6d63.js?x=1"), "/_next/static/<hash>/app/page-<hash>.js");
  assert.equal(normalizeUrl("/_next/static/media/06084a2f60b23053-s.p.woff2"), "/_next/static/<hash>/<hash>-s.p.woff2");
  assert.equal(normalizeUrl("/api/state?fresh=1"), "/api/state");
  assert.equal(normalizeUrl("https://example.com/deadbeefdeadbeef.js"), "https://example.com/deadbeefdeadbeef.js");
  assert.equal(isHashLikeId("_R_"), true);
  assert.equal(isHashLikeId("_R_1a_"), true);
  assert.equal(isHashLikeId(":R1a:"), true);
  assert.equal(isHashLikeId("«r2»"), true);
  assert.equal(isHashLikeId("radix-0123456789ab"), true);
  assert.equal(isHashLikeId("ops-board"), false);
  assert.equal(isHashLikeId("main"), false);
});

// ---------------------------------------------------------------------------
// Page goldens — the LAST build's prerendered output.
// ---------------------------------------------------------------------------

for (const page of PAGES) {
  test(`${page}.html structural signature is pinned`, () => {
    expectGolden(`ssr/${page}-signature`, signature(readPageHtml(page)).join("\n"));
  });
  test(`${page}.html all-attribute signature is pinned`, () => {
    expectGolden(`ssr/${page}-signature-all-attrs`, signature(readPageHtml(page), { allAttrs: true }).join("\n"));
  });
}

test("each page links exactly the stylesheet count it did at the last build", () => {
  const counts: Record<string, number> = {};
  for (const page of PAGES) counts[page] = countStylesheets(readPageHtml(page));
  expectGolden("ssr/stylesheet-counts", counts);
});

test("per-page node statistics (elements, texts, suspense markers, depth) are pinned", () => {
  const out: Record<string, ReturnType<typeof stats>> = {};
  for (const page of PAGES) out[page] = stats(signature(readPageHtml(page)));
  expectGolden("ssr/page-stats", out);
});

test("every page shares the same layout shell classes on <body>", () => {
  for (const page of PAGES) {
    const body = signature(readPageHtml(page)).find((l) => l.startsWith("  body"));
    assert.equal(body, '  body class="__variable_<hash> __variable_<hash>"', `${page}: body line`);
  }
});

test("page cache headers written by the prerender (.meta) are pinned", () => {
  const out: Record<string, unknown> = {};
  for (const page of PAGES) out[page] = readJson(path.join("server", "app", `${page}.meta`));
  expectGolden("ssr/page-meta", out);
});

// ---------------------------------------------------------------------------
// Route manifests
// ---------------------------------------------------------------------------

test("app routes (app-path-routes-manifest.json) are pinned", () => {
  const manifest = readJson("app-path-routes-manifest.json") as Record<string, string>;
  const sorted: Record<string, string> = {};
  for (const k of Object.keys(manifest).sort()) sorted[k] = manifest[k];
  expectGolden("ssr/app-routes", sorted);
});

test("prerendered routes (prerender-manifest.json) are pinned", () => {
  const manifest = readJson("prerender-manifest.json") as {
    version: number;
    routes: Record<string, { initialStatus?: number; initialRevalidateSeconds: number | false; srcRoute: string | null; dataRoute: string | null }>;
    dynamicRoutes: Record<string, unknown>;
    notFoundRoutes: string[];
  };
  const routes: Record<string, unknown> = {};
  for (const k of Object.keys(manifest.routes).sort()) {
    const r = manifest.routes[k];
    routes[k] = {
      initialStatus: r.initialStatus ?? null,
      initialRevalidateSeconds: r.initialRevalidateSeconds,
      srcRoute: r.srcRoute,
      dataRoute: r.dataRoute,
    };
  }
  expectGolden("ssr/prerender-routes", {
    version: manifest.version,
    routes,
    dynamicRoutes: Object.keys(manifest.dynamicRoutes).sort(),
    notFoundRoutes: manifest.notFoundRoutes,
  });
});
