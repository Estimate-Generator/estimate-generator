#!/usr/bin/env python3
"""Static checks for the invariants that silent bugs hide behind.

Usage:  python check_domain_purity.py app/

Checks, in severity order:
  1. app/domain/ imports nothing from adapters, db, or third-party clients
  2. no money-shaped field in any extraction schema
  3. no float arithmetic on anything price-shaped
  4. no non-deterministic value inside a dedupe_key
  5. no await on a provider/http call inside `async with ... begin()`

These are heuristics, not proofs. A hit is worth a look; it is not
automatically a defect. Missing a hit does not mean the code is correct.
"""
import ast
import pathlib
import re
import sys

# The report uses '✗'. Windows consoles default to cp1252, which cannot encode
# it, and the script dies mid-report with a UnicodeEncodeError instead of
# printing findings. Force UTF-8 and degrade rather than crash.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

FORBIDDEN_IN_DOMAIN = (
    "httpx", "requests", "aiohttp", "sqlalchemy", "redis", "arq",
    "openai", "anthropic", "instructor", "langfuse", "boto3",
    "playwright", "app.adapters", "app.db", "app.services",
)

MONEY_FIELDS = re.compile(
    r"\b(unit_price|price|total|amount|montant|cost|prix|subtotal|ttc|ht)\b",
    re.IGNORECASE,
)
SCHEMA_HINT = re.compile(r"class\s+(\w*(Extracted|Parsed|Detected)\w*)\s*\(\s*BaseModel")
NONDETERMINISTIC = re.compile(r"(uuid4\(\)|now\(\)|utcnow\(\)|time\.time\(\)|token_hex)")


SKIP_DIRS = {".venv", "venv", "migrations", "__pycache__", ".git"}


def iter_py(root: pathlib.Path):
    for p in root.rglob("*.py"):
        # Compare path components, not a substring: on Windows the separator is
        # '\', so a '/.venv/' substring test silently never matches and the
        # check quietly scans the whole virtualenv.
        if SKIP_DIRS.intersection(p.parts):
            continue
        yield p


def check_domain_purity(root: pathlib.Path) -> list[str]:
    out = []
    domain = root / "domain"
    if not domain.exists():
        return out
    for path in iter_py(domain):
        try:
            tree = ast.parse(path.read_text())
        except SyntaxError as e:
            out.append(f"{path}: unparseable ({e})")
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                names = [a.name for a in node.names]
            elif isinstance(node, ast.ImportFrom):
                names = [node.module or ""]
            else:
                continue
            for n in names:
                if any(n.startswith(f) for f in FORBIDDEN_IN_DOMAIN):
                    out.append(f"{path}:{node.lineno}: domain imports '{n}' "
                               f"— domain must stay pure")
    return out


def check_money_in_schemas(root: pathlib.Path) -> list[str]:
    out = []
    for path in iter_py(root):
        src = path.read_text()
        for m in SCHEMA_HINT.finditer(src):
            cls = m.group(1)
            # The documented exception is catalog capture, where the user is
            # stating their own prices aloud. Exempt that class only — exempting
            # the whole file would hide a real money field declared beside it.
            if "CatalogCapture" in cls:
                continue
            body = src[m.end(): m.end() + 1500]
            body = body.split("\nclass ")[0]
            for line in body.splitlines():
                stripped = line.strip()
                if not stripped or stripped.startswith("#"):
                    continue
                if ":" in stripped and MONEY_FIELDS.search(stripped.split(":")[0]):
                    out.append(f"{path}: schema {cls} declares "
                               f"'{stripped.split(':')[0].strip()}' — the LLM "
                               f"must not produce money values")
    return out


def check_float_money(root: pathlib.Path) -> list[str]:
    out = []
    money = r"[\w.\[\]'\"]*(price|total|amount|montant|cost|prix|ttc|ht)[\w.\[\]'\"]*"
    patterns = [
        (re.compile(rf"float\s*\(\s*{money}", re.I),
         "float() applied to a money value"),
        (re.compile(rf"{money}\s*:\s*float\b", re.I),
         "money value annotated as float"),
        (re.compile(rf"round\s*\(\s*{money}", re.I),
         "round() on a money value — use Decimal.quantize with ROUND_HALF_UP"),
    ]
    for path in iter_py(root):
        for i, line in enumerate(path.read_text().splitlines(), 1):
            if line.strip().startswith("#"):
                continue
            for pat, msg in patterns:
                if pat.search(line):
                    out.append(f"{path}:{i}: {msg} — use Decimal")
                    break
    return out


def check_dedupe_keys(root: pathlib.Path) -> list[str]:
    out = []
    for path in iter_py(root):
        for i, line in enumerate(path.read_text().splitlines(), 1):
            if "dedupe_key" in line and NONDETERMINISTIC.search(line):
                out.append(f"{path}:{i}: dedupe_key contains a non-deterministic "
                           f"value — retries will send a duplicate")
    return out


def check_io_in_transaction(root: pathlib.Path) -> list[str]:
    out = []
    begin = re.compile(r"async\s+with\s+.*\.begin\(\)")
    io_call = re.compile(r"await\s+(provider|client|httpx|asr|llm|storage|messaging)\.")
    for path in iter_py(root):
        lines = path.read_text().splitlines()
        depth_line = None
        indent = 0
        for i, line in enumerate(lines, 1):
            if begin.search(line):
                depth_line = i
                indent = len(line) - len(line.lstrip())
                continue
            if depth_line is not None:
                cur = len(line) - len(line.lstrip())
                if line.strip() and cur <= indent:
                    depth_line = None
                    continue
                if io_call.search(line):
                    out.append(f"{path}:{i}: network call inside the transaction "
                               f"opened at line {depth_line} — use the outbox")
    return out


CHECKS = [
    ("domain purity", check_domain_purity),
    ("money in extraction schemas", check_money_in_schemas),
    ("float arithmetic on money", check_float_money),
    ("non-deterministic dedupe keys", check_dedupe_keys),
    ("network call inside transaction", check_io_in_transaction),
]


def main(root_arg: str) -> int:
    root = pathlib.Path(root_arg)
    if not root.exists():
        sys.exit(f"no such path: {root}")

    total = 0
    for label, fn in CHECKS:
        findings = fn(root)
        if findings:
            total += len(findings)
            print(f"\n{label}  ({len(findings)})")
            for f in findings:
                print(f"  ✗ {f}")
        else:
            print(f"ok  {label}")

    if total:
        print(f"\n{total} finding(s). These are heuristics — review each one "
              f"rather than assuming it is a defect.")
        return 1
    print("\nAll checks clean.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "app"))
