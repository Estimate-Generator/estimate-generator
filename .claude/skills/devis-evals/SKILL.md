---
name: devis-evals
description: Manage the evaluation corpus and quality gates in the voice-to-quote project — the dev/gate/test split discipline, case format, which metrics block a merge, promoting incident traces into regression cases, and interpreting score changes. Use this whenever a task involves quality measurement: adding test cases, a failing extraction that needs a regression test, changing a threshold, interpreting eval output, benchmarking ASR providers, or anything phrased as "add a test for this voice note", "the model got this wrong", "did quality improve", or "why did the gate fail". Adding a failing case directly to the gate split turns the gate into the tuning set and silently invalidates every quality number, so consult this before touching evals/corpus/.
---

# Evaluation corpus

The corpus is the most valuable technical asset in the project — more so than the code, which can be rewritten. Its value depends entirely on one discipline being maintained.

## The splits

```
evals/corpus/
  dev/    ~60%  tune freely, look as often as you like
  gate/   ~20%  runs on every PR, blocking
  test/   ~20%  LOCKED — release only, one person, results recorded
```

**Why this exists.** Tuning prompts against the same cases the gate checks means the gate measures memorisation, not quality. Over ten iterations you drift to 0.99 on the corpus with unchanged field performance, and every quality number becomes fiction. An earlier version of this project's architecture had no split, which made all of its reported numbers unreliable.

Four rules, and they only work if actually followed:

- **Split by tenant and by recording session, not by file.** The same artisan's voice notes appearing across splits leaks speaker characteristics — accent, vocabulary, recording environment — and inflates every score. `meta.tenant_ref` and `meta.session` exist for this.
- **Never open `test/` while iterating.** It is read at release, by one person, with results appended to `evals/history.md` alongside the date, prompt version and model version.
- **Divergence above 5 points between `dev` and `test` means overfitting.** The response is to stop tuning and add data, not to adjust the threshold.
- **New cases land in `dev` by default.** Promotion to `gate` requires review. `test/` grows only in deliberate quarterly batches.

Run `scripts/check_split_integrity.py` before committing corpus changes. It fails if a `tenant_ref` or `session` appears in more than one split, which is the leak that is invisible by inspection.

## Case format

```json
{
  "id": "002_menuiserie_darija",
  "split": "dev",
  "meta": { "tenant_ref": "t07", "session": "s03", "trade": "menuiserie",
            "language": "mixed", "noise": "high", "duration_s": 19.4,
            "source": "incident_2026_09_14" },
  "expected": {
    "intent": "new_quote",
    "client_name": "Alami",
    "lines": [
      { "raw_contains": "fenêtre",   "quantity": 3,  "unit": "u"  },
      { "raw_contains": "carrelage", "quantity": 20, "unit": "m2" }
    ]
  },
  "critical_fields": ["lines[*].quantity", "lines[*].unit"]
}
```

Use `raw_contains` rather than exact label matching. The label the model produces will vary with wording; what matters is that the right item was identified with the right quantity.

Populate `meta` honestly. Filtering scores by noise level or language is how you find out whether a regression is general or specific to hard audio, and a corpus of unlabelled cases cannot answer that.

## Metrics and what blocks

| Metric | Gate | Why |
|---|---|---|
| **Quantity exact-match** | ≥ 0.98 blocking | The trust-destroying failure |
| Unit exact-match | ≥ 0.95 blocking | Wrong unit means wrong price |
| Item recall | ≥ 0.92 blocking | A missing line is visible to the client |
| **Intent accuracy** | ≥ 0.95 blocking | Misrouting corrupts a real document |
| **Disambiguation precision** | = 1.00 blocking | Never answer the wrong quote |
| Client name match | ≥ 0.85 warning | Easy for the user to fix |
| Clarification rate | ≤ 0.25 warning | Friction proxy |
| p95 latency | ≤ 45 s warning | Above this, users re-send |
| Cost per quote | ≤ 1.20 MAD warning | Margin |

**Word Error Rate is deliberately not a gate.** An ASR system can misspell every word and still produce a perfect quote if the numbers and item nouns survive. Gate on what reaches the customer, not on what is easy to measure.

Warn on metrics still being calibrated; block only once a baseline has held steady and false alarms have stopped. Promote a metric from warning to blocking, never the reverse — a gate that fires spuriously gets disabled, and then it protects nothing.

## The closed loop

```
user reports a wrong quote
    → find the Langfuse trace by quote_id
    → add to corpus/dev/ with the corrected expected output
    → promote to gate/ at the next review if it represents a class of failure
```

The promotion step is what keeps the gate honest. Incidents landing straight in `gate/` means you are about to tune against them, which is the exact flaw the splits exist to prevent.

Source expected outputs from the tradesperson correcting a real output, not from writing an ideal answer. Corrections carry information invented cases do not — they show what the user actually meant, including phrasings nobody would think to invent.

## Sizing

The gate suite runs on every pull request, so it stays in the tens to low hundreds of cases. A twenty-minute eval on every PR gets disabled within a week, and a disabled gate is worse than no gate because the team believes it is protected.

The full corpus runs nightly across all ASR candidates and both prompt channels, with the leaderboard posted to Slack. That nightly run is the only way to detect a provider silently changing a checkpoint behind a stable model name.

## Reading a score change

Scores are only comparable if the calls were deterministic: `temperature=0.0`, a pinned `model_id`, and a cache key including both. Without those, run-to-run variance is indistinguishable from a real regression and every comparison below is unsound.

Before concluding a change improved things:

- Did `dev` and `test` move together? Divergence means overfitting, not improvement.
- Was the model version pinned? A floating alias means the provider may have changed underneath you.
- Did the case count change? Adding easy cases raises the mean without improving anything.
- Which slice moved? A gain concentrated in low-noise French audio with no movement on noisy Darija is not the gain you need.

## Checklist

- New case in `dev/` unless promotion was reviewed
- `tenant_ref` and `session` set, and unique to one split
- `scripts/check_split_integrity.py` passes
- Expected output sourced from a real correction where possible
- `test/` untouched
- Score interpretation accounts for slice, count and pinning
