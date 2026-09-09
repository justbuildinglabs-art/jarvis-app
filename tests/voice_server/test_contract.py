"""Characterization tests for the Python voice server (voice-server/).

GOLDENS REGENERATED ONCE, DELIBERATELY (2026-09-09)
---------------------------------------------------
The voice server was split from a single 263-line server.py into an entry
point plus the jarvis_voice package. Sixteen goldens here pinned FILE LAYOUT
rather than behavior — import lists, the module's top-level surface, the
__main__ block, and the source text of statements that now reference named
constants instead of inline magic numbers. Those were regenerated with
UPDATE_GOLDEN=force.

Every regenerated golden was diffed field by field first. No numeric or
boolean value changed anywhere: MAX_SPEAK_CHARS is still 900 at the use site,
MIN_CLIP_BYTES still 1000, the breath still 0.12s / 5760 bytes at 24kHz, the
chunk glue still 60 chars, and all eleven original function definitions are
still defined with the same names, decorators and async-ness. What changed is
which file a thing lives in and, in two places, whether a number appears as a
literal or as the constant that holds it.

Four definitions are NEW, and all four are extractions of code that was
previously inline: setup_dll_path, wake_status, set_loop, warm_models. HERE
gained one os.path.dirname because config.py sits one directory deeper than
server.py did; it resolves to the same voice-server/ directory, which is
asserted by the weights being found there.

The behavior goldens — chunks_of, wav_header, the /health runtime dict, the
handler responses, the whisper and kokoro call kwargs — were NOT forced. They
still pass unchanged, which is the actual evidence that this was a refactor.

Pins the CURRENT observable contract of server.py, wakeword.py,
make_samples.py and ws_probe.py so the structural refactor can be proven
behavior-identical. Standard library only.

Nothing here imports server.py (a module import loads Kokoro + Whisper and
takes ~20s / a lot of RAM), nothing contacts the live server on
127.0.0.1:4871, nothing writes outside tests/golden/ and temp dirs. Every
pin is taken statically via `ast` over the source; the pure and near-pure
pieces (chunks_of, wav_header, the env-parsing assignments, health(),
stt(), speak()'s stream layout, the /events handler, emit_event fan-out,
WakeListener._capture, make_samples' plan + audition page, ws_probe's argv
parsing) are exec'd from their extracted source segments against stand-ins
so the INPUTS they would send to Kokoro / Whisper / the HUD are pinned too.

Run:
  voice-server/.venv/bin/python -m unittest tests/voice_server/test_contract.py -v
Capture goldens (creates missing only; UPDATE_GOLDEN=force overwrites):
  UPDATE_GOLDEN=1 voice-server/.venv/bin/python -m unittest tests/voice_server/test_contract.py
"""
from __future__ import annotations

import ast
import asyncio
import difflib
import io
import json
import math
import os
import py_compile
import re
import struct
import tempfile
import textwrap
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

REPO = Path(__file__).resolve().parents[2]
VOICE_DIR = REPO / "voice-server"
SERVER_PY = VOICE_DIR / "server.py"

# The server used to be one 263-line module. It is now an entry point plus the
# jarvis_voice package beside it, so a pin that looks for a function, a
# decorator or a constant has to look across all of them. These are listed in
# dependency order and concatenated into one parse unit below: the AST pins
# care about WHAT is defined, not which file happens to hold it, and every
# name here is still defined exactly once.
SERVER_PACKAGE = VOICE_DIR / "jarvis_voice"
SERVER_PARTS = (
    SERVER_PACKAGE / "config.py",
    SERVER_PACKAGE / "platform.py",
    SERVER_PACKAGE / "runtime.py",
    SERVER_PACKAGE / "audio.py",
    SERVER_PACKAGE / "events.py",
    SERVER_PACKAGE / "app.py",
    SERVER_PY,
)
WAKEWORD_PY = VOICE_DIR / "wakeword.py"
MAKE_SAMPLES_PY = VOICE_DIR / "make_samples.py"
WS_PROBE_PY = VOICE_DIR / "ws_probe.py"
ALL_PY = (*SERVER_PARTS, WAKEWORD_PY, MAKE_SAMPLES_PY, WS_PROBE_PY)

GOLDEN_DIR = REPO / "tests" / "golden"
NS = "voice_server"
LIVE_PORT = 4871  # the user's live voice-server; never contacted


# ---------------------------------------------------------------- goldens --
# Mirrors tests/_util/golden.ts: strings verbatim (+ trailing newline),
# everything else pretty JSON; UPDATE_GOLDEN=1 creates missing goldens only,
# UPDATE_GOLDEN=force overwrites, otherwise compare and fail with a diff.

def _json_default(o):
    if isinstance(o, (bytes, bytearray, memoryview)):
        return bytes(o).hex()
    if isinstance(o, (set, frozenset)):
        return sorted(o, key=repr)
    if isinstance(o, Path):
        return str(o)
    raise TypeError(f"not golden-serializable: {type(o).__name__}")


def serialize(value) -> str:
    if isinstance(value, str):
        return value if value.endswith("\n") else value + "\n"
    return json.dumps(value, indent=2, ensure_ascii=False, default=_json_default) + "\n"


def normalize(s: str) -> str:
    return s.replace("\r\n", "\n").replace(str(REPO), "<REPO>")


def golden_path(name: str) -> Path:
    return GOLDEN_DIR / f"{name}.golden.txt"


def expect_golden(tc: unittest.TestCase, name: str, value) -> None:
    file = golden_path(name)
    actual = normalize(serialize(value))
    mode = os.environ.get("UPDATE_GOLDEN", "")
    exists = file.exists()
    if mode == "force" or (mode == "1" and not exists):
        file.parent.mkdir(parents=True, exist_ok=True)
        with open(file, "w", encoding="utf-8", newline="\n") as f:
            f.write(actual)
        return
    if not exists:
        tc.fail(f'missing golden "{name}" — run once with UPDATE_GOLDEN=1 to capture it')
    expected = file.read_text(encoding="utf-8").replace("\r\n", "\n")
    if actual != expected:
        diff = "".join(
            difflib.unified_diff(
                expected.splitlines(True), actual.splitlines(True), "expected", "actual", n=2
            )
        )
        hint = (
            "UPDATE_GOLDEN=1 does not overwrite an existing golden. "
            "If this behavior change is INTENDED, use UPDATE_GOLDEN=force."
            if mode == "1"
            else ""
        )
        tc.fail(f"golden mismatch: {name}\n({file})\n{diff}\n{hint}")


class GoldenCase(unittest.TestCase):
    maxDiff = None

    def golden(self, name: str, value) -> None:
        expect_golden(self, f"{NS}/{name}", value)


# -------------------------------------------------------------- ast tools --

class Src:
    """Parsed source of one file plus the lookups every pin uses."""

    def __init__(self, path: Path | tuple[Path, ...]):
        # A tuple means "one logical module split across files" — the parts are
        # concatenated in dependency order and parsed as a unit.
        paths = path if isinstance(path, tuple) else (path,)
        self.path = paths[0]
        self.paths = paths
        self.text = "\n\n".join(p.read_text(encoding="utf-8") for p in paths)
        self.tree = ast.parse(self.text, filename=str(paths[0]))
        self.parent: dict[ast.AST, ast.AST] = {}
        for node in ast.walk(self.tree):
            for child in ast.iter_child_nodes(node):
                self.parent[child] = node

    def seg(self, node) -> str:
        s = ast.get_source_segment(self.text, node)
        assert s is not None, f"no source segment for {node!r}"
        return s

    def stmt(self, node) -> str:
        """exec-able source for a (possibly nested) statement or def."""
        return textwrap.dedent(" " * node.col_offset + self.seg(node))

    def walk(self, kind=None, within=None):
        scope = self.tree if within is None else within
        nodes = [n for n in ast.walk(scope) if kind is None or isinstance(n, kind)]
        return sorted(nodes, key=lambda n: (getattr(n, "lineno", 0), getattr(n, "col_offset", 0)))

    def enclosing(self, node) -> str:
        names = []
        n = self.parent.get(node)
        while n is not None:
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                names.append(n.name)
            n = self.parent.get(n)
        return ".".join(reversed(names)) or "<module>"

    def qualname(self, node) -> str:
        enc = self.enclosing(node)
        return node.name if enc == "<module>" else f"{enc}.{node.name}"

    def inside_with(self, node, ctx_source: str) -> bool:
        n = self.parent.get(node)
        while n is not None:
            if isinstance(n, ast.With) and any(self.seg(i.context_expr) == ctx_source for i in n.items):
                return True
            n = self.parent.get(n)
        return False

    def function(self, dotted: str):
        for n in self.walk((ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            if self.qualname(n) == dotted:
                return n
        raise LookupError(dotted)

    def module_assign(self, name: str) -> ast.Assign:
        for n in self.tree.body:
            if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == name for t in n.targets):
                return n
        raise LookupError(name)

    def calls(self, func_source: str | None = None, attr: str | None = None, within=None):
        out = []
        for n in self.walk(ast.Call, within):
            f = n.func
            if func_source is not None and self.seg(f) != func_source:
                continue
            if attr is not None and not (
                (isinstance(f, ast.Attribute) and f.attr == attr) or (isinstance(f, ast.Name) and f.id == attr)
            ):
                continue
            out.append(n)
        return out

    def call_shape(self, call: ast.Call) -> dict:
        return {
            "in": self.enclosing(call),
            "func": self.seg(call.func),
            "args": [self.seg(a) for a in call.args],
            "kwargs": {kw.arg if kw.arg else "**": self.seg(kw.value) for kw in call.keywords},
        }


# Module constants the server defines, resolved once so a pin can follow a
# NAME back to its VALUE. The refactor replaced several magic numbers at their
# use sites with named constants in jarvis_voice/config.py; the numbers are the
# behavior, the names are not, so pins keep reporting numbers.
def _module_constants() -> dict:
    out: dict = {}
    for part in SERVER_PARTS:
        try:
            tree = ast.parse(part.read_text(encoding="utf-8"))
        except SyntaxError:
            continue
        for n in tree.body:
            if isinstance(n, ast.Assign) and len(n.targets) == 1 and isinstance(n.targets[0], ast.Name):
                try:
                    out[n.targets[0].id] = ast.literal_eval(n.value)
                except Exception:
                    pass
    return out


def literal(node):
    try:
        return ast.literal_eval(node)
    except Exception:
        pass
    # a bare Name that refers to a module constant resolves to its value
    if isinstance(node, ast.Name):
        consts = _module_constants()
        if node.id in consts:
            return consts[node.id]
    return {"<expr>": ast.unparse(node)}


def params(src: Src, fn) -> list:
    a = fn.args
    pos = list(a.posonlyargs) + list(a.args)
    defaults = [None] * (len(pos) - len(a.defaults)) + list(a.defaults)
    out = []
    for arg, d in zip(pos, defaults):
        out.append({
            "name": arg.arg,
            "annotation": src.seg(arg.annotation) if arg.annotation else None,
            "default": src.seg(d) if d is not None else None,
        })
    for arg, d in zip(a.kwonlyargs, a.kw_defaults):
        out.append({
            "name": arg.arg,
            "annotation": src.seg(arg.annotation) if arg.annotation else None,
            "default": src.seg(d) if d is not None else None,
            "kwonly": True,
        })
    if a.vararg:
        out.append({"name": "*" + a.vararg.arg})
    if a.kwarg:
        out.append({"name": "**" + a.kwarg.arg})
    return out


def skeleton(src: Src, fn) -> dict:
    """The behavior-bearing skeleton of a function: tests, loops, locks,
    calls (print excluded), yields/awaits/returns, handled exceptions."""
    return {
        "qualname": src.qualname(fn),
        "async": isinstance(fn, ast.AsyncFunctionDef),
        "decorators": [src.seg(d) for d in fn.decorator_list],
        "params": params(src, fn),
        "ifs": [src.seg(n.test) for n in src.walk((ast.If, ast.IfExp), fn)],
        "loops": [
            (src.seg(n.iter) if isinstance(n, ast.For) else src.seg(n.test))
            for n in src.walk((ast.For, ast.While), fn)
        ],
        "withs": [src.seg(i.context_expr) for n in src.walk(ast.With, fn) for i in n.items],
        "calls": [
            src.seg(n) for n in src.walk(ast.Call, fn)
            if not (isinstance(n.func, ast.Name) and n.func.id == "print")
        ],
        "yields": [src.seg(n.value) for n in src.walk(ast.Yield, fn) if n.value is not None],
        "awaits": [src.seg(n.value) for n in src.walk(ast.Await, fn)],
        "returns": [src.seg(n.value) if n.value is not None else None for n in src.walk(ast.Return, fn)],
        "excepts": [src.seg(h.type) if h.type is not None else "<bare>" for h in src.walk(ast.ExceptHandler, fn)],
        "globals": [name for n in src.walk(ast.Global, fn) for name in n.names],
    }


def routes(src: Src) -> list:
    out = []
    for node in src.tree.body:
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for d in node.decorator_list:
            if (
                isinstance(d, ast.Call)
                and isinstance(d.func, ast.Attribute)
                and isinstance(d.func.value, ast.Name)
                and d.func.value.id == "app"
            ):
                out.append({
                    "decorator": src.seg(d),
                    "method": d.func.attr,
                    "path": literal(d.args[0]) if d.args else None,
                    "handler": node.name,
                    "async": isinstance(node, ast.AsyncFunctionDef),
                    "params": params(src, node),
                })
    return out


def environ_ops(src: Src) -> list:
    """Every os.environ access: get/pop/setdefault with default, [] reads, [] writes."""
    out = []
    for n in src.walk(ast.Call):
        f = n.func
        if isinstance(f, ast.Attribute) and src.seg(f.value) == "os.environ" and f.attr in ("get", "pop", "setdefault"):
            out.append({
                "op": f.attr,
                "key": literal(n.args[0]),
                "default": literal(n.args[1]) if len(n.args) > 1 else "<no default>",
            })
    for n in src.walk(ast.Subscript):
        if src.seg(n.value) == "os.environ":
            if isinstance(n.ctx, ast.Store):
                out.append({"op": "set", "key": literal(n.slice), "value": src.seg(src.parent[n].value)})
            else:
                out.append({"op": "read", "key": literal(n.slice)})
    return sorted(out, key=lambda e: (e["key"], e["op"], json.dumps(e, default=str)))


def dict_shape(src: Src, node: ast.Dict):
    out = {}
    for k, v in zip(node.keys, node.values):
        key = literal(k) if k is not None else "**"
        out[key] = dict_shape(src, v) if isinstance(v, ast.Dict) else src.seg(v)
    return out


def imports_of(src: Src) -> list:
    return [
        {"in": src.enclosing(n), "stmt": src.seg(n)}
        for n in src.walk((ast.Import, ast.ImportFrom))
    ]


def dll_guard(src: Src) -> dict:
    """The Windows-only DLL path setup, wherever it lives.

    It used to be a bare `if hasattr(os, "add_dll_directory")` at module top
    level. It is now the body of setup_dll_path() in jarvis_voice/platform.py,
    guarded by an early return. Both shapes are searched so this pin follows
    the code; what it asserts is unchanged — the guard is keyed on
    add_dll_directory (whose absence IS the not-Windows check), and the body
    adds every nvidia/*/bin to the search path and to PATH.
    """
    for n in ast.walk(src.tree):
        if isinstance(n, ast.If) and "add_dll_directory" in src.seg(n.test):
            return {
                "test": src.seg(n.test),
                "body": [src.seg(s) for s in n.body],
                "orelse": [src.seg(s) for s in n.orelse],
            }
    raise LookupError("dll guard")


SERVER = Src(SERVER_PARTS)
WAKEWORD = Src(WAKEWORD_PY)
MAKE_SAMPLES = Src(MAKE_SAMPLES_PY)
WS_PROBE = Src(WS_PROBE_PY)


# --------------------------------------------------------------- stand-ins --

class _Arr:
    """Just enough of numpy for the extracted code paths (list-backed).
    astype(int16) truncates toward zero like a C cast, as numpy does."""

    def __init__(self, vals):
        self.vals = list(vals)

    def __mul__(self, k):
        return _Arr(v * k for v in self.vals)

    __rmul__ = __mul__

    def __truediv__(self, k):
        return _Arr(v / k for v in self.vals)

    def __pow__(self, p):
        return _Arr(v ** p for v in self.vals)

    def astype(self, dtype):
        if dtype == "int16":
            return _Arr(int(v) for v in self.vals)
        return _Arr(float(v) for v in self.vals)

    def tobytes(self):
        return struct.pack(f"<{len(self.vals)}h", *self.vals)

    def copy(self):
        return _Arr(self.vals)

    def __len__(self):
        return len(self.vals)


class _FakeNp:
    int16 = "int16"
    float32 = "float32"

    @staticmethod
    def clip(a, lo, hi):
        return _Arr(min(max(v, lo), hi) for v in a.vals)

    @staticmethod
    def sqrt(x):
        return math.sqrt(x)

    @staticmethod
    def mean(a):
        return sum(a.vals) / len(a.vals)

    @staticmethod
    def concatenate(arrs):
        return _Arr(v for a in arrs for v in a.vals)


class _FakeResponse:
    def __init__(self, status_code=200, content=None, **extra):
        self.status_code, self.content, self.extra = status_code, content, extra

    def pin(self):
        d = {"kind": "Response", "status_code": self.status_code, "content": self.content}
        if self.extra:
            d["extra"] = self.extra
        return d


class _FakeStreamingResponse:
    def __init__(self, content, media_type=None, headers=None, **extra):
        self.chunks = list(content)  # drain the generator now
        self.media_type, self.headers, self.extra = media_type, headers, extra

    def pin(self):
        return {
            "kind": "StreamingResponse",
            "media_type": self.media_type,
            "headers": self.headers,
            "extra": self.extra,
            "stream": [
                {"len": len(c), "head_hex": c[:48].hex(), "all_zero": not any(c)}
                for c in self.chunks
            ],
        }


class _Clock:
    """time.time() stand-in: starts at `start`, advanced explicitly."""

    def __init__(self, start=0.0, step=0.0):
        self.now, self.step = start, step

    def time(self):
        t = self.now
        self.now += self.step
        return t


def _server_defaults() -> dict:
    """Evaluate server.py's env-derived module constants with an EMPTY
    environment (i.e. their defaults)."""
    ns = {"os": SimpleNamespace(environ={})}
    for name in ("PORT", "VOICE", "SPEED", "SAMPLE_RATE", "WHISPER_MODEL", "WHISPER_PROMPT", "WAKE_ENABLED", "WAKE_THRESHOLD"):
        exec(SERVER.stmt(SERVER.module_assign(name)), ns)
    return {k: v for k, v in ns.items() if k not in ("os", "__builtins__")}


def _limits_ns() -> dict:
    """The plain-literal limits the handlers close over.

    The refactor replaced the magic 900 and 1000 at their use sites with named
    constants in jarvis_voice/config.py. They are not env-derived, so they do
    not belong in _server_defaults(); the handlers still need them in scope.
    """
    ns: dict = {}
    for name in ("MAX_SPEAK_CHARS", "MIN_CLIP_BYTES"):
        exec(SERVER.stmt(SERVER.module_assign(name)), ns)
    return {k: v for k, v in ns.items() if k != "__builtins__"}


def _pure_ns() -> dict:
    ns = {"re": re, "struct": struct}
    exec(SERVER.stmt(SERVER.module_assign("SENTENCE_SPLIT")), ns)
    exec(SERVER.stmt(SERVER.function("chunks_of")), ns)
    exec(SERVER.stmt(SERVER.function("wav_header")), ns)
    return ns


def _wakeword_ns(clock) -> dict:
    ns = {"threading": threading, "time": clock, "np": _FakeNp}
    for n in WAKEWORD.tree.body:
        if isinstance(n, ast.Assign):
            exec(WAKEWORD.stmt(n), ns)
    exec(WAKEWORD.stmt(WAKEWORD.function("WakeListener")), ns)
    return ns


# ============================================================== the tests ==

class GoldenHelper(unittest.TestCase):
    """The Python golden helper must behave like tests/_util/golden.ts."""

    def test_semantics_mirror_golden_ts(self):
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.dict(globals(), {"GOLDEN_DIR": Path(tmp)}):
                name = "x/y"
                # missing + no mode -> fail
                with mock.patch.dict(os.environ, {"UPDATE_GOLDEN": ""}):
                    with self.assertRaisesRegex(AssertionError, "missing golden"):
                        expect_golden(self, name, {"a": 1})
                self.assertFalse(golden_path(name).exists())
                # UPDATE_GOLDEN=1 creates the missing file as pretty JSON
                with mock.patch.dict(os.environ, {"UPDATE_GOLDEN": "1"}):
                    expect_golden(self, name, {"a": 1, "p": str(REPO / "z")})
                self.assertEqual(golden_path(name).read_text(), '{\n  "a": 1,\n  "p": "<REPO>/z"\n}\n')
                # =1 refuses to overwrite a differing golden
                with mock.patch.dict(os.environ, {"UPDATE_GOLDEN": "1"}):
                    with self.assertRaisesRegex(AssertionError, "does not overwrite"):
                        expect_golden(self, name, {"a": 2})
                self.assertEqual(golden_path(name).read_text(), '{\n  "a": 1,\n  "p": "<REPO>/z"\n}\n')
                # match passes; mismatch fails with a diff
                with mock.patch.dict(os.environ, {"UPDATE_GOLDEN": ""}):
                    expect_golden(self, name, {"a": 1, "p": str(REPO / "z")})
                    with self.assertRaisesRegex(AssertionError, r"golden mismatch[\s\S]*-  \"a\": 1[\s\S]*\+  \"a\": 2"):
                        expect_golden(self, name, {"a": 2, "p": str(REPO / "z")})
                # force overwrites; strings are stored verbatim with one trailing newline
                with mock.patch.dict(os.environ, {"UPDATE_GOLDEN": "force"}):
                    expect_golden(self, name, "raw text")
                self.assertEqual(golden_path(name).read_text(), "raw text\n")
                with mock.patch.dict(os.environ, {"UPDATE_GOLDEN": ""}):
                    expect_golden(self, name, "raw text\n")


class Compiles(GoldenCase):
    def test_all_four_modules_byte_compile(self):
        with tempfile.TemporaryDirectory() as tmp:
            for p in ALL_PY:
                py_compile.compile(str(p), cfile=os.path.join(tmp, p.stem + ".pyc"), doraise=True)

    def test_import_surface_per_file_including_lazy_imports(self):
        self.golden("imports", {p.name: imports_of(Src(p)) for p in ALL_PY})


class ServerStatic(GoldenCase):
    """server.py — the FastAPI surface, env keys, constants, call shapes."""

    def test_fastapi_routes_and_handler_signatures(self):
        self.golden("server-routes", routes(SERVER))

    def test_every_os_environ_access_with_its_default(self):
        self.golden("server-environ", environ_ops(SERVER))

    def test_module_constants_expressions_and_literals(self):
        out = {}
        for name in ("HERE", "PORT", "VOICE", "SPEED", "SAMPLE_RATE", "WHISPER_MODEL", "WHISPER_PROMPT", "WAKE_ENABLED", "WAKE_THRESHOLD", "SENTENCE_SPLIT"):
            a = SERVER.module_assign(name)
            entry = {"expr": SERVER.seg(a.value)}
            try:
                entry["literal"] = ast.literal_eval(a.value)
            except Exception:
                pass
            out[name] = entry
        self.golden("server-constants", out)
        self.assertEqual(out["PORT"]["literal"], LIVE_PORT)

    def test_module_constant_defaults_with_empty_environment(self):
        self.golden("server-constants-default-env", _server_defaults())

    def test_whisper_prompt_default_verbatim(self):
        self.golden("server-whisper-prompt", _server_defaults()["WHISPER_PROMPT"])

    def test_sentence_split_pattern_verbatim(self):
        ns = _pure_ns()
        self.golden("server-sentence-split-pattern", {"pattern": ns["SENTENCE_SPLIT"].pattern, "flags": ns["SENTENCE_SPLIT"].flags})

    def test_env_parsing_table_for_wake_word_threshold_speed_voice_model(self):
        def evaluate(env):
            ns = {"os": SimpleNamespace(environ=dict(env))}
            for name in ("VOICE", "SPEED", "WHISPER_MODEL", "WAKE_ENABLED", "WAKE_THRESHOLD"):
                exec(SERVER.stmt(SERVER.module_assign(name)), ns)
            return {k: ns[k] for k in ("VOICE", "SPEED", "WHISPER_MODEL", "WAKE_ENABLED", "WAKE_THRESHOLD")}

        table = {"<unset>": evaluate({})}
        for v in ("on", "off", "0", "false", "FALSE", "Off", "no", "", "1", "true", "yes", " off"):
            table[f"WAKE_WORD={v!r}"] = evaluate({"WAKE_WORD": v})
        for v in ("0.7", "1", " 0.3 ", "1e-1"):
            table[f"WAKE_THRESHOLD={v!r}"] = evaluate({"WAKE_THRESHOLD": v})
        for v in ("1.08", "2"):
            table[f"KOKORO_SPEED={v!r}"] = evaluate({"KOKORO_SPEED": v})
        table["KOKORO_VOICE='am_adam'"] = evaluate({"KOKORO_VOICE": "am_adam"})
        table["WHISPER_MODEL='base'"] = evaluate({"WHISPER_MODEL": "base"})
        errors = {}
        for v in ("abc", ""):
            try:
                evaluate({"WAKE_THRESHOLD": v})
            except Exception as e:
                errors[f"WAKE_THRESHOLD={v!r}"] = f"{type(e).__name__}: {e}"
        try:
            evaluate({"KOKORO_SPEED": "fast"})
        except Exception as e:
            errors["KOKORO_SPEED='fast'"] = f"{type(e).__name__}: {e}"
        self.golden("server-env-parsing", {"table": table, "errors": errors})

    def test_health_return_dict_shape(self):
        ret = SERVER.walk(ast.Return, SERVER.function("health"))
        self.assertEqual(len(ret), 1)
        self.golden("server-health-shape", dict_shape(SERVER, ret[0].value))

    def test_uvicorn_run_kwargs(self):
        calls = SERVER.calls("uvicorn.run")
        self.assertEqual(len(calls), 1)
        shape = SERVER.call_shape(calls[0])
        shape["kwargs_literal"] = {kw.arg: literal(kw.value) for kw in calls[0].keywords}
        self.golden("server-uvicorn-run", shape)

    def test_limits_text_cap_min_clip_bytes_breath_and_glue(self):
        speak = SERVER.function("speak")
        cap_stmt = [n for n in speak.body if isinstance(n, ast.Assign)][0]
        cap_sub = [n for n in ast.walk(cap_stmt.value) if isinstance(n, ast.Subscript)][0]
        stt = SERVER.function("stt")
        min_cmp = [n for n in SERVER.walk(ast.Compare, stt) if "len(audio)" in SERVER.seg(n)][0]
        yields = [SERVER.seg(n.value) for n in SERVER.walk(ast.Yield, speak)]
        breath = yields[-1]
        breath_floats = [n.value for n in ast.walk(ast.parse(breath, mode="eval")) if isinstance(n, ast.Constant) and isinstance(n.value, float)]
        glue = [n for n in SERVER.walk(ast.Compare, SERVER.function("chunks_of")) if "len(cur)" in SERVER.seg(n)][0]
        self.golden("server-limits", {
            "speak_text_cap": {"stmt": SERVER.seg(cap_stmt), "slice_upper": literal(cap_sub.slice.upper)},
            "stt_min_clip": {"test": SERVER.seg(min_cmp), "bytes": literal(min_cmp.comparators[0])},
            "speak_yields_in_order": yields,
            "breath": {
                "expr": breath,
                "seconds": breath_floats,
                "bytes_at_24000": len(eval(breath, {"SAMPLE_RATE": 24000})),
                "bytes_at_16000": len(eval(breath, {"SAMPLE_RATE": 16000})),
            },
            "chunk_glue": {"test": SERVER.seg(glue), "min_chars": literal(glue.comparators[0])},
            "pcm_conversion": [SERVER.seg(n) for n in SERVER.walk(ast.Assign, speak) if "astype" in SERVER.seg(n)],
        })

    def test_error_responses(self):
        self.golden("server-error-responses", [SERVER.call_shape(c) for c in SERVER.calls(attr="Response")])

    def test_whisper_transcribe_kwargs_at_every_call_site(self):
        out = []
        for c in SERVER.calls(attr="transcribe"):
            shape = SERVER.call_shape(c)
            shape["kwargs_literal"] = {kw.arg: literal(kw.value) for kw in c.keywords}
            shape["under_whisper_lock"] = SERVER.inside_with(c, "whisper_lock")
            out.append(shape)
        self.assertGreaterEqual(len(out), 2)
        self.golden("server-whisper-transcribe-calls", out)

    def test_kokoro_create_kwargs_and_warmup_text(self):
        out = []
        for c in SERVER.calls(attr="create"):
            shape = SERVER.call_shape(c)
            shape["kwargs_literal"] = {kw.arg: literal(kw.value) for kw in c.keywords}
            shape["text_literal"] = literal(c.args[0])
            out.append(shape)
        self.golden("server-kokoro-create-calls", out)
        self.assertIn("Systems online.", [s["text_literal"] for s in out])

    def test_model_loader_constructor_calls(self):
        out = [SERVER.call_shape(c) for c in SERVER.calls(attr="WhisperModel")]
        out += [SERVER.call_shape(c) for c in SERVER.calls(attr="Kokoro")]
        out += [SERVER.call_shape(c) for c in SERVER.calls(attr="WakeListener")]
        out += [SERVER.call_shape(c) for c in SERVER.calls(attr="FastAPI")]
        out += [SERVER.call_shape(c) for c in SERVER.calls(attr="Lock")]
        out += [SERVER.call_shape(c) for c in SERVER.calls("os.path.join")]
        self.golden("server-constructor-calls", out)

    def test_streaming_response_media_type_and_headers(self):
        calls = SERVER.calls(attr="StreamingResponse")
        self.assertEqual(len(calls), 1)
        shape = SERVER.call_shape(calls[0])
        shape["kwargs_literal"] = {kw.arg: literal(kw.value) for kw in calls[0].keywords}
        self.golden("server-streaming-response", shape)

    def test_websocket_hello_payload_literal(self):
        dumps = SERVER.calls("json.dumps", within=SERVER.function("events"))
        self.assertEqual(len(dumps), 1)
        d = dumps[0].args[0]
        self.golden("server-ws-hello-payload", {"source": SERVER.seg(d), "shape": dict_shape(SERVER, d)})

    def test_main_block_statements_verbatim(self):
        main_if = [n for n in SERVER.tree.body if isinstance(n, ast.If) and "__main__" in SERVER.seg(n.test)]
        self.assertEqual(len(main_if), 1)
        self.golden("server-main-block", {"test": SERVER.seg(main_if[0].test), "body": [SERVER.seg(s) for s in main_if[0].body]})

    def test_module_surface_top_level_assigns_and_defs(self):
        assigns, defs = [], []
        for n in SERVER.tree.body:
            if isinstance(n, ast.Assign):
                assigns.append({"targets": [SERVER.seg(t) for t in n.targets], "value": SERVER.seg(n.value)})
            elif isinstance(n, ast.AnnAssign):
                assigns.append({"targets": [SERVER.seg(n.target)], "annotation": SERVER.seg(n.annotation), "value": SERVER.seg(n.value) if n.value else None})
            elif isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
                defs.append({"name": n.name, "async": isinstance(n, ast.AsyncFunctionDef), "decorators": [SERVER.seg(d) for d in n.decorator_list]})
            elif isinstance(n, ast.ClassDef):
                defs.append({"class": n.name})
        self.golden("server-module-surface", {"assigns": assigns, "defs": defs})

    def test_windows_dll_path_guard(self):
        self.golden("server-dll-path-guard", dll_guard(SERVER))

    def test_function_skeletons(self):
        for name in ("load_kokoro", "load_whisper", "transcribe_pcm", "emit_event", "events", "_startup", "wav_header", "chunks_of", "health", "stt", "speak"):
            with self.subTest(fn=name):
                self.golden(f"server-fn-{name}", skeleton(SERVER, SERVER.function(name)))


CHUNK_CORPUS = [
    ("empty", ""),
    ("whitespace-only", "   \n\t "),
    ("one-sentence", "Systems online."),
    ("no-terminator", "Systems online"),
    ("two-short", "Yes. No."),
    ("many-short", "Hi. Yes. No. Go. Stop. Wait. Ok. Sure. Fine. Done. Really. Maybe. Never. Always. Perhaps."),
    ("long-single", "This is one very long sentence that runs well past the sixty character glue threshold without ever stopping for breath."),
    ("mixed-terminators", "One. Two! Three? Four… Five! Six? Seven."),
    ("ascii-ellipsis", "Well... maybe. Or not... who knows? Fine."),
    ("stacked-punct", "Really?! Yes!! Okay?? Done."),
    ("leading-trailing-ws", "   Good morning.   Two of three goals still open.   "),
    ("newlines", "Line one.\nLine two.\n\nLine three."),
    ("tabs-and-runs", "A.\t\tB.    C."),
    ("no-space-after-period", "Version 1.5 shipped.Next up: v2.Hello."),
    ("decimal-and-abbrev", "Dr. Smith saw 3.5 percent growth. Mr. Jones did not."),
    ("terminator-then-quote", 'He said "go." Then left! Right?'),
    ("glue-second-59-chars", "Lead. " + "x" * 58 + ". Tail."),
    ("glue-second-60-chars", "Lead. " + "x" * 59 + ". Tail."),
    ("glue-accumulates-to-60", "Lead. " + "Twenty chars here!! " * 2 + "And then twenty more. Tail."),
    ("only-punct", "..."),
    ("punct-runs", "... !!! ???"),
    ("unicode", "Café résumé naïve… Ünïcödé works? Ja!"),
    ("rundown-like", "Good morning. Two of three goals still open. YouTube is at fifty thousand four hundred and five subscribers, up one hundred and fifteen. Want me to run the inbox audit?"),
    ("over-900", " ".join(f"Sentence number {i} is right here." for i in range(1, 40))),
]


class ServerPure(GoldenCase):
    """chunks_of / wav_header / the 900-char cap, exec'd from their source."""

    def test_chunks_of_over_corpus(self):
        ns = _pure_ns()
        rows = []
        for name, text in CHUNK_CORPUS:
            rows.append({"case": name, "input": text, "input_len": len(text), "chunks": ns["chunks_of"](text)})
        self.golden("server-chunks-of", rows)

    def test_chunks_of_after_speak_cap_over_900(self):
        ns = _pure_ns()
        speak = SERVER.function("speak")
        cap = [n for n in speak.body if isinstance(n, ast.Assign)][0]
        text = "  " + " ".join(f"Sentence number {i} is right here." for i in range(1, 40)) + "  "
        env = {"text": text, **_limits_ns()}
        exec(SERVER.stmt(cap), env)
        capped = env["text"]
        chunks = ns["chunks_of"](capped)
        self.golden("server-chunks-of-capped", {
            "cap_stmt": SERVER.seg(cap),
            "input_len": len(text),
            "capped_len": len(capped),
            "capped_tail": capped[-40:],
            "chunks": chunks,
            "chunk_lens": [len(c) for c in chunks],
        })

    def test_wav_header_24000_hex(self):
        h = _pure_ns()["wav_header"](24000)
        self.assertEqual(len(h), 44)
        self.golden("server-wav-header-24000", h.hex())

    def test_wav_header_16000_hex(self):
        h = _pure_ns()["wav_header"](16000)
        self.assertEqual(len(h), 44)
        self.golden("server-wav-header-16000", h.hex())

    def test_wav_header_fields_decoded(self):
        ns = _pure_ns()
        names = ["riff", "riff_size", "wave", "fmt", "fmt_size", "audio_format", "channels", "sample_rate", "byte_rate", "block_align", "bits_per_sample", "data", "data_size"]
        out = {}
        for sr in (24000, 16000):
            vals = struct.unpack("<4sI4s4sIHHIIHH4sI", ns["wav_header"](sr))
            out[str(sr)] = {k: (v.decode("ascii") if isinstance(v, bytes) else v) for k, v in zip(names, vals)}
        self.golden("server-wav-header-fields", out)


class ServerHandlers(GoldenCase):
    """Route handlers exec'd against stand-ins: pins what they return and
    what they would send to Kokoro / Whisper / the HUD."""

    def _defaults(self):
        return _server_defaults()

    def test_health_response_variants(self):
        d = self._defaults()
        wake_model = ast.literal_eval(WAKEWORD.module_assign("WAKE_MODEL").value)
        base = dict(VOICE=d["VOICE"], WHISPER_MODEL=d["WHISPER_MODEL"], WAKE_MODEL=wake_model, WAKE_THRESHOLD=d["WAKE_THRESHOLD"])
        variants = {
            "wake-disabled-cpu": dict(base, KOKORO_DEVICE="cpu", WHISPER_DEVICE="cpu", WAKE_ENABLED=False, wake=None),
            "wake-armed-cuda": dict(base, KOKORO_DEVICE="cuda", WHISPER_DEVICE="cuda", WAKE_ENABLED=True, wake=SimpleNamespace(ok=True, error=None)),
            "wake-enabled-but-dead": dict(base, KOKORO_DEVICE="cpu", WHISPER_DEVICE="cuda", WAKE_ENABLED=True, wake=SimpleNamespace(ok=False, error="PortAudioError: Error querying device -1")),
            "wake-enabled-not-started-yet": dict(base, KOKORO_DEVICE="cpu", WHISPER_DEVICE="cpu", WAKE_ENABLED=True, wake=SimpleNamespace(ok=False, error=None)),
            "wake-armed-custom-threshold": dict(base, KOKORO_DEVICE="cuda", WHISPER_DEVICE="cuda", WAKE_ENABLED=True, WAKE_THRESHOLD=0.7, wake=SimpleNamespace(ok=True, error=None)),
        }
        out = {}
        for name, g in variants.items():
            ns = dict(g)
            # health() delegates the wake block to wake_status() now that the
            # server is a package; exec both so this still pins the RUNTIME
            # dict rather than the call shape. The golden is unchanged.
            exec(SERVER.stmt(SERVER.function("wake_status")), ns)
            exec(SERVER.stmt(SERVER.function("health")), ns)
            out[name] = ns["health"]()
        self.golden("server-health-variants", out)

    def test_stt_handler_short_clip_boundary_and_transcript_join(self):
        d = self._defaults()

        class FakeWhisper:
            def __init__(self, texts):
                self.texts, self.calls = texts, []

            def transcribe(self, audio, **kw):
                self.calls.append({
                    "audio_type": type(audio).__name__,
                    "audio_bytes": len(audio.getvalue()) if isinstance(audio, io.BytesIO) else None,
                    "kwargs": kw,
                })
                return (SimpleNamespace(text=t) for t in self.texts), {"language": "en"}

        class Req:
            def __init__(self, body):
                self._b = body

            async def body(self):
                return self._b

        def run(body, texts):
            fw = FakeWhisper(texts)
            ns = {
                "Request": Req, "Response": _FakeResponse, "io": io,
                "time": _Clock(start=100.0, step=0.25),
                "whisper_lock": threading.Lock(), "whisper": fw, "WHISPER_PROMPT": d["WHISPER_PROMPT"],
                **_limits_ns(),
            }
            exec(SERVER.stmt(SERVER.function("stt")), ns)
            res = asyncio.run(ns["stt"](Req(body)))
            return {"result": res.pin() if isinstance(res, _FakeResponse) else res, "transcribe_calls": fw.calls}

        out = {
            "empty-body": run(b"", [" hi "]),
            "999-bytes": run(b"x" * 999, [" hi "]),
            "1000-bytes": run(b"x" * 1000, [" Hello ", "  world.  ", ""]),
            "1001-bytes-empty-segments": run(b"x" * 1001, []),
            "whitespace-segments": run(b"x" * 5000, ["   ", "\n", " only "]),
        }
        self.golden("server-stt-handler", out)

    def test_speak_handler_stream_layout_and_kokoro_inputs(self):
        d = self._defaults()

        class FakeKokoro:
            def __init__(self):
                self.calls = []

            def create(self, text, **kw):
                self.calls.append({"text": text, "kwargs": kw})
                return _Arr([0.0, 0.5, -0.5, 1.0, -1.0, 1.5, -1.5, 0.25]), 24000

        def run(text):
            k = FakeKokoro()
            ns = _pure_ns()
            ns.update({
                "Response": _FakeResponse, "StreamingResponse": _FakeStreamingResponse,
                "SAMPLE_RATE": d["SAMPLE_RATE"], "kokoro": k, "VOICE": d["VOICE"], "SPEED": d["SPEED"], "np": _FakeNp,
                **_limits_ns(),
            })
            exec(SERVER.stmt(SERVER.function("speak")), ns)
            res = ns["speak"](text)
            return {"response": res.pin(), "kokoro_calls": k.calls}

        long_text = " ".join(f"Sentence number {i} is right here." for i in range(1, 40))
        out = {
            "empty": run(""),
            "whitespace-only": run("  \n "),
            "one-sentence": run("Systems online."),
            "leading-trailing-ws": run("  Hi there.  "),
            "three-short": run("One. Two. Three."),
            "rundown-like": run("Good morning. Two of three goals still open. Want me to run the inbox audit?"),
            "over-900": run(long_text),
        }
        # the default parameter value (no ?text=) takes the same path as empty
        ns = _pure_ns()
        ns.update({"Response": _FakeResponse, "StreamingResponse": _FakeStreamingResponse, "SAMPLE_RATE": d["SAMPLE_RATE"], "kokoro": FakeKokoro(), "VOICE": d["VOICE"], "SPEED": d["SPEED"], "np": _FakeNp, **_limits_ns()})
        exec(SERVER.stmt(SERVER.function("speak")), ns)
        out["default-arg"] = {"response": ns["speak"]().pin(), "kokoro_calls": []}
        self.golden("server-speak-handler", out)

    def test_events_handler_hello_then_pings_then_disconnect(self):
        class Disconnect(Exception):
            pass

        class FakeWs:
            def __init__(self, script, clients):
                self.script, self.clients, self.log, self.sent = list(script), clients, [], []

            async def accept(self):
                self.log.append("accept")

            async def send_text(self, m):
                self.log.append(f"send_text in_clients={self in self.clients}")
                self.sent.append(m)

            async def receive_text(self):
                self.log.append(f"receive_text in_clients={self in self.clients}")
                if not self.script:
                    raise Disconnect()
                item = self.script.pop(0)
                if isinstance(item, Exception):
                    raise item
                return item

        def run(wake, script):
            clients = set()
            ns = {"WebSocket": object, "WebSocketDisconnect": Disconnect, "json": json, "wake": wake, "ws_clients": clients}
            exec(SERVER.stmt(SERVER.function("events")), ns)
            ws = FakeWs(script, clients)
            err = None
            try:
                asyncio.run(ns["events"](ws))
            except Exception as e:
                err = f"{type(e).__name__}: {e}"
            return {"sent": ws.sent, "log": ws.log, "in_clients_after": ws in clients, "raised": err}

        out = {
            "wake-none-two-pings": run(None, ["ping", "ping"]),
            "wake-armed-no-pings": run(SimpleNamespace(ok=True), []),
            "wake-enabled-dead": run(SimpleNamespace(ok=False), ["{}"]),
            "receive-raises-other-error": run(None, ["ping", RuntimeError("socket torn down")]),
        }
        self.golden("server-events-handler", out)

    def test_emit_event_wire_format_fanout_and_dead_client_discard(self):
        class FakeWs:
            def __init__(self, name, dead=False):
                self.name, self.dead, self.sent = name, dead, []

            async def send_text(self, m):
                if self.dead:
                    raise RuntimeError("closed")
                self.sent.append(m)

            def __repr__(self):
                return self.name

        scheduled = []
        fake_asyncio = SimpleNamespace(run_coroutine_threadsafe=lambda coro, loop: scheduled.append((coro, loop)))
        loop_sentinel = object()
        good1, good2, bad = FakeWs("good1"), FakeWs("good2"), FakeWs("bad", dead=True)
        clients = {good1, good2, bad}
        ns = {"json": json, "asyncio": fake_asyncio, "main_loop": loop_sentinel, "ws_clients": clients}
        exec(SERVER.stmt(SERVER.function("emit_event")), ns)

        ret = ns["emit_event"]({"type": "wake", "score": 0.987})
        self.assertIsNone(ret)
        self.assertEqual(len(scheduled), 1)
        coro, loop = scheduled[0]
        self.assertIs(loop, loop_sentinel)
        asyncio.run(coro)

        # with no loop yet (before startup) the event is dropped silently
        ns["main_loop"] = None
        ret2 = ns["emit_event"]({"type": "transcript", "text": "hi", "ms": 5})

        self.golden("server-emit-event", {
            "message": good1.sent[0],
            "delivered_to": sorted(w.name for w in (good1, good2, bad) if w.sent),
            "remaining_clients": sorted(w.name for w in clients),
            "before-startup": {"returned": ret2, "scheduled_calls": len(scheduled)},
            "transcript-wire-format": json.dumps({"type": "transcript", "text": "hey jarvis", "ms": 412}),
            "hello-wire-format": {
                "wake=None": json.dumps({"type": "hello", "wake": bool(None and None.ok)}),
                "wake.ok=True": json.dumps({"type": "hello", "wake": bool(SimpleNamespace(ok=True) and True)}),
            },
        })


class WakewordStatic(GoldenCase):
    def test_module_constants(self):
        out = {}
        for n in WAKEWORD.tree.body:
            if isinstance(n, ast.Assign):
                for t in n.targets:
                    out[WAKEWORD.seg(t)] = literal(n.value)
        self.golden("wakeword-constants", out)

    def test_class_surface_methods_init_attrs_and_thread(self):
        classes = []
        for c in WAKEWORD.walk(ast.ClassDef):
            methods = [
                {"name": m.name, "params": params(WAKEWORD, m), "async": isinstance(m, ast.AsyncFunctionDef)}
                for m in c.body if isinstance(m, (ast.FunctionDef, ast.AsyncFunctionDef))
            ]
            init = WAKEWORD.function(f"{c.name}.__init__")
            attrs = [
                {"attr": WAKEWORD.seg(n.targets[0]), "value": WAKEWORD.seg(n.value)}
                for n in init.body if isinstance(n, ast.Assign)
            ]
            classes.append({"name": c.name, "bases": [WAKEWORD.seg(b) for b in c.bases], "methods": methods, "init_attrs": attrs})
        self.golden("wakeword-class-surface", {
            "classes": classes,
            "thread": [WAKEWORD.call_shape(c) for c in WAKEWORD.calls("threading.Thread")],
            "thread_kwargs_literal": [{kw.arg: literal(kw.value) for kw in c.keywords} for c in WAKEWORD.calls("threading.Thread")],
        })

    def test_emitted_event_payload_literals(self):
        out = []
        for c in WAKEWORD.calls("self.emit"):
            d = c.args[0]
            entry = {"in": WAKEWORD.enclosing(c), "source": WAKEWORD.seg(d)}
            if isinstance(d, ast.Dict):
                entry["keys"] = [literal(k) for k in d.keys]
                entry["shape"] = dict_shape(WAKEWORD, d)
                entry["type"] = literal(dict(zip([literal(k) for k in d.keys], d.values))["type"])
            out.append(entry)
        self.golden("wakeword-emit-payloads", out)
        self.golden("wakeword-event-types", sorted({e["type"] for e in out}))

    def test_audio_pipeline_calls_model_stream_predict(self):
        out = {
            "Model": [WAKEWORD.call_shape(c) for c in WAKEWORD.calls(attr="Model")],
            "Model_kwargs_literal": [{kw.arg: literal(kw.value) for kw in c.keywords} for c in WAKEWORD.calls(attr="Model")],
            "InputStream": [WAKEWORD.call_shape(c) for c in WAKEWORD.calls(attr="InputStream")],
            "stream.read": [WAKEWORD.call_shape(c) for c in WAKEWORD.calls(attr="read")],
            "predict": [WAKEWORD.seg(n) for n in WAKEWORD.walk(ast.Subscript) if "predict" in WAKEWORD.seg(n)],
            "reset": [WAKEWORD.call_shape(c) for c in WAKEWORD.calls(attr="reset")],
            "prints": [WAKEWORD.seg(c) for c in WAKEWORD.calls(attr="print")],
        }
        self.golden("wakeword-audio-pipeline-calls", out)

    def test_tunable_statements_with_numeric_literals(self):
        out = []
        for name in ("WakeListener._run", "WakeListener._capture"):
            fn = WAKEWORD.function(name)
            for n in WAKEWORD.walk((ast.Assign, ast.AugAssign, ast.If, ast.While), fn):
                target = n.test if isinstance(n, (ast.If, ast.While)) else n
                has_num = any(isinstance(c, ast.Constant) and isinstance(c.value, (int, float)) and not isinstance(c.value, bool) for c in ast.walk(target))
                if has_num:
                    out.append({"in": name, "kind": type(n).__name__, "source": WAKEWORD.seg(target)})
        self.golden("wakeword-tunables", out)

    def test_function_skeletons(self):
        for name in ("WakeListener.__init__", "WakeListener.start", "WakeListener._run", "WakeListener._capture"):
            with self.subTest(fn=name):
                self.golden(f"wakeword-fn-{name.split('.')[-1]}", skeleton(WAKEWORD, WAKEWORD.function(name)))


class WakewordCapture(GoldenCase):
    """WakeListener._capture exec'd against a scripted mic: energy
    endpointing, timeouts, and the events it emits."""

    FRAME_LEN = 8  # samples per fake frame (the code never inspects length)

    def _scenario(self, rms_seq, noise=80.0, transcript="hey jarvis what time is it"):
        clock = _Clock()
        ns = _wakeword_ns(clock)
        emitted, tcalls, reads = [], [], {"count": 0, "first_arg": None}

        class Frame:
            def __init__(self, arr):
                self.arr = arr

            def __getitem__(self, idx):
                return self.arr

        class Stream:
            def read(self, n):
                if reads["first_arg"] is None:
                    reads["first_arg"] = n
                v = rms_seq[min(reads["count"], len(rms_seq) - 1)]
                reads["count"] += 1
                clock.now = reads["count"] / 16.0  # exact binary fractions
                return Frame(_Arr([float(v)] * WakewordCapture.FRAME_LEN)), False

        def transcribe(audio):
            tcalls.append({"samples": len(audio), "head": audio.vals[:2], "tail": audio.vals[-1]})
            clock.now += 0.125
            if isinstance(transcript, Exception):
                raise transcript
            return transcript

        listener = ns["WakeListener"](transcribe, emitted.append, threshold=0.5)
        listener._capture(Stream(), noise)
        return {
            "noise": noise,
            "speech_gate": max(noise * 3.0, 250.0),
            "events": emitted,
            "reads": reads["count"],
            "first_read_arg": reads["first_arg"],
            "transcribe_calls": tcalls,
            "clock_at_end": clock.now,
        }

    def test_capture_scenarios(self):
        out = {
            "speech-then-silence": self._scenario([1000] * 5 + [10] * 50),
            "nobody-speaks": self._scenario([10] * 200),
            "speech-never-ends-hits-8s-cap": self._scenario([1000] * 500),
            "speech-then-silence-but-cap-wins": self._scenario([1000] * 125 + [10] * 10),
            "transcribe-raises": self._scenario([1000] * 5 + [10] * 50, transcript=RuntimeError("CUDA out of memory")),
            "transcribe-empty-text": self._scenario([1000] * 5 + [10] * 50, transcript=""),
            "gate-follows-noise-floor": self._scenario([500] * 200, noise=200.0),
            "gate-follows-noise-floor-speech-above": self._scenario([700] * 3 + [10] * 20, noise=200.0),
            "gate-min-250-exact-boundary": self._scenario([250] * 3 + [249] * 20),
            "pause-shorter-than-trail-resets-silence": self._scenario([1000] * 3 + [10] * 5 + [1000] * 2 + [10] * 9),
            "speech-starts-just-before-no-speech-timeout": self._scenario([10] * 38 + [1000] * 2 + [10] * 9),
            "speech-starts-just-after-no-speech-timeout": self._scenario([10] * 41 + [1000] * 2 + [10] * 9),
            "negative-samples-rms-is-magnitude": self._scenario([-1000] * 5 + [10] * 50),
        }
        self.golden("wakeword-capture-scenarios", out)


class MakeSamples(GoldenCase):
    FAKE_VOICES = ["af_heart", "af_bella", "am_adam", "am_michael", "am_echo", "bf_emma", "bf_isabella", "bm_george", "bm_lewis", "bm_daniel", "bm_fable", "ef_dora", "jm_kumo"]

    def test_environ_and_no_argv(self):
        self.golden("make-samples-environ", {
            "environ": environ_ops(MAKE_SAMPLES),
            "uses_sys_argv": any(MAKE_SAMPLES.seg(n) == "sys.argv" for n in MAKE_SAMPLES.walk(ast.Attribute)),
        })

    def test_constants_calls_and_output_paths(self):
        for_outer = [n for n in MAKE_SAMPLES.tree.body if isinstance(n, ast.For)][0]
        for_inner = [n for n in for_outer.body if isinstance(n, ast.For)][0]
        self.golden("make-samples-surface", {
            "dll_guard": dll_guard(MAKE_SAMPLES),
            "TEXT": literal(MAKE_SAMPLES.module_assign("TEXT").value),
            "SPEEDS": literal(MAKE_SAMPLES.module_assign("SPEEDS").value),
            "OUT": MAKE_SAMPLES.seg(MAKE_SAMPLES.module_assign("OUT").value),
            "PREFIXES": MAKE_SAMPLES.seg(MAKE_SAMPLES.module_assign("PREFIXES").value),
            "voices": MAKE_SAMPLES.seg(MAKE_SAMPLES.module_assign("voices").value),
            "outer_loop": MAKE_SAMPLES.seg(for_outer.iter),
            "lang_rule": [MAKE_SAMPLES.seg(n) for n in for_outer.body if isinstance(n, ast.Assign)],
            "speed_sweep": MAKE_SAMPLES.seg(for_inner.iter),
            "inner_assigns": [MAKE_SAMPLES.seg(n) for n in for_inner.body if isinstance(n, ast.Assign)],
            "Kokoro": [MAKE_SAMPLES.call_shape(c) for c in MAKE_SAMPLES.calls(attr="Kokoro")],
            "kokoro.create": [MAKE_SAMPLES.call_shape(c) for c in MAKE_SAMPLES.calls(attr="create")],
            "sf.write": [MAKE_SAMPLES.call_shape(c) for c in MAKE_SAMPLES.calls("sf.write")],
            "makedirs": [MAKE_SAMPLES.call_shape(c) for c in MAKE_SAMPLES.calls("os.makedirs")],
            "open": [MAKE_SAMPLES.call_shape(c) for c in MAKE_SAMPLES.calls(attr="open")],
            "prints": [MAKE_SAMPLES.seg(c) for c in MAKE_SAMPLES.calls(attr="print")],
        })

    def test_html_template_verbatim(self):
        self.golden("make-samples-html-template", MAKE_SAMPLES.seg(MAKE_SAMPLES.module_assign("html").value))

    def _plan(self, env):
        ns = {"os": SimpleNamespace(environ=dict(env)), "kokoro": SimpleNamespace(get_voices=lambda: list(self.FAKE_VOICES))}
        exec(MAKE_SAMPLES.stmt(MAKE_SAMPLES.module_assign("SPEEDS")), ns)
        exec(MAKE_SAMPLES.stmt(MAKE_SAMPLES.module_assign("PREFIXES")), ns)
        exec(MAKE_SAMPLES.stmt(MAKE_SAMPLES.module_assign("voices")), ns)
        for_outer = [n for n in MAKE_SAMPLES.tree.body if isinstance(n, ast.For)][0]
        for_inner = [n for n in for_outer.body if isinstance(n, ast.For)][0]
        lang_stmt = [n for n in for_outer.body if isinstance(n, ast.Assign)][0]
        name_stmt = [n for n in for_inner.body if isinstance(n, ast.Assign) and MAKE_SAMPLES.seg(n.targets[0]) == "name"][0]
        rows, plan = [], []
        for voice in ns["voices"]:
            ns["voice"] = voice
            exec(MAKE_SAMPLES.stmt(lang_stmt), ns)
            for speed in eval(MAKE_SAMPLES.seg(for_inner.iter), ns):
                ns["speed"] = speed
                exec(MAKE_SAMPLES.stmt(name_stmt), ns)
                rows.append((voice, speed, ns["name"]))
                plan.append({"voice": voice, "speed": speed, "lang": ns["lang"], "file": ns["name"]})
        return ns, rows, plan

    def test_plan_voice_selection_lang_and_speed_sweep(self):
        out = {}
        for label, env in (("default", {}), ("SAMPLE_PREFIXES=bm_,bf_", {"SAMPLE_PREFIXES": "bm_,bf_"}), ("SAMPLE_PREFIXES=af_", {"SAMPLE_PREFIXES": "af_"}), ("SAMPLE_PREFIXES=zz_", {"SAMPLE_PREFIXES": "zz_"})):
            ns, _rows, plan = self._plan(env)
            out[label] = {"PREFIXES": list(ns["PREFIXES"]), "voices": ns["voices"], "plan": plan}
        self.golden("make-samples-plan", out)

    def test_audition_html_rendered_default_env(self):
        ns, rows, _plan = self._plan({})
        ns["rows"] = rows
        exec(MAKE_SAMPLES.stmt(MAKE_SAMPLES.module_assign("items")), ns)
        exec(MAKE_SAMPLES.stmt(MAKE_SAMPLES.module_assign("html")), ns)
        self.golden("make-samples-audition-html", ns["html"])

    def test_audition_html_heading_reflects_env(self):
        out = {}
        for label, env in (("default", {}), ("voice+speed", {"KOKORO_VOICE": "bm_lewis", "KOKORO_SPEED": "1.08"}), ("speed-int", {"KOKORO_SPEED": "2"})):
            ns, rows, _plan = self._plan(env)
            ns["rows"] = rows
            exec(MAKE_SAMPLES.stmt(MAKE_SAMPLES.module_assign("items")), ns)
            exec(MAKE_SAMPLES.stmt(MAKE_SAMPLES.module_assign("html")), ns)
            out[label] = re.search(r"<h2>.*?</h2>", ns["html"]).group(0)
        self.golden("make-samples-audition-heading", out)


class WsProbe(GoldenCase):
    def _main_guard_arg(self):
        main_if = [n for n in WS_PROBE.tree.body if isinstance(n, ast.If) and "__main__" in WS_PROBE.seg(n.test)][0]
        run_call = WS_PROBE.calls("asyncio.run", within=main_if)[0]
        main_call = run_call.args[0]
        return main_if, run_call, main_call

    def test_surface_url_calls_argv_and_prints(self):
        main_if, run_call, main_call = self._main_guard_arg()
        strings = sorted({n.value for n in WS_PROBE.walk(ast.Constant) if isinstance(n.value, str)} - {ast.get_docstring(WS_PROBE.tree)})
        self.golden("ws-probe-surface", {
            "main": {"params": params(WS_PROBE, WS_PROBE.function("main")), "async": isinstance(WS_PROBE.function("main"), ast.AsyncFunctionDef)},
            "connect": [WS_PROBE.call_shape(c) for c in WS_PROBE.calls("websockets.connect")],
            "url_literal": literal(WS_PROBE.calls("websockets.connect")[0].args[0]),
            "wait_for": [WS_PROBE.call_shape(c) for c in WS_PROBE.calls("asyncio.wait_for")],
            "main_guard": {"test": WS_PROBE.seg(main_if.test), "run": WS_PROBE.seg(run_call), "seconds_expr": WS_PROBE.seg(main_call.args[0])},
            "uses_sys_argv": any(WS_PROBE.seg(n) == "sys.argv" for n in WS_PROBE.walk(ast.Attribute)),
            "string_constants": strings,
            "prints": [WS_PROBE.seg(c) for c in WS_PROBE.calls(attr="print")],
            "skeleton": skeleton(WS_PROBE, WS_PROBE.function("main")),
        })

    def test_argv_seconds_parsing_table(self):
        _main_if, _run_call, main_call = self._main_guard_arg()
        expr = WS_PROBE.seg(main_call.args[0])
        out = {}
        for argv in ([], ["ws_probe.py"], ["ws_probe.py", "3"], ["ws_probe.py", "2.5", "extra"], ["ws_probe.py", "1e2"], ["ws_probe.py", "-1"], ["ws_probe.py", " 7 "], ["ws_probe.py", "inf"], ["ws_probe.py", "abc"], ["ws_probe.py", ""]):
            try:
                out[json.dumps(argv)] = {"seconds": repr(eval(expr, {"sys": SimpleNamespace(argv=list(argv))}))}
            except Exception as e:
                out[json.dumps(argv)] = {"error": f"{type(e).__name__}: {e}"}
        self.golden("ws-probe-argv-seconds", {"expr": expr, "table": out})


class Couplings(GoldenCase):
    def test_port_is_hard_coded_and_ws_probe_targets_it(self):
        port = ast.literal_eval(SERVER.module_assign("PORT").value)
        run_call = SERVER.calls("uvicorn.run")[0]
        host = literal([kw for kw in run_call.keywords if kw.arg == "host"][0].value)
        url = literal(WS_PROBE.calls("websockets.connect")[0].args[0])
        ws_route = [r["path"] for r in routes(SERVER) if r["method"] == "websocket"]
        out = {
            "server.PORT": port,
            "server.PORT_read_from_env": any(e["key"] == "PORT" or "PORT" in str(e["key"]) for e in environ_ops(SERVER)),
            "uvicorn.host": host,
            "uvicorn.port_expr": SERVER.seg([kw for kw in run_call.keywords if kw.arg == "port"][0].value),
            "ws_probe.url": url,
            "server.websocket_routes": ws_route,
        }
        self.golden("port-couplings", out)
        self.assertEqual(url, f"ws://{host}:{port}{ws_route[0]}")
        self.assertEqual(port, LIVE_PORT)


class LiveContract(unittest.TestCase):
    @unittest.skip(
        "Live HTTP/WS contract (GET /health, GET /speak, POST /stt, WS /events) is not "
        "pinnable hermetically: PORT is a hard-coded constant (4871) in server.py, so a "
        "second instance cannot be spawned without editing the module, importing server.py "
        "loads Kokoro + Whisper (~20s, GBs of RAM), and the user's live voice-server is "
        "running on 127.0.0.1:4871 and must never be contacted by the suite. The handler "
        "bodies are pinned instead by exec'ing their source against stand-ins (ServerHandlers)."
    )
    def test_live_http_and_websocket_contract(self):
        pass


if __name__ == "__main__":
    unittest.main()
