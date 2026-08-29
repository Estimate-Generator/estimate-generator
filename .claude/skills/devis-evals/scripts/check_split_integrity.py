#!/usr/bin/env python3
"""Verify the eval corpus splits have not leaked into each other.

Usage:  python check_split_integrity.py evals/corpus/

Fails if a tenant_ref or session appears in more than one split. That leak
is invisible by inspection and it inflates every score: the same speaker's
accent, vocabulary and recording environment appearing in both the tuning
set and the gate means the gate is partly measuring memorisation.

Also reports split proportions, missing metadata, and duplicate ids.
"""
import collections
import json
import pathlib
import sys

# The report uses '✗'. Windows consoles default to cp1252, which cannot encode
# it, and the script dies mid-report with a UnicodeEncodeError instead of
# printing findings. Force UTF-8 and degrade rather than crash.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

SPLITS = ("dev", "gate", "test")
TARGET = {"dev": 0.60, "gate": 0.20, "test": 0.20}
TOLERANCE = 0.10
REQUIRED_META = ("tenant_ref", "session", "language")


def load(root: pathlib.Path):
    cases = []
    for split in SPLITS:
        d = root / split
        if not d.exists():
            print(f"warning: {d} does not exist")
            continue
        for f in sorted(d.glob("*.json")):
            try:
                data = json.loads(f.read_text())
            except json.JSONDecodeError as e:
                print(f"  ✗ {f}: invalid JSON ({e})")
                continue
            data["_split"] = split
            data["_path"] = f
            cases.append(data)
    return cases


def main(root_arg: str) -> int:
    root = pathlib.Path(root_arg)
    cases = load(root)
    if not cases:
        sys.exit(f"no cases found under {root}")

    problems: list[str] = []

    # --- leakage: a tenant or session spanning splits -----------------
    for key in ("tenant_ref", "session"):
        owner: dict[str, str] = {}
        for c in cases:
            v = c.get("meta", {}).get(key)
            if not v:
                continue
            prev = owner.get(v)
            if prev and prev != c["_split"]:
                problems.append(
                    f"LEAK: {key}='{v}' appears in both '{prev}' and "
                    f"'{c['_split']}' ({c['_path'].name})")
            owner.setdefault(v, c["_split"])

    # --- duplicate ids ------------------------------------------------
    ids = collections.Counter(c.get("id", "<missing>") for c in cases)
    for cid, n in ids.items():
        if n > 1:
            problems.append(f"duplicate id '{cid}' appears {n} times")

    # --- metadata completeness ---------------------------------------
    for c in cases:
        missing = [k for k in REQUIRED_META if not c.get("meta", {}).get(k)]
        if missing:
            problems.append(f"{c['_path'].name}: missing meta {missing}")
        if c.get("split") and c["split"] != c["_split"]:
            problems.append(
                f"{c['_path'].name}: declares split='{c['split']}' but sits "
                f"in {c['_split']}/")

    # --- proportions ---------------------------------------------------
    counts = collections.Counter(c["_split"] for c in cases)
    total = len(cases)
    print(f"\n{total} cases")
    for s in SPLITS:
        n = counts.get(s, 0)
        pct = n / total if total else 0
        flag = "" if abs(pct - TARGET[s]) <= TOLERANCE else "  ← off target"
        print(f"  {s:5s} {n:4d}  {pct:5.1%}  (target {TARGET[s]:.0%}){flag}")

    # --- slice coverage, informational --------------------------------
    print("\nby language:")
    for lang, n in collections.Counter(
            c.get("meta", {}).get("language", "?") for c in cases).most_common():
        print(f"  {lang:8s} {n:4d}")
    print("by noise:")
    for noise, n in collections.Counter(
            c.get("meta", {}).get("noise", "?") for c in cases).most_common():
        print(f"  {noise:8s} {n:4d}")

    if problems:
        print(f"\nFAIL — {len(problems)} problem(s)\n")
        for p in problems:
            print(f"  ✗ {p}")
        print("\nA leak means scores are inflated. Move the offending cases so "
              "each tenant_ref and session lives in exactly one split.")
        return 1

    print("\nOK — no leakage, ids unique, metadata complete.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "evals/corpus"))
