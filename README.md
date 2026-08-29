# Claude skills — voice-to-quote WhatsApp project

Nine skills plus a `CLAUDE.md`, kept in sync with the architecture documents in
[`docs/`](docs/) — see [`docs/README.md`](docs/README.md) for the reading order.

## Layout

```
CLAUDE.md              always loaded — the nine invariants
docs/                  architecture v1 → v2 → v3 → v3.1, newest is the base
.claude/skills/        the nine skills, loaded on demand
```

Skills must be unpacked directories at `.claude/skills/<name>/SKILL.md`. A
packaged `.skill` archive, or a directory named `.skills`, is not discovered and
loads nothing — which fails silently and looks exactly like a skill that chose
not to fire.

To install into another checkout:

```bash
cp CLAUDE.md /path/to/devis-whatsapp/CLAUDE.md
mkdir -p /path/to/devis-whatsapp/.claude/skills
cp -r .claude/skills/devis-* /path/to/devis-whatsapp/.claude/skills/
```

Commit both. They are project artifacts and should be reviewed like code.

## The division

**`CLAUDE.md` is always loaded.** Nine invariants and the repo map — what must be
true in every change, short enough that its cost is negligible.

**Skills load on demand.** Each maps to a recurring task, not a topic, and carries
only what Claude would otherwise get wrong. Nothing here explains FastAPI or Alembic.

## The nine

| Skill | Fires on | Prevents |
|---|---|---|
| `devis-data-layer` | schema, migration, query, transaction boundary | a table without RLS leaking a rate card |
| `devis-messaging` | anything sent to a user | a second PDF in a client's WhatsApp |
| `devis-conversation-flow` | inbound handling, states, revisions | a clarification answering the wrong quote |
| `devis-ai-pipeline` | prompts, schemas, ASR, extraction | a hallucinated price reaching a client |
| `devis-pricing` | totals, VAT, discounts | 20 m² + 3 units = 23, and centime errors |
| `devis-error-handling` | try/except, retries, timeouts, provider down | a retried ambiguous send duplicating a PDF |
| `devis-testing` | writing any test | flaky clock-dependent tests; fakes drifting from real providers |
| `devis-evals` | corpus, thresholds, score reading | a gate that measures memorisation |
| `devis-architecture-review` | "review this", pre-merge | all of the above, silently shipped |

## Executable checks

Three scripts. `check_domain_purity.py` and `check_split_integrity.py` have been
exercised against both a violating and a clean fixture; `check_tenant_isolation.py`
needs a live database and has not been run end to end yet. Committed fixtures and a
test for all three are still owed.

```bash
python .claude/skills/devis-data-layer/scripts/check_tenant_isolation.py "$DATABASE_URL"
python .claude/skills/devis-architecture-review/scripts/check_domain_purity.py app/
python .claude/skills/devis-evals/scripts/check_split_integrity.py evals/corpus/
```

Wire the second and third into CI. The first needs a live database, so run it after
migrations in the deploy pipeline.

`check_domain_purity.py` is heuristic — it finds import violations, money fields in
extraction schemas, float arithmetic on prices, non-deterministic dedupe keys, and
network calls inside transactions. A hit is worth reading; it is not automatically a
defect, and a clean run is not a proof.

## Version history

| Version | Change |
|---|---|
| 1.0 | Seven skills from architecture v2 |
| 1.1 | `devis-error-handling` added for the v3 error taxonomy |
| 1.2 | `devis-testing` added; six skills updated for v3 and v3.1; `CLAUDE.md` invariants 6 → 9 |
| 1.3 | Skills unpacked to `.claude/skills/` — as `.skill` archives under `.claude/.skills/` they had never loaded. Docs moved to `docs/` with a reading order; v1 marked superseded; v2 given a table of the sections v3/v3.1 override. Schema: `tenant_id` added to `quote_lines`, `quote_events`, `clarifications`, `catalog_price_history`, whose RLS policies could not previously be expressed. Three script bugs fixed |

## Maintaining these

When the architecture changes, the skill changes in the **same pull request**. A skill
describing last month's design is worse than no skill, because it gets followed
confidently. Version 1.2 exists because that rule was broken once already — v3 and v3.1
shipped while six skills still described v2, and the drift was only caught by asking.

Two habits worth keeping:

- **When a review comment repeats itself**, that is a missing line in a skill.
- **When an incident happens**, add the failure mode to the relevant skill's checklist
  alongside the eval case. The skill prevents the class; the eval case catches the instance.
