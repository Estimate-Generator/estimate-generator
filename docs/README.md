# Architecture documents — reading order

Four documents, written in sequence. Each pass fixed what the previous one got
wrong, so they are not interchangeable and the newest is not simply "more".

**Read [`TECHNICAL_ARCHITECTURE.md`](TECHNICAL_ARCHITECTURE.md) (v2) first.** It is
the base specification and the only one that describes the whole system. Then read
v3 and v3.1, which are additive and slot into v2 at the section numbers they name.

| Document | Status | What it holds |
|---|---|---|
| [`TECHNICAL_ARCHITECTURE.md`](TECHNICAL_ARCHITECTURE.md) | **v2.0 — current base** | The build reference: 27 sections. Data model, conversation layer, state machine, delivery guarantees, AI pipeline, pricing, evals, deployment |
| [`ARCHITECTURE_v3_HARDENING.md`](ARCHITECTURE_v3_HARDENING.md) | v3.0 — additive | §A–J. Error taxonomy, deadline budget, retries and breakers, graceful shutdown, connection pools, the document seam, test infrastructure, ADRs. §A also corrects three things v2 got wrong |
| [`ARCHITECTURE_v3.1_PATTERNS_AND_DIAGRAMS.md`](ARCHITECTURE_v3.1_PATTERNS_AND_DIAGRAMS.md) | v3.1 — additive | §K–S. Composition root, value objects, aggregate boundaries, the pipeline as a saga, concurrency model, model determinism, **time zones**, pattern catalogue, Mermaid diagrams |
| [`ARCHITECTURE_v1.md`](ARCHITECTURE_v1.md) | ⛔ **superseded** | History only. Retained because its failures are instructive, not because any of it should be built |

## Where they disagree, the later document wins

v2 carries a table at the top listing every section v3 or v3.1 overrides — the
`shadow` mode removal, `quotes` becoming `documents`, `Decimal` becoming `Money`,
and so on. Check it before implementing a section, because v3 and v3.1 change
decisions as well as adding to them.

## What has a date on it

Two things, and only two:

- **20 September 2026** — Morocco moves to permanent standard time, ending the
  Ramadan clock change. Every date boundary computed in local time shifts by an
  hour across it. See v3.1 §Q; the invariant is I9 in [`../CLAUDE.md`](../CLAUDE.md).
- **January 2027** — the Moroccan e-invoicing mandate reaches this customer
  segment. It is why the `documents`/`kind` seam (v3 §G) is the one speculative
  abstraction the architecture permits.

## What must be true in every change

[`../CLAUDE.md`](../CLAUDE.md) holds the nine invariants and is short on purpose.
The task-specific skills in [`../.claude/skills/`](../.claude/skills/) carry the
detail — consult the one that matches the task rather than inferring from
surrounding code.

## Keeping these honest

When the architecture changes, the affected skill changes in the **same pull
request**. A skill describing last month's design is worse than no skill, because
it gets followed confidently. That rule has already been broken once: v3 and v3.1
shipped while six skills still described v2, and the drift was only caught by
asking.
