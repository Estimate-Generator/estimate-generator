# Project context — voice-to-quote over WhatsApp

A tradesperson sends a WhatsApp voice note in Darija/French; the system returns a priced PDF quote within 60 seconds. Python 3.12, FastAPI, PostgreSQL 16 + pgvector, Redis + arq, Playwright.

Design docs: start at `docs/README.md`, which gives the reading order. The base spec is `docs/TECHNICAL_ARCHITECTURE.md` (v2); `docs/ARCHITECTURE_v3_HARDENING.md` and `docs/ARCHITECTURE_v3.1_PATTERNS_AND_DIAGRAMS.md` are additive and override v2 where they disagree. `docs/ARCHITECTURE_v1.md` is superseded history — never build from it. This file holds only what must be true in every change.

## Nine invariants

Not style preferences. Each exists because violating it caused, or would cause, a customer-visible incident.

**I1 — The LLM never touches money.** Extraction schemas contain `quantity` and `unit`, never `unit_price` or `total`. Prices come from the database; arithmetic comes from `app/domain/pricing.py`. A hallucinated price reaches a real end client.

**I2 — `app/domain/` is pure.** No `httpx`, no `sqlalchemy`, no provider SDKs, no `app.adapters`, no `app.db`. Enforced by `tests/test_architecture.py`. This is what makes the money code fast to test and impossible to break by accident.

**I3 — Every row carries `tenant_id`, and RLS enforces it.** Application-level filtering is the second line of defence, not the first. A leak here shows one customer another's rate card.

**I4 — Both directions are idempotent.** Inbound on `wamid`, outbound on a deterministic `dedupe_key`. A lost voice note and a duplicate PDF are the two failures the product cannot survive.

**I5 — No network call inside a database transaction.** Write intent to the `outbox` table in the same transaction as the state it describes; a poller dispatches it. At-least-once delivery plus idempotent handlers, never an attempt at exactly-once.

**I6 — Money is `Money`, quantities are `Quantity`.** Never a bare `Decimal`, never `float`. `NUMERIC(12,2)` in the schema, value objects in the domain. Rounding follows RC-1..RC-5 and is enforced in `Money.__post_init__`, so an incorrectly rounded amount cannot exist.

**I7 — Only `app/composition.py` constructs an adapter.** Everything else receives dependencies through its constructor. `grep -rn "MetaCloudProvider(" app/` returns exactly one hit. A module-level client makes tests import-order dependent and `PROVIDER_MODE=fake` meaningless.

**I8 — Nothing blocks the event loop.** `asyncio.create_subprocess_exec` not `subprocess.run`; `playwright.async_api` not the sync API; `httpx.AsyncClient` not `requests`. One blocking call stalls every concurrent quote in that worker.

**I9 — All instants are UTC.** `TIMESTAMPTZ` in the schema, UTC in the logic, `Africa/Casablanca` only at rendering and user-facing copy. Date boundaries are computed in the tenant's zone, then converted. Morocco's offset changes on 20 September 2026 — `tzdata` is pinned, with a test that fails if it is stale.

## Failures are classified, never ad hoc

Every deliberate failure is an `AppError` subclass carrying four decisions: retry, tell the user, alert, dead-letter. A bare `Exception` escaping a service is itself a defect — consult `devis-error-handling` before writing any error path.

Two that invert the instinct: **`AmbiguousOutcome` never retries** (a timed-out send may have been delivered), and **`IntegrityError` never retries** (retrying a broken invariant just breaks it repeatedly and destroys the evidence).

## Repo map

```
app/domain/          pure — entities, value objects, state machine, pricing  (I1, I2, I6)
app/composition.py   the only module that constructs adapters                (I7)
app/services/        orchestration — calls domain + adapters
app/adapters/        everything external — messaging, asr, llm, storage, pdf
app/workers/         queue entrypoints, thin
app/gateway/         HTTP surface, no business logic
app/db/              models, repositories, migrations
app/copy/fr.py       every user-facing string, one place
prompts/             versioned prompt files + registry.yaml
evals/corpus/        dev/ · gate/ · test/  — see the evals skill before touching
docs/adr/            one page per decision, written when it is made
docs/diagrams/       Mermaid sources, rendered in CI
```

The primary table is `documents` with a `kind` column, not `quotes`. Invoicing arrives with the e-invoicing mandate and shares the structure; the seam exists so that is an extension rather than a rewrite.

## Task-specific skills

Consult these rather than inferring from surrounding code:

| Task | Skill |
|---|---|
| Schema change, migration, query, transaction boundary | `devis-data-layer` |
| Sending anything to a user | `devis-messaging` |
| Inbound message type, intent, quote state, revision | `devis-conversation-flow` |
| ASR / LLM / extraction / prompt change | `devis-ai-pipeline` |
| Totals, VAT, discounts, any monetary value | `devis-pricing` |
| try/except, retries, timeouts, provider failure | `devis-error-handling` |
| Writing any test | `devis-testing` |
| Eval cases, thresholds, score interpretation | `devis-evals` |
| Reviewing a change before merge | `devis-architecture-review` |

## Conventions

- `uv` for dependencies. `ruff` for lint and format. `mypy` on `app/`.
- Tests: `unit/` needs no services; `integration/` uses testcontainers; `contract/` runs nightly against real providers.
- Local development runs on fake providers by default. `PROVIDER_MODE=real` is deliberate and rare.
- Never log transcripts, client names, phone numbers or prices above DEBUG. Log identifiers.
- French is user-facing and lives in `app/copy/fr.py`. Code, comments and commits are English.
- A decision worth arguing about gets an ADR in the same PR — especially a rejected option.
