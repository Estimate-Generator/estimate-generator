# Technical Architecture — Voice-to-Quote over WhatsApp

> ## ⛔ SUPERSEDED — do not build from this document
>
> **Status:** v1.0, superseded by [v2.0](TECHNICAL_ARCHITECTURE.md) on 28 August 2026.
> **Retained as history**, not as a reference. Read [`README.md`](README.md) first.
>
> v1 models a *message pipeline*; the system is a *conversation*. It also assumes
> network calls either succeed or fail. Both assumptions are wrong, and the
> consequences are not cosmetic:
>
> | § | Defect | Consequence |
> |---|---|---|
> | 6, 7.2 | No transactional outbox — the enqueue happens after the commit | A crash in the gap **loses the voice note permanently**; Meta's redelivery is swallowed by `ON CONFLICT DO NOTHING` |
> | 7.5 | No outbound idempotency: no `outbound_messages`, no dedupe key, no claim | A retry after a timeout puts a **second PDF in a real client's WhatsApp** |
> | 7.2 | `statuses` never parsed | Delivery is unknown, failures unclassifiable, billing unreconcilable |
> | — | No conversation layer | Every inbound message becomes a quote request |
> | 5 | `sent` is terminal; outcome modelled as a state | Revisions have no implementation path |
> | 16 | No held-out corpus split | **Every quality number in this document is unreliable** |
> | 4.1, 21 | `accepted_at` is declared but never written | The paid follow-up feature is blind |
> | 10 | Rounding convention unstated; no golden cases | Pricing is self-consistent but unspecified |
> | 11 | Gapless quote numbering required | Serialises quote creation per tenant, for an invoice-only legal requirement |
>
> The full list, with reasons, is the changelog at the top of
> [v2](TECHNICAL_ARCHITECTURE.md). Everything below this banner is the
> original v1 text, unedited.

---

**Status:** Draft v1.0 · **Date:** 28 August 2026 · **Audience:** engineering team

This document is the build reference. It assumes zero existing code and describes the system to the level of detail where a competent engineer can start writing files without further design discussion.

---

## Table of contents

1. [Scope and hard constraints](#1-scope-and-hard-constraints)
2. [System context](#2-system-context)
3. [Component architecture](#3-component-architecture)
4. [Data model](#4-data-model)
5. [The quote state machine](#5-the-quote-state-machine)
6. [End-to-end request lifecycle](#6-end-to-end-request-lifecycle)
7. [WhatsApp integration layer](#7-whatsapp-integration-layer)
8. [The AI pipeline](#8-the-ai-pipeline)
9. [Catalog and cold-start learning](#9-catalog-and-cold-start-learning)
10. [Pricing engine](#10-pricing-engine)
11. [Document rendering](#11-document-rendering)
12. [Cost metering](#12-cost-metering)
13. [Repository layout](#13-repository-layout)
14. [Local development](#14-local-development)
15. [CI/CD pipeline](#15-cicd-pipeline)
16. [Evaluation harness](#16-evaluation-harness)
17. [Observability](#17-observability)
18. [Security and compliance](#18-security-and-compliance)
19. [Deployment topology and scaling](#19-deployment-topology-and-scaling)
20. [Failure modes and runbook](#20-failure-modes-and-runbook)
21. [Build sequence](#21-build-sequence)
22. [Open decisions](#22-open-decisions)

---

## 1. Scope and hard constraints

### 1.1 What the system does

A tradesperson sends a voice note on WhatsApp. Within 60 seconds they receive a PDF quote, correctly priced from their own rate card, ready to forward to their client.

### 1.2 Constraints that dictate the design

| # | Constraint | Architectural consequence |
|---|---|---|
| C1 | Meta requires a webhook response within a few seconds | Webhook must ACK immediately; all work goes to a queue |
| C2 | Meta redelivers webhooks on doubt | Every handler must be idempotent on `wamid` |
| C3 | Full processing takes 20–60 s | Asynchronous workers, no synchronous request path |
| C4 | Conversation is asynchronous and can pause for hours | Quote is a persisted state machine, not a function call |
| C5 | A wrong number reaches a real end client | Numeric fields need independent verification, not just accuracy |
| C6 | Every message and every audio second costs money | Per-tenant cost metering from day one |
| C7 | Each tenant has a private rate card | Multi-tenancy in the schema from the first migration |
| C8 | Darija ASR quality is unknown until measured | Provider abstraction + regression corpus before any tuning |

### 1.3 Explicit non-goals for v1

Invoicing and DGI e-invoicing compliance, payments, multi-user accounts, a web dashboard, mobile apps, multi-country support. All of these are downstream; none of them should influence v1 code beyond leaving room in the schema.

### 1.4 Target scale for v1

500 tenants, 15 000 quotes/month, peak 40 quotes/hour. This is small. The architecture below handles roughly 50× that before anything needs rethinking. Resist building for more.

---

## 2. System context

```
                    ┌──────────────────┐
                    │   Tradesperson   │
                    │  (WhatsApp app)  │
                    └────────┬─────────┘
                             │ voice note / text
                             ▼
                    ┌──────────────────┐
                    │  Meta WhatsApp   │
                    │   Cloud API      │
                    └───┬──────────┬───┘
                webhook │          │ send message / fetch media
                        ▼          │
       ┌────────────────────────────────────────┐
       │            OUR SYSTEM                  │
       │  ┌──────────┐        ┌──────────────┐  │
       │  │ Gateway  │───────▶│    Queue     │  │
       │  │ (FastAPI)│        │   (Redis)    │  │
       │  └──────────┘        └──────┬───────┘  │
       │                             ▼          │
       │                     ┌──────────────┐   │
       │                     │   Workers    │   │
       │                     └──┬────┬───┬──┘   │
       │        ┌───────────────┘    │   └────┐ │
       │        ▼                    ▼        ▼ │
       │  ┌──────────┐        ┌──────────┐ ┌────────┐
       │  │ Postgres │        │  Object  │ │Renderer│
       │  │ +pgvector│        │  Store   │ │(HTML→  │
       │  └──────────┘        └──────────┘ │  PDF)  │
       └───────────────────────────────────└────────┘
                        │
          ┌─────────────┼──────────────┐
          ▼             ▼              ▼
      ┌────────┐   ┌─────────┐   ┌──────────┐
      │  ASR   │   │   LLM   │   │ Langfuse │
      │provider│   │provider │   │ (traces) │
      └────────┘   └─────────┘   └──────────┘
```

**Trust boundary:** everything inside `OUR SYSTEM` is ours. Meta, ASR, LLM and Langfuse are external; each gets a provider interface, a timeout, a retry policy and a circuit breaker.

---

## 3. Component architecture

Single deployable image, multiple process roles. This is a *modular monolith*: one repo, one image, one dependency set, different entrypoints.

| Role | Command | Concurrency | Scaling trigger |
|---|---|---|---|
| `gateway` | `uvicorn app.gateway:app` | 2 replicas min | p99 webhook latency > 500 ms |
| `worker-ingest` | `arq app.workers.ingest` | 4 | queue depth |
| `worker-ai` | `arq app.workers.ai` | 4–20 | queue depth (the expensive one) |
| `worker-render` | `arq app.workers.render` | 2 | queue depth |
| `worker-outbound` | `arq app.workers.outbound` | 2 | rate-limited by Meta anyway |
| `scheduler` | `arq --scheduler` | 1 (singleton) | never |

Why separate AI workers: they are slow, memory-heavy and the ones you scale under load. Rendering holds a headless browser and has a very different memory profile. Mixing them means scaling the expensive resource to satisfy the cheap one.

**Queue choice:** `arq` (Redis-based, asyncio-native, ~800 lines of surface area) over Celery. Celery's feature set is not needed and its configuration surface is a liability at this size.

### 3.1 Internal module boundaries

```
app/
  gateway/        HTTP surface. Knows nothing about business logic.
  domain/         Pure Python. Entities, state machine, pricing. Zero I/O.
  services/       Orchestration. Calls domain + adapters.
  adapters/       Everything external: whatsapp, asr, llm, storage, pdf.
  workers/        Queue entrypoints. Thin — they call services.
  db/             SQLAlchemy models, migrations, repositories.
```

**Rule enforced in CI:** `domain/` may not import from `adapters/`, `db/`, or any third-party client library. It is pure, fast to test, and where all money arithmetic lives.

```python
# tests/test_architecture.py
import ast, pathlib

FORBIDDEN = {"httpx", "sqlalchemy", "redis", "openai", "anthropic", "app.adapters", "app.db"}

def test_domain_is_pure():
    for path in pathlib.Path("app/domain").rglob("*.py"):
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                names = [a.name for a in node.names]
            elif isinstance(node, ast.ImportFrom):
                names = [node.module or ""]
            else:
                continue
            for n in names:
                assert not any(n.startswith(f) for f in FORBIDDEN), f"{path}: {n}"
```

---

## 4. Data model

PostgreSQL 16 with `pgvector`. All monetary values are `NUMERIC(12,2)`. **Never `float`, never `double precision`.**

### 4.1 Core schema

```sql
-- ── Tenancy ──────────────────────────────────────────────────────────
CREATE TABLE tenants (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_name   TEXT        NOT NULL,
    legal_form      TEXT,                          -- SARL, auto-entrepreneur…
    ice             TEXT,                          -- Identifiant Commun de l'Entreprise
    rc              TEXT,
    if_number       TEXT,
    address         TEXT,
    logo_key        TEXT,                          -- object storage key
    default_vat_rate NUMERIC(5,2) NOT NULL DEFAULT 20.00,
    default_validity_days INT     NOT NULL DEFAULT 30,
    quote_counter   INT          NOT NULL DEFAULT 0,
    locale          TEXT         NOT NULL DEFAULT 'fr-MA',
    automation_mode TEXT         NOT NULL DEFAULT 'copilot'
                    CHECK (automation_mode IN ('shadow','copilot','auto')),
    status          TEXT         NOT NULL DEFAULT 'trial'
                    CHECK (status IN ('trial','active','suspended','churned')),
    plan            TEXT         NOT NULL DEFAULT 'discovery',
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- One WhatsApp number can only belong to one tenant.
CREATE TABLE tenant_phones (
    phone_e164  TEXT PRIMARY KEY,                  -- '+212661234567'
    tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    role        TEXT NOT NULL DEFAULT 'owner',
    verified_at TIMESTAMPTZ
);
CREATE INDEX ON tenant_phones (tenant_id);

-- ── Idempotency ──────────────────────────────────────────────────────
CREATE TABLE inbound_messages (
    wamid         TEXT PRIMARY KEY,                -- Meta's message id
    tenant_id     UUID REFERENCES tenants(id),
    from_phone    TEXT        NOT NULL,
    message_type  TEXT        NOT NULL,            -- audio | text | image | interactive
    raw_payload   JSONB       NOT NULL,
    received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at  TIMESTAMPTZ
);
CREATE INDEX ON inbound_messages (tenant_id, received_at DESC);

-- ── Catalog ──────────────────────────────────────────────────────────
CREATE TABLE catalog_items (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    label         TEXT         NOT NULL,           -- canonical label
    unit          TEXT         NOT NULL,           -- m2 | ml | u | forfait | h | kg
    unit_price_ht NUMERIC(12,2) NOT NULL,
    vat_rate      NUMERIC(5,2),                    -- NULL → tenant default
    category      TEXT,
    embedding     VECTOR(1024),
    usage_count   INT          NOT NULL DEFAULT 0,
    last_used_at  TIMESTAMPTZ,
    confirmed     BOOLEAN      NOT NULL DEFAULT FALSE,  -- user validated the price
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX ON catalog_items (tenant_id);
CREATE INDEX ON catalog_items USING hnsw (embedding vector_cosine_ops);
CREATE INDEX catalog_label_trgm ON catalog_items USING gin (label gin_trgm_ops);

-- Every spoken variant ever mapped to a catalog item. This is the moat.
CREATE TABLE catalog_aliases (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    catalog_item_id UUID NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
    raw_text        TEXT NOT NULL,                 -- "carro grand format"
    embedding       VECTOR(1024),
    hit_count       INT  NOT NULL DEFAULT 1,
    UNIQUE (tenant_id, catalog_item_id, raw_text)
);
CREATE INDEX ON catalog_aliases USING hnsw (embedding vector_cosine_ops);

-- ── Clients ──────────────────────────────────────────────────────────
CREATE TABLE clients (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    phone      TEXT,
    address    TEXT,
    ice        TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON clients (tenant_id);

-- ── Quotes ───────────────────────────────────────────────────────────
CREATE TABLE quotes (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    client_id      UUID REFERENCES clients(id),
    number         TEXT,                           -- 'DEV-2026-0042', assigned at render
    state          TEXT NOT NULL DEFAULT 'received',
    source_wamid   TEXT REFERENCES inbound_messages(wamid),
    transcript     TEXT,
    transcript_confidence NUMERIC(4,3),
    asr_provider   TEXT,
    subtotal_ht    NUMERIC(12,2),
    vat_amount     NUMERIC(12,2),
    total_ttc      NUMERIC(12,2),
    vat_rate       NUMERIC(5,2),
    discount_pct   NUMERIC(5,2) NOT NULL DEFAULT 0,
    valid_until    DATE,
    pdf_key        TEXT,
    sent_at        TIMESTAMPTZ,
    accepted_at    TIMESTAMPTZ,
    audio_key      TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON quotes (tenant_id, created_at DESC);
CREATE INDEX ON quotes (state) WHERE state NOT IN ('sent','failed','cancelled');
CREATE UNIQUE INDEX ON quotes (tenant_id, number) WHERE number IS NOT NULL;

CREATE TABLE quote_lines (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    quote_id         UUID NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
    position         INT  NOT NULL,
    raw_text         TEXT NOT NULL,                -- what was heard
    catalog_item_id  UUID REFERENCES catalog_items(id),
    label            TEXT NOT NULL,                -- what is printed
    quantity         NUMERIC(12,3) NOT NULL,
    unit             TEXT NOT NULL,
    unit_price_ht    NUMERIC(12,2) NOT NULL,
    line_total_ht    NUMERIC(12,2) NOT NULL,
    vat_rate         NUMERIC(5,2)  NOT NULL,
    match_score      NUMERIC(4,3),
    match_method     TEXT,                         -- exact | alias | vector | trigram | created
    quantity_verified BOOLEAN NOT NULL DEFAULT FALSE,
    UNIQUE (quote_id, position)
);

-- Full audit of every state transition. Never delete.
CREATE TABLE quote_events (
    id         BIGSERIAL PRIMARY KEY,
    quote_id   UUID NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
    from_state TEXT,
    to_state   TEXT NOT NULL,
    actor      TEXT NOT NULL,                      -- system | user | operator
    payload    JSONB,
    trace_id   TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON quote_events (quote_id, created_at);

-- ── Pending questions (the async clarification loop) ─────────────────
CREATE TABLE clarifications (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    quote_id    UUID NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
    field_path  TEXT NOT NULL,                     -- 'lines[2].quantity'
    question    TEXT NOT NULL,
    options     JSONB,                             -- for interactive buttons
    asked_at    TIMESTAMPTZ,
    answered_at TIMESTAMPTZ,
    answer      JSONB,
    expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX ON clarifications (quote_id) WHERE answered_at IS NULL;

-- ── Cost metering ────────────────────────────────────────────────────
CREATE TABLE usage_events (
    id          BIGSERIAL PRIMARY KEY,
    tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    quote_id    UUID REFERENCES quotes(id) ON DELETE SET NULL,
    kind        TEXT NOT NULL,   -- wa_message_in | wa_message_out | asr_seconds
                                 -- | llm_tokens_in | llm_tokens_out | embedding | render
    quantity    NUMERIC(12,4) NOT NULL,
    unit_cost   NUMERIC(12,6) NOT NULL,            -- snapshot at time of use
    cost_mad    NUMERIC(12,4) NOT NULL,
    provider    TEXT,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON usage_events (tenant_id, occurred_at DESC);
CREATE INDEX ON usage_events (occurred_at) WHERE quote_id IS NOT NULL;
```

### 4.2 Row-level security

Application-level filtering is not enough. A single forgotten `WHERE tenant_id = …` leaks one customer's rate card to another. Enforce in the database:

```sql
ALTER TABLE catalog_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON catalog_items
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
-- repeat for quotes, quote_lines, clients, catalog_aliases, usage_events
```

The application sets `SET LOCAL app.tenant_id = …` at the start of every request-scoped transaction:

```python
@asynccontextmanager
async def tenant_session(engine, tenant_id: UUID):
    async with AsyncSession(engine) as s:
        async with s.begin():
            await s.execute(text("SET LOCAL app.tenant_id = :t"), {"t": str(tenant_id)})
            yield s
```

Workers that legitimately cross tenants (metering rollups) use a separate DB role with `BYPASSRLS`. That role is never used by request-handling code.

### 4.3 Migrations

Alembic, autogenerate reviewed by hand every time. Two rules:

- **Migrations run as a separate CI step**, never on application startup. With N replicas, startup migrations race.
- **Expand/contract for anything destructive.** Add column → deploy code writing both → backfill → deploy code reading new → drop old. Four deploys, zero downtime, and it is the only pattern that survives a rollback.

---

## 5. The quote state machine

```
                  ┌──────────┐
                  │ received │
                  └────┬─────┘
                       ▼
                ┌─────────────┐   audio unusable
                │ transcribing│──────────────┐
                └──────┬──────┘              │
                       ▼                     │
                 ┌───────────┐               │
                 │ extracting│───────────────┤
                 └─────┬─────┘               │
                       ▼                     │
                 ┌──────────┐                │
                 │ matching │                │
                 └────┬─────┘                │
            ┌─────────┴─────────┐            │
            ▼                   ▼            │
   ┌──────────────────┐   ┌──────────┐       │
   │needs_clarification│  │  priced  │       │
   └────┬─────────┬────┘  └────┬─────┘       │
        │ answer  │ timeout    │             │
        └────►────┘            ▼             │
             │           ┌──────────┐        │
             │           │ rendering│        │
             ▼           └────┬─────┘        │
        ┌─────────┐           ▼              │
        │ expired │     ┌────────────┐       │
        └─────────┘     │awaiting_   │ (copilot mode only)
                        │  approval  │       │
                        └─────┬──────┘       │
                              ▼              ▼
                        ┌──────────┐   ┌─────────┐
                        │   sent   │   │ failed  │
                        └────┬─────┘   └─────────┘
                             ▼
                    ┌────────────────┐
                    │ accepted /     │
                    │ refused / cold │
                    └────────────────┘
```

Encoded as data, not `if` statements:

```python
# app/domain/state_machine.py
from enum import StrEnum

class QuoteState(StrEnum):
    RECEIVED = "received"
    TRANSCRIBING = "transcribing"
    EXTRACTING = "extracting"
    MATCHING = "matching"
    NEEDS_CLARIFICATION = "needs_clarification"
    PRICED = "priced"
    RENDERING = "rendering"
    AWAITING_APPROVAL = "awaiting_approval"
    SENT = "sent"
    ACCEPTED = "accepted"
    REFUSED = "refused"
    EXPIRED = "expired"
    FAILED = "failed"
    CANCELLED = "cancelled"

TRANSITIONS: dict[QuoteState, set[QuoteState]] = {
    QuoteState.RECEIVED:            {QuoteState.TRANSCRIBING, QuoteState.EXTRACTING, QuoteState.FAILED},
    QuoteState.TRANSCRIBING:        {QuoteState.EXTRACTING, QuoteState.FAILED},
    QuoteState.EXTRACTING:          {QuoteState.MATCHING, QuoteState.NEEDS_CLARIFICATION, QuoteState.FAILED},
    QuoteState.MATCHING:            {QuoteState.PRICED, QuoteState.NEEDS_CLARIFICATION, QuoteState.FAILED},
    QuoteState.NEEDS_CLARIFICATION: {QuoteState.MATCHING, QuoteState.PRICED, QuoteState.EXPIRED, QuoteState.CANCELLED},
    QuoteState.PRICED:              {QuoteState.RENDERING, QuoteState.NEEDS_CLARIFICATION, QuoteState.FAILED},
    QuoteState.RENDERING:           {QuoteState.AWAITING_APPROVAL, QuoteState.SENT, QuoteState.FAILED},
    QuoteState.AWAITING_APPROVAL:   {QuoteState.SENT, QuoteState.CANCELLED, QuoteState.EXPIRED},
    QuoteState.SENT:                {QuoteState.ACCEPTED, QuoteState.REFUSED, QuoteState.EXPIRED},
}

class IllegalTransition(Exception): ...

def assert_can(frm: QuoteState, to: QuoteState) -> None:
    if to not in TRANSITIONS.get(frm, set()):
        raise IllegalTransition(f"{frm} -> {to}")
```

Transitions are persisted atomically with an optimistic guard, so two workers racing on the same quote cannot both advance it:

```python
async def transition(session, quote_id, frm, to, actor, payload=None, trace_id=None):
    assert_can(frm, to)
    res = await session.execute(
        update(Quote)
        .where(Quote.id == quote_id, Quote.state == frm)   # ← the guard
        .values(state=to, updated_at=func.now())
        .returning(Quote.id)
    )
    if res.scalar_one_or_none() is None:
        raise ConcurrentTransition(quote_id, frm, to)
    session.add(QuoteEvent(quote_id=quote_id, from_state=frm, to_state=to,
                           actor=actor, payload=payload, trace_id=trace_id))
```

---

## 6. End-to-end request lifecycle

```
t=0.0s   Meta POST /webhooks/whatsapp
t=0.01s  verify X-Hub-Signature-256 (HMAC-SHA256, constant-time)
t=0.02s  INSERT inbound_messages ON CONFLICT (wamid) DO NOTHING
         → 0 rows affected? duplicate. return 200 and stop.
t=0.03s  resolve tenant from `from` phone
t=0.04s  enqueue ingest job
t=0.05s  return 200 OK                    ◄── Meta is satisfied here

--- async from this point ---

t=0.1s   [worker-ingest] GET /{media_id} → media URL
t=0.5s   download audio (OGG/Opus), stream to object storage
t=0.7s   ffmpeg → 16 kHz mono WAV
t=0.8s   create quote (state=received), enqueue ai job
t=0.9s   send "reçu, je prépare le devis…" (throttled: max 1/quote)

t=1.0s   [worker-ai] path A: ASR → transcript + per-segment confidence
t=6.0s   [worker-ai] path B: audio-in multimodal extraction (parallel)
t=8.0s   extraction from transcript (Instructor/Pydantic)
t=9.0s   reconcile numerics between path A and path B
t=9.1s   catalog matching per line
t=9.3s   any unresolved field? → needs_clarification, ask, stop
t=9.4s   pricing (pure domain code)
t=9.5s   enqueue render job

t=10s    [worker-render] Jinja2 → HTML → Playwright → PDF → object storage
t=13s    assign quote number (atomic counter increment)
t=13.1s  automation_mode == 'auto'? → enqueue outbound
         automation_mode == 'copilot'? → awaiting_approval, notify operator

t=14s    [worker-outbound] send document message via Meta
t=15s    state=sent, record usage_events
```

The user-visible latency target is **under 45 s at p95**. Anything above 90 s and the user re-sends the voice note, which is why idempotency and the throttled acknowledgement matter.

---

## 7. WhatsApp integration layer

### 7.1 Webhook verification (GET)

```python
@router.get("/webhooks/whatsapp")
async def verify(request: Request):
    p = request.query_params
    if p.get("hub.mode") == "subscribe" and \
       hmac.compare_digest(p.get("hub.verify_token", ""), settings.WA_VERIFY_TOKEN):
        return PlainTextResponse(p.get("hub.challenge", ""))
    raise HTTPException(403)
```

### 7.2 Signature verification (POST)

Meta signs the raw body. You must verify against **bytes**, not a re-serialised dict — key ordering will differ and every signature will fail.

```python
@router.post("/webhooks/whatsapp")
async def receive(request: Request, background: BackgroundTasks):
    raw = await request.body()
    sig = request.headers.get("X-Hub-Signature-256", "")
    expected = "sha256=" + hmac.new(
        settings.WA_APP_SECRET.encode(), raw, hashlib.sha256
    ).hexdigest()
    if not hmac.compare_digest(sig, expected):
        logger.warning("bad_signature")
        raise HTTPException(403)

    payload = json.loads(raw)
    for wamid, msg, phone in iter_messages(payload):
        inserted = await store_if_new(wamid, msg, phone, raw_payload=payload)
        if inserted:
            await queue.enqueue_job("ingest_message", wamid)
    return Response(status_code=200)
```

**Always return 200**, even on internal error — a non-200 makes Meta retry, and a retry on a bug is a retry loop. Errors go to the dead-letter table, not to the HTTP status code.

### 7.3 Media download

Two calls. The URL from step one is short-lived (minutes) and requires the bearer token on the download too.

```python
async def fetch_media(media_id: str) -> tuple[bytes, str]:
    async with httpx.AsyncClient(timeout=30) as c:
        meta = (await c.get(f"{GRAPH}/{media_id}", headers=AUTH)).json()
        blob = await c.get(meta["url"], headers=AUTH)     # auth required here too
        return blob.content, meta["mime_type"]            # audio/ogg; codecs=opus
```

Store the raw original before any processing. It is your training corpus and your only evidence when a user disputes a quote.

### 7.4 The 24-hour window

Free-form replies are only allowed inside the 24-hour customer service window, and the economics of that window changed on 1 October 2026 — service and utility messages inside it are now billable. Design accordingly:

- Track `last_inbound_at` per tenant phone.
- Outside the window, only approved templates may be sent. Keep a small set: `quote_ready`, `clarification_needed`, `followup_reminder`.
- **Batch outbound.** Do not send "received", then "transcribing", then "here it is". Send one acknowledgement and one result. Each extra message is a line item on the bill.

### 7.5 Provider abstraction

```python
class MessagingProvider(Protocol):
    async def send_text(self, to: str, body: str) -> str: ...
    async def send_document(self, to: str, url: str, filename: str, caption: str | None) -> str: ...
    async def send_buttons(self, to: str, body: str, buttons: list[Button]) -> str: ...
    async def fetch_media(self, media_id: str) -> tuple[bytes, str]: ...
```

Implementations: `MetaCloudProvider`, plus `FakeProvider` for tests and local dev. **No unofficial WhatsApp Web automation libraries** — they work in demos and get the number banned at volume.

---

## 8. The AI pipeline

### 8.1 Governing principle

> The LLM extracts intent. Deterministic code computes money.

No model output is ever multiplied by anything. The LLM returns items, quantities and units. Prices come from the database. Arithmetic comes from `domain/pricing.py`, which is covered by ordinary unit tests.

### 8.2 ASR provider interface

```python
@dataclass(frozen=True)
class Segment:
    text: str
    start: float
    end: float
    confidence: float | None

@dataclass(frozen=True)
class Transcript:
    text: str
    segments: list[Segment]
    language: str
    duration_s: float
    provider: str
    mean_confidence: float

class ASRProvider(Protocol):
    name: str
    async def transcribe(self, wav: bytes, *, language_hint: str = "ary") -> Transcript: ...
```

Candidate implementations to benchmark against your own corpus:

| Provider | Notes |
|---|---|
| `atlasia/moulsot.v0.3` | Purpose-built for Darija, explicitly robust to Darija↔French↔Arabic code-switching; top of the public Darija ASR leaderboard. First candidate. |
| `anaszil/whisper-large-v3-turbo-darija` | LoRA adapter on Whisper Large v3 Turbo. Lighter to self-host. |
| `speechbrain/asr-wav2vec2-dvoice-darija` | wav2vec2 + CTC on the DVoice corpus. Older baseline, useful as a floor. |
| Commercial API (Whisper/Gemini/etc.) | Baseline and fallback. Zero fixed cost, weaker on Darija. |

Serve self-hosted models behind vLLM or a small FastAPI + `transformers` service with its own queue. Do **not** load a model inside the worker process — it makes worker scaling a GPU-scaling problem.

Selection is per-tenant and per-attempt, driven by config, so a bad model can be swapped without a deploy:

```python
ASR_ROUTING = {
    "default":  ["moulsot_v03", "commercial_fallback"],
    "fr_heavy": ["commercial_fallback", "moulsot_v03"],
}
```

### 8.3 Extraction

`instructor` + Pydantic. It is the default choice for production structured output: fastest path to working code, multi-provider, and automatic retries that feed the validation error back to the model so it can self-correct.

```python
class ExtractedLine(BaseModel):
    raw_text: str = Field(description="verbatim words describing this item")
    quantity: Decimal | None
    unit: Literal["m2","ml","u","forfait","h","kg","m3"] | None
    quantity_confidence: float = Field(ge=0, le=1)
    notes: str | None = None

class ExtractedQuote(BaseModel):
    client_name: str | None
    client_phone: str | None
    lines: list[ExtractedLine]
    vat_rate: Decimal | None = None
    discount_pct: Decimal | None = None
    language_detected: Literal["fr","ary","mixed"]

    @field_validator("lines")
    @classmethod
    def non_empty(cls, v):
        if not v:
            raise ValueError("at least one line is required")
        return v
```

Note what is **absent**: no `unit_price`, no `total`. The schema makes the governing principle structurally impossible to violate.

### 8.4 Dual-path numeric reconciliation

The failure that destroys trust is `20 m²` heard as `200 m²`. A single pipeline cannot audit itself.

```python
async def extract_with_verification(audio_wav: bytes, ctx: TenantContext) -> ExtractedQuote:
    transcript, direct = await asyncio.gather(
        asr.transcribe(audio_wav),                   # path A
        multimodal.extract_from_audio(audio_wav),    # path B
    )
    primary = await llm_extract(transcript.text, ctx)

    for i, line in enumerate(primary.lines):
        b = direct.line_at(i)
        if b is None or b.quantity != line.quantity or b.unit != line.unit:
            line.quantity_confidence = min(line.quantity_confidence, 0.4)
        if seg_conf := transcript.confidence_covering(line.raw_text):
            line.quantity_confidence = min(line.quantity_confidence, seg_conf)
    return primary
```

Any line below `QUANTITY_CONFIDENCE_THRESHOLD` (start at 0.75, tune from the corpus) triggers a targeted clarification — one question about one number, not a re-do of the whole quote.

This converts an unsolvable accuracy problem into a tractable *uncertainty detection* problem. Path B only needs to run on numeric fields, so its marginal cost is small.

### 8.5 Clarification loop

```python
QUESTION_TEMPLATES = {
    "quantity": "Pour {label}, c'est bien {qty} {unit} ?",
    "unit":     "{label} : au m² ou au forfait ?",
    "price":    "Le {label}, à combien est-il facturé le {unit} ?",
    "client":   "Le devis est au nom de qui ?",
}
```

Rules that keep this from becoming a chatbot:

- **One question per message.** Batching questions produces partial answers you cannot map back.
- **Interactive buttons where the answer is closed** (unit, yes/no). Buttons are unambiguous and require no parsing.
- **Expiry at 24 h.** `awaiting_user` → `expired`, with the partial quote retained.
- **Maximum three clarification rounds** per quote. Beyond that, hand off to a human operator. A system that asks four questions has failed at its promise of zero friction.

---

## 9. Catalog and cold-start learning

### 9.1 Matching cascade

Cheapest and most certain first:

```python
async def match_line(session, tenant_id, raw_text, unit_hint) -> MatchResult:
    # 1 · exact alias — free, certain
    if hit := await find_alias_exact(session, tenant_id, normalize(raw_text)):
        return MatchResult(hit.item, 1.0, "alias")

    # 2 · trigram similarity — cheap, handles typos and ASR noise
    if hit := await trigram_search(session, tenant_id, raw_text, threshold=0.55):
        return MatchResult(hit.item, hit.score, "trigram")

    # 3 · vector search — semantic, handles genuine synonyms
    emb = await embed(raw_text)
    if hit := await vector_search(session, tenant_id, emb, threshold=0.82):
        return MatchResult(hit.item, hit.score, "vector")

    # 4 · unknown — ask, never invent
    return MatchResult(None, 0.0, "unmatched")
```

`normalize()` handles the messy reality: lowercase, strip accents, collapse whitespace, map Arabic-Indic digits, and canonicalise unit words (`mètre carré` / `m2` / `m²` / `metre carre` → `m2`).

### 9.2 The cold start

A new tenant has an empty catalog. The first quote is the moment they judge the product, and it is the moment the system knows the least. This is handled by design, not by hope:

1. **Onboarding capture (5 min, conversational).** "Send me a voice note listing your usual services and prices." One message produces 10–20 catalog items. This alone removes most of the cold start.
2. **Learn on the fly.** Unmatched item → ask the price once → create the item with `confirmed = true` → never ask again.
3. **Alias accumulation.** Every raw phrase that resolves to an item is written to `catalog_aliases`. Match quality improves monotonically with usage.
4. **Trade starter packs.** After 20–30 tenants in a trade, ship an anonymised, aggregated median-price template for plumbing, tiling, aluminium joinery. Prices are pre-filled and editable in the first conversation. This is the compounding advantage of having data — and note it delivers value at *onboarding*, which is where dashboards never would.

### 9.3 Price drift

Prices change. Flag items untouched for 90 days:

> "Le carrelage est toujours à 180 DH le m² ?"

Cheap, useful, and it keeps the catalog trustworthy without an interface.

---

## 10. Pricing engine

Pure, synchronous, zero I/O, exhaustively tested. This is the only place money is computed.

```python
# app/domain/pricing.py
from decimal import Decimal, ROUND_HALF_UP

CENTS = Decimal("0.01")

def q2(x: Decimal) -> Decimal:
    return x.quantize(CENTS, rounding=ROUND_HALF_UP)

@dataclass(frozen=True)
class PricedLine:
    label: str; quantity: Decimal; unit: str
    unit_price_ht: Decimal; vat_rate: Decimal
    @property
    def total_ht(self) -> Decimal: return q2(self.quantity * self.unit_price_ht)

@dataclass(frozen=True)
class PricedQuote:
    lines: tuple[PricedLine, ...]
    discount_pct: Decimal = Decimal(0)

    @property
    def subtotal_ht(self) -> Decimal:
        return q2(sum((l.total_ht for l in self.lines), Decimal(0)))

    @property
    def discount(self) -> Decimal:
        return q2(self.subtotal_ht * self.discount_pct / 100)

    @property
    def net_ht(self) -> Decimal:
        return q2(self.subtotal_ht - self.discount)

    @property
    def vat_by_rate(self) -> dict[Decimal, Decimal]:
        """VAT computed per rate band, not on the global total."""
        buckets: dict[Decimal, Decimal] = {}
        ratio = (self.net_ht / self.subtotal_ht) if self.subtotal_ht else Decimal(1)
        for l in self.lines:
            buckets[l.vat_rate] = buckets.get(l.vat_rate, Decimal(0)) + l.total_ht * ratio
        return {r: q2(base * r / 100) for r, base in buckets.items()}

    @property
    def total_ttc(self) -> Decimal:
        return q2(self.net_ht + sum(self.vat_by_rate.values(), Decimal(0)))
```

Two details that are wrong in most naive implementations and produce customer-visible errors: **VAT is computed per rate band**, and **the discount is applied proportionally across bands** before VAT.

Test with property-based testing:

```python
@given(lines=st.lists(priced_lines(), min_size=1, max_size=30))
def test_totals_reconcile(lines):
    q = PricedQuote(tuple(lines))
    assert q.total_ttc == q2(q.net_ht + sum(q.vat_by_rate.values(), Decimal(0)))
    assert q.total_ttc >= q.net_ht
```

---

## 11. Document rendering

**Jinja2 → HTML → Playwright (Chromium) → PDF.** Iteration on layout is CSS, not a report DSL, which matters because the template will change 50 times in the first two months.

```python
async def render(quote: PricedQuote, tenant: Tenant) -> bytes:
    html = env.get_template("quote_fr.html").render(quote=quote, tenant=tenant)
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(args=["--no-sandbox"])
        page = await browser.new_page()
        await page.set_content(html, wait_until="networkidle")
        pdf = await page.pdf(format="A4", print_background=True,
                             margin={"top":"12mm","bottom":"14mm","left":"12mm","right":"12mm"})
        await browser.close()
        return pdf
```

Operational notes:

- **Reuse one browser instance per worker.** Launching Chromium per render costs 800 ms and a lot of memory.
- **Cap concurrency at 2 per worker.** Chromium is memory-hungry; OOM kills are the most common render failure.
- **Bundle fonts in the image.** Missing fonts produce silent tofu boxes in production and look fine locally.
- **Snapshot-test the template**: render a fixed quote, rasterise, compare against a committed reference image with a tolerance. Catches CSS regressions no unit test will.

Quote numbering must be atomic and gapless per tenant:

```sql
UPDATE tenants SET quote_counter = quote_counter + 1
WHERE id = :tenant_id RETURNING quote_counter;
```

Assign the number at render time, not at creation — abandoned quotes must not consume numbers.

---

## 12. Cost metering

Every external call writes a `usage_events` row in the same transaction as its result. Not a metrics counter — a database row, because this drives pricing decisions.

```python
async def meter(session, tenant_id, kind, quantity, provider, quote_id=None):
    unit_cost = PRICE_BOOK[kind][provider]          # versioned, in config
    session.add(UsageEvent(
        tenant_id=tenant_id, quote_id=quote_id, kind=kind,
        quantity=Decimal(str(quantity)), unit_cost=unit_cost,
        cost_mad=q2(Decimal(str(quantity)) * unit_cost), provider=provider,
    ))
```

Daily rollup, and the one number that decides whether the business works:

```sql
SELECT
    t.id, t.business_name, t.plan,
    count(DISTINCT q.id)                              AS quotes,
    round(sum(u.cost_mad), 2)                         AS cost_mad,
    round(sum(u.cost_mad) / nullif(count(DISTINCT q.id), 0), 2) AS cost_per_quote,
    p.monthly_price_mad - sum(u.cost_mad)             AS margin_mad
FROM tenants t
JOIN usage_events u ON u.tenant_id = t.id
LEFT JOIN quotes q ON q.tenant_id = t.id AND q.created_at >= date_trunc('month', now())
JOIN plans p ON p.code = t.plan
WHERE u.occurred_at >= date_trunc('month', now())
GROUP BY t.id, t.business_name, t.plan, p.monthly_price_mad
ORDER BY margin_mad ASC;                              -- worst first
```

Add a hard guard: if a tenant's monthly cost exceeds 2× their plan price, alert; at 3×, throttle and require a conversation. An unbounded free tier on a per-message-cost product is a way to lose money at scale.

---

## 13. Repository layout

```
devis-whatsapp/
├── app/
│   ├── gateway/            main.py, webhooks.py, health.py, admin.py
│   ├── domain/             ← pure, no I/O
│   │   ├── entities.py     Quote, Line, Tenant, CatalogItem
│   │   ├── state_machine.py
│   │   ├── pricing.py
│   │   ├── units.py        normalisation & conversion
│   │   └── numbering.py
│   ├── services/           ingest.py, transcription.py, extraction.py,
│   │                       matching.py, quoting.py, clarification.py, metering.py
│   ├── adapters/
│   │   ├── messaging/      base.py, meta_cloud.py, fake.py
│   │   ├── asr/            base.py, moulsot.py, whisper_api.py, fake.py
│   │   ├── llm/            base.py, instructor_client.py, fake.py
│   │   ├── storage/        base.py, s3.py, local.py
│   │   └── pdf/            playwright_renderer.py
│   ├── workers/            ingest.py, ai.py, render.py, outbound.py, scheduler.py
│   ├── db/                 models.py, session.py, repositories/
│   └── config.py           pydantic-settings, fail-fast on missing vars
├── migrations/             alembic
├── templates/              quote_fr.html, quote_ar.html, styles.css, fonts/
├── prompts/                extraction.v3.jinja  ← versioned, never inline
├── evals/
│   ├── corpus/             *.ogg + *.expected.json   (git-lfs)
│   ├── promptfooconfig.yaml
│   └── report.py
├── tests/
│   ├── unit/               domain — fast, no I/O
│   ├── integration/        testcontainers: postgres + redis
│   ├── e2e/                fake providers, full flow
│   └── test_architecture.py
├── ops/
│   ├── Dockerfile
│   ├── docker-compose.yml
│   └── runbook.md
└── .github/workflows/      ci.yml, deploy.yml, evals-nightly.yml
```

**Prompts live in `prompts/` as versioned files**, referenced by name and version. A prompt inlined in Python cannot be diffed, reviewed, evaluated or rolled back independently of code.

---

## 14. Local development

```yaml
# ops/docker-compose.yml
services:
  db:
    image: pgvector/pgvector:pg16
    environment: { POSTGRES_PASSWORD: dev, POSTGRES_DB: devis }
    ports: ["5432:5432"]
    volumes: [pgdata:/var/lib/postgresql/data]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s

  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]

  minio:
    image: minio/minio
    command: server /data --console-address ":9001"
    environment: { MINIO_ROOT_USER: dev, MINIO_ROOT_PASSWORD: devdevdev }
    ports: ["9000:9000", "9001:9001"]

  langfuse:
    image: langfuse/langfuse:latest
    depends_on: [db]
    environment:
      DATABASE_URL: postgresql://postgres:dev@db:5432/langfuse
      NEXTAUTH_SECRET: dev
    ports: ["3000:3000"]

  api:
    build: { context: .., dockerfile: ops/Dockerfile }
    command: uvicorn app.gateway.main:app --reload --host 0.0.0.0
    volumes: ["..:/srv"]
    env_file: [../.env.local]
    depends_on: { db: { condition: service_healthy } }
    ports: ["8000:8000"]

  worker:
    build: { context: .., dockerfile: ops/Dockerfile }
    command: arq app.workers.ai.WorkerSettings
    volumes: ["..:/srv"]
    env_file: [../.env.local]

volumes: { pgdata: }
```

Receiving real Meta webhooks locally:

```bash
cloudflared tunnel --url http://localhost:8000
# register the printed https URL in the Meta app dashboard (dev app only)
```

Default local config uses `FakeProvider` for messaging, ASR and LLM, so the whole flow runs offline with no API keys and no cost. Only set `PROVIDER_MODE=real` when specifically testing integration.

---

## 15. CI/CD pipeline

### 15.1 Pull request

```yaml
# .github/workflows/ci.yml
name: ci
on: pull_request

jobs:
  static:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v3
      - run: uv sync --frozen
      - run: uv run ruff check . && uv run ruff format --check .
      - run: uv run mypy app
      - run: uv run bandit -r app -ll

  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: pgvector/pgvector:pg16
        env: { POSTGRES_PASSWORD: test }
        options: >-
          --health-cmd pg_isready --health-interval 5s --health-retries 10
        ports: ["5432:5432"]
      redis:
        image: redis:7-alpine
        ports: ["6379:6379"]
    steps:
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v3
      - run: uv sync --frozen
      - run: uv run alembic upgrade head
      - run: uv run pytest tests/unit tests/integration tests/e2e
                --cov=app --cov-fail-under=80
      - name: migrations are reversible
        run: uv run alembic downgrade -1 && uv run alembic upgrade head

  evals:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { lfs: true }
      - uses: astral-sh/setup-uv@v3
      - run: uv sync --frozen
      - name: extraction regression gate
        env: { LLM_API_KEY: ${{ secrets.LLM_API_KEY_EVAL }} }
        run: uv run python evals/run.py --suite pr --fail-under 0.92
      - uses: actions/github-script@v7
        if: always()
        with:
          script: |                       # post the score table as a PR comment
            const fs = require('fs');
            const body = fs.readFileSync('evals/report.md', 'utf8');
            github.rest.issues.createComment({ ...context.repo,
              issue_number: context.issue.number, body });

  build:
    needs: [static, test]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/build-push-action@v6
        with:
          context: .
          file: ops/Dockerfile
          push: false
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

### 15.2 Deploy

```yaml
# .github/workflows/deploy.yml
name: deploy
on:
  push: { branches: [main] }
  workflow_dispatch: { inputs: { environment: { required: true } } }

jobs:
  image:
    runs-on: ubuntu-latest
    permissions: { contents: read, packages: write }
    outputs: { digest: ${{ steps.push.outputs.digest }} }
    steps:
      - uses: actions/checkout@v4
      - uses: docker/login-action@v3
        with: { registry: ghcr.io, username: ${{ github.actor }},
                password: ${{ secrets.GITHUB_TOKEN }} }
      - id: push
        uses: docker/build-push-action@v6
        with:
          context: .
          file: ops/Dockerfile
          push: true
          tags: |
            ghcr.io/${{ github.repository }}:${{ github.sha }}
            ghcr.io/${{ github.repository }}:latest

  staging:
    needs: image
    runs-on: ubuntu-latest
    environment: staging
    steps:
      - name: migrate
        run: ./ops/run-migrations.sh staging ${{ needs.image.outputs.digest }}
      - name: deploy
        run: ./ops/deploy.sh staging ${{ needs.image.outputs.digest }}
      - name: smoke
        run: ./ops/smoke.sh https://staging.api.internal

  production:
    needs: staging
    runs-on: ubuntu-latest
    environment: production      # ← requires manual approval in GitHub
    steps:
      - name: migrate
        run: ./ops/run-migrations.sh production ${{ needs.image.outputs.digest }}
      - name: canary (5 tenants)
        run: ./ops/deploy.sh production ${{ needs.image.outputs.digest }} --canary
      - name: watch error rate 10 min
        run: ./ops/watch-canary.sh || (./ops/rollback.sh production && exit 1)
      - name: full rollout
        run: ./ops/deploy.sh production ${{ needs.image.outputs.digest }}
```

Three things this pipeline gets right:

- **Migrations are a separate step**, run once, before any new container starts.
- **Deploy by digest, not tag.** Tags are mutable; digests are what you actually rolled back to.
- **Canary by tenant, not by traffic percentage.** In a multi-tenant system the variance comes from the tenant's trade, not from request volume. Five known tenants who have agreed to be early is a far better signal than 5% of traffic.

### 15.3 Environment separation

| | staging | production |
|---|---|---|
| WhatsApp number | dedicated test number | real number |
| Meta app | dev app | live app |
| Database | separate instance | separate instance |
| LLM/ASR keys | separate, budget-capped | production |
| Tenants | seeded fixtures | real customers |

Never point staging at the production WhatsApp number. A bug in staging then messages real tradespeople.

---

## 16. Evaluation harness

This is what separates a demo from a product. Two complementary layers.

### 16.1 Golden dataset

```
evals/corpus/
  001_carrelage_fr.ogg
  001_carrelage_fr.expected.json
  002_menuiserie_darija.ogg
  002_menuiserie_darija.expected.json
  ...
```

```json
{
  "id": "002_menuiserie_darija",
  "meta": { "trade": "menuiserie", "language": "mixed",
            "noise": "high", "duration_s": 19.4, "source": "field_test_w1" },
  "expected": {
    "client_name": "Alami",
    "lines": [
      { "raw_contains": "fenêtre", "quantity": 3,  "unit": "u"  },
      { "raw_contains": "carrelage", "quantity": 20, "unit": "m2" }
    ]
  },
  "critical_fields": ["lines[*].quantity", "lines[*].unit"]
}
```

**Sizing:** keep the PR suite small enough to run on every pull request — tens to low hundreds of cases — and reserve the full set for release branches and the nightly job. This is the standard guidance and it is right: a 20-minute eval on every PR will be disabled within a week.

### 16.2 Metrics that matter

| Metric | Gate | Why |
|---|---|---|
| **Quantity exact-match rate** | ≥ 0.98 blocking | The trust-destroying failure |
| Unit exact-match rate | ≥ 0.95 blocking | Wrong unit = wrong price |
| Item recall | ≥ 0.92 blocking | Missing a line is visible |
| Client name match | ≥ 0.85 warning | Easy for the user to fix |
| Clarification rate | ≤ 0.25 warning | Friction proxy |
| p95 latency | ≤ 45 s warning | Re-send trigger |
| Cost per quote | ≤ 1.20 MAD warning | Margin |

Word Error Rate is deliberately **not** a gate. WER is a poor proxy here: an ASR system can misspell every word and still yield a perfect quote if the numbers and item nouns survive. Gate on what reaches the customer.

### 16.3 Promptfoo for prompt-level regression

Test cases and assertions live in YAML — JSON schema validation, exact match, cost and latency thresholds, or model-graded evaluation — run from the CLI, integrated with GitHub Actions, failing the build when a regression appears.

```yaml
# evals/promptfooconfig.yaml
prompts: [file://../prompts/extraction.v3.jinja]
providers:
  - anthropic:messages:claude-sonnet-4-6
  - id: openai:gpt-4.1-mini      # cheaper challenger, always benchmarked
defaultTest:
  assert:
    - type: is-json
      value: file://schemas/extracted_quote.json
    - type: cost
      threshold: 0.004
    - type: latency
      threshold: 8000
tests: file://cases/*.yaml
```

Warn on metrics still being calibrated, block only on metrics whose baseline has held steady and stopped producing false alarms. Promote a metric from warning to blocking, never the reverse.

### 16.4 The closed loop

This is the part that compounds:

```
user reports a wrong quote
        ↓
find the Langfuse trace by quote_id
        ↓
add trace to the golden dataset with the corrected output
        ↓
promptfoo now fails if that regression ever returns
```

Any trace or observation can be added to a dataset directly from the Langfuse UI, which turns every incident into a permanent regression test in one action. Source expected outputs from domain experts correcting real outputs rather than writing ideal answers from scratch — the corrections carry information that invented cases do not.

Nightly, run the **full** corpus across all ASR candidates and post the leaderboard to Slack. This is how you find out that a provider silently changed a checkpoint.

### 16.5 A note on tooling risk

Promptfoo was acquired by OpenAI in early 2026; the company has stated the open-source project continues under its existing licence. Worth monitoring, not worth avoiding. The eval corpus is yours regardless of which runner reads it — keep the corpus format tool-agnostic (audio + JSON), and the runner becomes replaceable.

---

## 17. Observability

### 17.1 Trace propagation

One `trace_id` per quote, generated at webhook receipt, carried through every queue job, log line, database event and Langfuse span.

```python
trace_id: ContextVar[str] = ContextVar("trace_id")

class TraceMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        tid = request.headers.get("X-Trace-Id") or f"tr_{uuid4().hex[:16]}"
        trace_id.set(tid)
        structlog.contextvars.bind_contextvars(trace_id=tid)
        response = await call_next(request)
        response.headers["X-Trace-Id"] = tid
        return response
```

Enqueue it explicitly — context variables do not cross process boundaries:

```python
await queue.enqueue_job("process_quote", quote_id, _trace_id=trace_id.get())
```

### 17.2 Structured logging

`structlog`, JSON to stdout, always with `trace_id`, `tenant_id`, `quote_id`.

```python
log.info("extraction.completed",
         lines=len(result.lines),
         min_confidence=min(l.quantity_confidence for l in result.lines),
         asr_provider=transcript.provider,
         duration_ms=elapsed)
```

**Never log:** transcripts, client names, phone numbers, or prices at INFO. That is customer commercial data. Log identifiers and let someone with authorisation join to the content.

### 17.3 Langfuse

Every LLM and ASR call is a span. Traces, cost tracking, prompt management and versioning, plus datasets for evaluation all live in one place, which is the reason to prefer it over rolling your own.

```python
@observe(name="extract_quote")
async def llm_extract(text: str, ctx: TenantContext) -> ExtractedQuote:
    langfuse_context.update_current_trace(
        session_id=ctx.quote_id, user_id=str(ctx.tenant_id),
        tags=[ctx.trade, ctx.language_hint],
    )
    ...
```

### 17.4 Alerts

| Alert | Threshold | Severity |
|---|---|---|
| Webhook p99 latency | > 2 s over 5 min | page |
| Queue depth | > 200 for 10 min | page |
| Quote failure rate | > 5% over 30 min | page |
| ASR provider errors | > 10% over 10 min | page (auto-failover should have fired) |
| Clarification rate | > 40% over 1 h | investigate |
| Tenant cost > 2× plan | daily | investigate |
| Signature verification failures | any sustained | security |

---

## 18. Security and compliance

### 18.1 Tenant isolation

Three layers, because one is never enough:

1. RLS in PostgreSQL (§4.2)
2. Repository layer requiring an explicit `tenant_id` argument — no default
3. An integration test that attempts a cross-tenant read and asserts it returns nothing

```python
async def test_cross_tenant_read_is_blocked(db, tenant_a, tenant_b, item_of_a):
    async with tenant_session(db, tenant_b.id) as s:
        result = await s.get(CatalogItem, item_of_a.id)
        assert result is None
```

### 18.2 Secrets

GitHub Environments for CI, and a secrets manager for runtime. Never in the repository, never in the image. Rotate the Meta app secret and the system user token quarterly; both are high-value.

`app/config.py` fails fast at startup on any missing variable. A worker that starts and silently misbehaves because `WA_APP_SECRET` was empty is worse than one that refuses to boot.

### 18.3 Data protection

- Audio is customer speech, potentially containing third-party personal data. Retain 90 days by default, then delete unless the tenant opted into corpus contribution.
- **Opt-in for training corpus use** must be explicit and recorded with a timestamp. This is both the correct practice and the thing that makes the dataset legally usable later.
- Encrypt at rest (managed by the provider) and in transit (TLS everywhere, no exceptions).
- Implement export and deletion per tenant before you have 50 customers, not after.

**Morocco:** processing personal data requires declaration with the CNDP under law 09-08. Handle it early — it is inexpensive and blocking if a customer's own compliance review asks. If any tenant serves EU clients, GDPR applies to that data too.

### 18.4 Input handling

Webhook payloads are untrusted input. Validate against a Pydantic model before touching anything. Cap audio duration (reject > 5 min) and file size. A 40-minute voice note is either an accident or an attack, and either way it should not reach the ASR provider on your budget.

---

## 19. Deployment topology and scaling

### 19.1 v1 (0–500 tenants)

Managed platform — Railway, Render or Fly.io. Managed Postgres with `pgvector`, managed Redis, S3-compatible object storage. Roughly $150–400/month before AI costs.

**No Kubernetes.** At this size it is a second product to maintain with no user. Docker keeps the exit open.

### 19.2 Scaling order

Bottlenecks will appear in this sequence:

1. **AI workers** — first and most predictable. Scale horizontally on queue depth.
2. **GPU inference** (if self-hosting ASR) — the real cost cliff. Batch aggressively; queue rather than autoscale, because GPU cold starts are minutes.
3. **Render workers** — memory-bound. Add replicas, never concurrency.
4. **Postgres** — read replicas for analytics long before anything else. The write path is light.
5. **Gateway** — last. It does almost nothing.

### 19.3 The self-host decision

Compute the crossover explicitly rather than by instinct:

```
API:        cost_per_second × total_audio_seconds
Self-host:  gpu_hourly × 730  +  ops_time_value
```

At a 20 s average voice note and 15 000 quotes/month, that is roughly 83 hours of audio. Run the numbers against a current GPU quote and a current API price list. Below the crossover, the API is not just cheaper — it is also less operational surface. Revisit quarterly.

### 19.4 Backups

Daily automated Postgres backups with 30-day retention, plus point-in-time recovery. **Test the restore quarterly and write down how long it took.** An untested backup is a belief, not a backup.

---

## 20. Failure modes and runbook

| Failure | Detection | Automatic response | Human action |
|---|---|---|---|
| ASR provider down | error rate > 10% | failover to secondary provider | verify quality did not silently drop |
| LLM rate-limited | 429s | exponential backoff, then queue | raise quota |
| Extraction returns nothing | empty `lines` | ask user to re-send, more slowly | inspect trace, add to corpus |
| Audio corrupt / silent | ffmpeg fails or duration < 1 s | ask user to re-record | none |
| Confidence below threshold | pipeline check | targeted clarification | none |
| Render OOM | container restart | retry once at concurrency 1 | reduce replica concurrency |
| Meta webhook storm | queue depth spike | idempotency absorbs duplicates | check for a redelivery loop |
| Duplicate quote sent | user complaint | — | **incident**: idempotency has a hole |
| Wrong price sent | user complaint | — | **incident**: trace, correct, add to corpus, notify tenant |

The last two are the only true incidents. Everything else is degraded service, which the user experiences as a delay or a question, not as a broken promise.

**Dead-letter handling:** jobs failing 3 times land in `failed_jobs` with the full payload and the traceback. A daily digest lists them. Never silently drop a customer's voice note — if the system cannot process it, tell the person so they can try again.

---

## 21. Build sequence

The order matters more than the speed. Each step de-risks the next.

### Week 0 — Manual operation (no code)

One WhatsApp number, ten tradespeople, quotes produced by hand within 30 minutes. Collect every audio file, every quote produced, every price mentioned.

**Exit criterion:** at least 3 of 10 send an unprompted second voice note.

This is not a formality. Without the corpus produced here, §16 cannot be built, §8 cannot be tuned, and §9 is guesswork.

### Week 1–2 — Skeleton and measurement

- Repo, Docker, compose, CI running on an empty test suite
- Postgres schema + migrations + RLS + the cross-tenant test
- Webhook with signature verification and idempotency, ACK only
- **Benchmark all ASR candidates against the Week 0 corpus** and write down the numbers

**Exit:** a chosen ASR provider, justified by measured numbers on your own audio.

### Week 3–4 — The core path

- Ingest → transcribe → extract → match → price → render → send, end to end
- Fake providers for every external dependency; e2e test runs offline
- Pricing engine with property-based tests
- First PDF a real person would be willing to send

**Exit:** a quote produced end-to-end from a real voice note, correct.

### Week 5 — Making it honest

- Dual-path numeric reconciliation
- Clarification loop with interactive buttons and expiry
- Catalog matching cascade and alias learning
- Eval harness wired into CI with blocking gates

**Exit:** the PR gate blocks a deliberately introduced regression.

### Week 6 — Making it operable

- Langfuse, structured logging, trace propagation
- Cost metering and the margin query
- `automation_mode` per tenant; the ten Week 0 users move to `copilot`
- Alerts, dead-letter digest, runbook

**Exit:** the Week 0 users are on the automated system in copilot mode.

### Week 7–8 — Making it earn

- Onboarding flow (voice-note catalog capture)
- Follow-up reminders on unanswered quotes — the first feature worth paying for
- Graduate the best tenants to `auto`
- Payment and plan enforcement

**Exit:** first paying customer, and a measured cost-per-quote.

---

## 22. Open decisions

These block progress and should be settled this week.

| # | Decision | Options | Owner |
|---|---|---|---|
| D1 | Primary segment | solo tradesperson vs 5–20 person firm | |
| D2 | BSP for the WhatsApp API | 360dialog / Twilio / Wati / direct Cloud API | |
| D3 | ASR: self-host from day one, or API first | depends on §19.3 crossover | |
| D4 | Multimodal provider for path B | must accept audio input | |
| D5 | Hosting platform | Railway / Render / Fly.io / Scaleway (data residency?) | |
| D6 | Data residency requirement | does any target customer require Morocco or EU hosting? | |
| D7 | Corpus licence | what exactly do tenants consent to when they opt in | |

---

## Appendix A — Sources

- `atlasia/moulsot.v0.3` — Darija ASR, code-switching robust · huggingface.co/atlasia/moulsot.v0.3
- `anaszil/whisper-large-v3-turbo-darija` — LoRA adapter · huggingface.co/anaszil/whisper-large-v3-turbo-darija
- `speechbrain/asr-wav2vec2-dvoice-darija` — DVoice baseline · huggingface.co/speechbrain/asr-wav2vec2-dvoice-darija
- Moroccan Darija ASR leaderboard · huggingface.co/spaces/abdeljalilELmajjodi/moroccan_darija_asr_leaderboard
- Langfuse — LLM regression testing guide · langfuse.com/resources/engineering/llm-regression-testing
- Promptfoo — MIT-licensed eval and red-teaming CLI · github.com/promptfoo/promptfoo
- Instructor — structured output on Pydantic · python.useinstructor.com

## Appendix B — Glossary

| Term | Meaning |
|---|---|
| **wamid** | WhatsApp message id, the idempotency key |
| **BSP** | Business Solution Provider, Meta-approved API reseller |
| **tenant** | One business using the product |
| **golden dataset** | Curated audio + expected output used as a regression gate |
| **copilot mode** | System drafts, a human approves before sending |
| **cold start** | A new tenant with an empty catalog |
| **ICE / RC / IF** | Moroccan company identifiers printed on commercial documents |