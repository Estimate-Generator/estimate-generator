# Technical Architecture — Voice-to-Quote over WhatsApp

**Status:** v2.0 · **Date:** 28 August 2026 · **Audience:** engineering team
**Supersedes:** [v1.0](ARCHITECTURE_v1.md) · **Extended by** [v3](ARCHITECTURE_v3_HARDENING.md) and [v3.1](ARCHITECTURE_v3.1_PATTERNS_AND_DIAGRAMS.md)

This document is the build reference. It assumes zero existing code and describes the system to the level of detail where a competent engineer can start writing files without further design discussion.

### Where this document has been overtaken

v3 and v3.1 are additive, but they also **change** decisions made here. Where the
two disagree, the later document wins. Check this table before implementing a
section that appears in it.

| This document says | Now read instead | Why |
|---|---|---|
| §4.1 `automation_mode IN ('shadow','copilot','auto')` | v3 §A.1 — `shadow` removed | No user, no exit criterion |
| §8.4 `orphan_statuses` table | v3 §A.2 — a Redis key with a TTL | A 30-second buffer should not be a table that grows forever |
| §4.5 `quotes` table | v3 §G.2 — `documents` with a `kind` column | The seam that makes invoicing an extension, not a rewrite |
| §6.2 module-level `TRANSITIONS` | v3 §G.2 — `spec.lifecycle` per `DocumentSpec` | A devis change must not silently alter an invoice |
| §13.1 bare `Decimal` + `q2()` | v3.1 §L — `Money` and `Quantity` value objects | 20 m² + 3 units = 23, and unrounded money cannot then exist |
| §16 adapter construction (unstated) | v3.1 §K — `app/composition.py` composition root | A module-level client makes `PROVIDER_MODE=fake` meaningless |
| §14 `async_playwright()` per render | v3 §F.4 — pooled `BrowserPool`, recycle at 50 | Chromium accumulates memory across page loads |
| §11.1 per-line matching | v3 §F.3 — batched: 24 round trips become 3 | Latency and embedding cost, from one change |
| §23 pool sizing (unstated) | v3 §F.1 — 148 connections against a cap of 100 | The system exhausts connections before CPU |
| Error handling (scattered) | v3 §B — the `AppError` taxonomy | Otherwise every service invents its own semantics |
| Time zones (absent) | v3.1 §Q — UTC everywhere, **Morocco's offset changes 20 Sept 2026** | A `valid_until` computed naively lands on the wrong day |
| Blocking calls (absent) | v3.1 §O — nothing blocks the event loop | One `subprocess.run` stalls every concurrent quote |

### Changes from v1.0

| # | Change | Reason |
|---|---|---|
| A | **New §5 — conversation layer and intent routing** | v1 assumed every inbound message was a new quote. False on contact with users, and clarification answers could not be routed when two quotes were pending. |
| B | **Quote revision and versioning** (§6) | `sent` was terminal. The core UX promise — "non, la TVA c'est 14" — had no path. |
| C | **New §8 — delivery guarantees** | Inbound had a dual-write hole; outbound had no idempotency at all, which caused the duplicate-PDF incident v1 listed as unacceptable. |
| D | **Status callback handling** (§8.4) | v1 ignored `statuses`, so delivery was unknown and metering could not be reconciled against Meta's billing. |
| E | **New §12 — onboarding** | "Resolve tenant from phone" was undefined for unknown senders, i.e. every new customer's first message. |
| F | **Corpus split into dev / gate / locked test** (§20.2) | Tuning against the gate corpus measures memorisation, not quality. This invalidated every number in v1 §16. |
| G | **New §19 — prompt and model rollout** | Model changes are riskier than code changes and rode the identical pipeline. |
| H | **New §24 — business continuity** | Single WhatsApp number is a single point of failure outside our control. |
| I | **Acceptance capture flow** (§11.4) | `accepted_at` was never populated, making the follow-up feature — the main paid-plan justification — blind. |
| J | **Removed** gapless numbering and speculative `ASR_ROUTING` | Gapless is an invoice requirement, not a quote one, and it serialises quote creation per tenant. Routing config presumed data we do not have. |

---

## Table of contents

1. [Scope and hard constraints](#1-scope-and-hard-constraints)
2. [System context](#2-system-context)
3. [Component architecture](#3-component-architecture)
4. [Data model](#4-data-model)
5. [Conversation layer and intent routing](#5-conversation-layer-and-intent-routing)
6. [The quote state machine](#6-the-quote-state-machine)
7. [End-to-end request lifecycle](#7-end-to-end-request-lifecycle)
8. [Message delivery guarantees](#8-message-delivery-guarantees)
9. [WhatsApp integration layer](#9-whatsapp-integration-layer)
10. [The AI pipeline](#10-the-ai-pipeline)
11. [Catalog, cold start and lifecycle](#11-catalog-cold-start-and-lifecycle)
12. [Onboarding](#12-onboarding)
13. [Pricing engine](#13-pricing-engine)
14. [Document rendering](#14-document-rendering)
15. [Cost metering](#15-cost-metering)
16. [Repository layout](#16-repository-layout)
17. [Local development](#17-local-development)
18. [CI/CD pipeline](#18-cicd-pipeline)
19. [Prompt and model rollout](#19-prompt-and-model-rollout)
20. [Evaluation harness](#20-evaluation-harness)
21. [Observability](#21-observability)
22. [Security and compliance](#22-security-and-compliance)
23. [Deployment topology and scaling](#23-deployment-topology-and-scaling)
24. [Business continuity](#24-business-continuity)
25. [Failure modes and runbook](#25-failure-modes-and-runbook)
26. [Build sequence](#26-build-sequence)
27. [Open decisions](#27-open-decisions)

---

## 1. Scope and hard constraints

### 1.1 What the system does

A tradesperson sends a voice note on WhatsApp. Within 60 seconds they receive a PDF quote, correctly priced from their own rate card, ready to forward to their client.

### 1.2 Constraints that dictate the design

| # | Constraint | Architectural consequence |
|---|---|---|
| C1 | Meta requires a webhook response within a few seconds | Webhook ACKs immediately; all work goes to a queue |
| C2 | Meta redelivers webhooks on doubt | Every handler idempotent on `wamid` |
| C3 | Full processing takes 20–60 s | Asynchronous workers, no synchronous path |
| C4 | Conversation is asynchronous and can pause for hours | Quote is a persisted state machine |
| C5 | A wrong number reaches a real end client | Numeric fields need independent verification |
| C6 | Every message and audio second costs money | Per-tenant cost metering from day one |
| C7 | Each tenant has a private rate card | Multi-tenancy from the first migration |
| C8 | Darija ASR quality is unknown until measured | Provider abstraction + regression corpus before tuning |
| C9 | **One phone number sends many kinds of message** | Intent routing before any quote logic (§5) |
| C10 | **A sent quote is a commercial document** | Revisions create new versions; sent rows are immutable (§6.3) |
| C11 | **Network calls can succeed while we believe they failed** | Idempotency on both directions, not just inbound (§8) |

### 1.3 Explicit non-goals for v1

Invoicing and DGI e-invoicing compliance, payments, multi-user accounts, a web dashboard, mobile apps, multi-country support. None of these should influence v1 code beyond leaving room in the schema.

### 1.4 Target scale for v1

500 tenants, 15 000 quotes/month, peak 40 quotes/hour. Small. The architecture below handles roughly 50× that before anything needs rethinking. Resist building for more.

---

## 2. System context

```
                    ┌──────────────────┐
                    │   Tradesperson   │
                    │  (WhatsApp app)  │
                    └────────┬─────────┘
                             │ voice note / text / button tap
                             ▼
                    ┌──────────────────┐
                    │  Meta WhatsApp   │
                    │   Cloud API      │
                    └───┬──────────┬───┘
        messages +      │          │ send / fetch media
        statuses        ▼          │
       ┌────────────────────────────────────────┐
       │            OUR SYSTEM                  │
       │  ┌──────────┐  ┌────────┐  ┌────────┐  │
       │  │ Gateway  │─▶│ Outbox │─▶│ Queue  │  │
       │  │ (FastAPI)│  │ poller │  │(Redis) │  │
       │  └──────────┘  └────────┘  └───┬────┘  │
       │                                ▼       │
       │              ┌──────────────────────┐  │
       │              │ Router → Workers     │  │
       │              └──┬────┬────┬────┬────┘  │
       │     ┌───────────┘    │    │    └─────┐ │
       │     ▼                ▼    ▼          ▼ │
       │ ┌──────────┐  ┌──────────┐  ┌──────────┐
       │ │ Postgres │  │  Object  │  │ Renderer │
       │ │ +pgvector│  │  Store   │  │ HTML→PDF │
       │ └──────────┘  └──────────┘  └──────────┘
       └────────────────────────────────────────┘
                        │
          ┌─────────────┼──────────────┐
          ▼             ▼              ▼
      ┌────────┐   ┌─────────┐   ┌──────────┐
      │  ASR   │   │   LLM   │   │ Langfuse │
      └────────┘   └─────────┘   └──────────┘
```

**Trust boundary:** everything inside `OUR SYSTEM` is ours. Meta, ASR, LLM and Langfuse are external; each gets a provider interface, a timeout, a retry policy and a circuit breaker.

---

## 3. Component architecture

Single deployable image, multiple process roles. A *modular monolith*: one repo, one image, one dependency set, different entrypoints.

| Role | Command | Replicas | Scaling trigger |
|---|---|---|---|
| `gateway` | `uvicorn app.gateway:app` | 2 min | p99 webhook latency > 500 ms |
| `outbox-poller` | `python -m app.workers.outbox` | 1 (singleton) | never |
| `worker-router` | `arq app.workers.router` | 2 | queue depth |
| `worker-ai` | `arq app.workers.ai` | 4–20 | queue depth (the expensive one) |
| `worker-render` | `arq app.workers.render` | 2 | queue depth |
| `worker-outbound` | `arq app.workers.outbound` | 2 | rate-limited by Meta anyway |
| `scheduler` | `arq --scheduler` | 1 (singleton) | never |

AI workers are slow, memory-heavy and the ones you scale under load. Rendering holds a headless browser with a very different memory profile. Mixing them means scaling the expensive resource to satisfy the cheap one.

**Queue:** `arq` (Redis, asyncio-native, small surface area) over Celery. Celery's feature set is not needed and its configuration surface is a liability at this size.

**Singletons** (`outbox-poller`, `scheduler`) must be enforced by the platform, not by convention. Two outbox pollers double-dispatch. Use a Redis lease:

```python
async def run_singleton(name: str, fn, ttl=30):
    while True:
        got = await redis.set(f"lease:{name}", INSTANCE_ID, nx=True, ex=ttl)
        if got:
            asyncio.create_task(renew_lease(name, ttl))
            return await fn()
        await asyncio.sleep(5)
```

### 3.1 Internal module boundaries

```
app/
  gateway/        HTTP surface. Knows nothing about business logic.
  domain/         Pure Python. Entities, state machines, pricing. Zero I/O.
  services/       Orchestration. Calls domain + adapters.
  adapters/       Everything external: whatsapp, asr, llm, storage, pdf.
  workers/        Queue entrypoints. Thin — they call services.
  db/             SQLAlchemy models, migrations, repositories.
```

**Enforced in CI:** `domain/` may not import from `adapters/`, `db/`, or any third-party client library. It is pure, fast to test, and where all money arithmetic lives.

```python
# tests/test_architecture.py
import ast, pathlib

FORBIDDEN = {"httpx", "sqlalchemy", "redis", "openai", "anthropic",
             "app.adapters", "app.db"}

def test_domain_is_pure():
    for path in pathlib.Path("app/domain").rglob("*.py"):
        for node in ast.walk(ast.parse(path.read_text())):
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

PostgreSQL 16 with `pgvector`. All monetary values are `NUMERIC(12,2)`. **Never `float`.**

### 4.1 Tenancy and identity

```sql
CREATE TABLE tenants (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_name   TEXT        NOT NULL,
    legal_form      TEXT,
    ice             TEXT,
    rc              TEXT,
    if_number       TEXT,
    address         TEXT,
    logo_key        TEXT,
    trade           TEXT,                          -- plomberie, menuiserie…
    default_vat_rate NUMERIC(5,2) NOT NULL DEFAULT 20.00,
    default_validity_days INT     NOT NULL DEFAULT 30,
    quote_counter   INT          NOT NULL DEFAULT 0,
    locale          TEXT         NOT NULL DEFAULT 'fr-MA',
    automation_mode TEXT         NOT NULL DEFAULT 'copilot'
                    CHECK (automation_mode IN ('shadow','copilot','auto')),
    prompt_channel  TEXT         NOT NULL DEFAULT 'stable'
                    CHECK (prompt_channel IN ('stable','canary')),   -- §19
    onboarding_state TEXT        NOT NULL DEFAULT 'new',             -- §12
    status          TEXT         NOT NULL DEFAULT 'trial'
                    CHECK (status IN ('trial','active','suspended','churned')),
    plan            TEXT         NOT NULL DEFAULT 'discovery',
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE tenant_phones (
    phone_e164  TEXT PRIMARY KEY,
    tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    role        TEXT NOT NULL DEFAULT 'owner',
    verified_at TIMESTAMPTZ
);
CREATE INDEX ON tenant_phones (tenant_id);
```

### 4.2 Inbound, outbox and outbound

```sql
-- Idempotency anchor for everything arriving from Meta.
CREATE TABLE inbound_messages (
    wamid         TEXT PRIMARY KEY,
    tenant_id     UUID REFERENCES tenants(id),
    from_phone    TEXT        NOT NULL,
    message_type  TEXT        NOT NULL,   -- audio | text | image | interactive | button
    context_wamid TEXT,                   -- set when the user replied to a message
    raw_payload   JSONB       NOT NULL,
    received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at  TIMESTAMPTZ,
    failed_at     TIMESTAMPTZ,
    error         TEXT
);
CREATE INDEX ON inbound_messages (tenant_id, received_at DESC);
-- Sweeper index: anything received but never picked up.
CREATE INDEX inbound_pending ON inbound_messages (received_at)
    WHERE processed_at IS NULL AND failed_at IS NULL;

-- Transactional outbox: job intents written in the SAME transaction as
-- the state they describe. Closes the dual-write hole (§8.1).
CREATE TABLE outbox (
    id            BIGSERIAL PRIMARY KEY,
    job_name      TEXT        NOT NULL,
    payload       JSONB       NOT NULL,
    trace_id      TEXT,
    available_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    dispatched_at TIMESTAMPTZ,
    attempts      INT         NOT NULL DEFAULT 0
);
CREATE INDEX outbox_pending ON outbox (available_at)
    WHERE dispatched_at IS NULL;

-- Outbound idempotency + delivery tracking.
CREATE TABLE outbound_messages (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    quote_id     UUID REFERENCES quotes(id) ON DELETE SET NULL,
    dedupe_key   TEXT UNIQUE NOT NULL,   -- 'quote:{id}:v{n}:document'
    to_phone     TEXT NOT NULL,
    kind         TEXT NOT NULL,          -- text | document | buttons | template
    body         JSONB NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','claimed','sent','delivered',
                                   'read','failed','abandoned')),
    wamid        TEXT UNIQUE,            -- returned by Meta; joins to statuses
    attempts     INT NOT NULL DEFAULT 0,
    claimed_at   TIMESTAMPTZ,
    sent_at      TIMESTAMPTZ,
    delivered_at TIMESTAMPTZ,
    read_at      TIMESTAMPTZ,
    error_code   TEXT,
    error_detail TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON outbound_messages (tenant_id, created_at DESC);
CREATE INDEX outbound_claimable ON outbound_messages (created_at)
    WHERE status IN ('pending','claimed');
```

### 4.3 Conversation

```sql
-- One live conversation per tenant phone. Holds the routing pointer.
CREATE TABLE conversation_sessions (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    phone_e164       TEXT NOT NULL,
    active_quote_id  UUID REFERENCES quotes(id) ON DELETE SET NULL,
    last_inbound_at  TIMESTAMPTZ,        -- drives the 24h window (§9.4)
    last_outbound_at TIMESTAMPTZ,
    pending_intent   TEXT,               -- e.g. awaiting disambiguation answer
    pending_payload  JSONB,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, phone_e164)
);

-- Audit of routing decisions. Becomes the training set for the router.
CREATE TABLE intent_decisions (
    id           BIGSERIAL PRIMARY KEY,
    wamid        TEXT NOT NULL REFERENCES inbound_messages(wamid),
    tenant_id    UUID REFERENCES tenants(id),
    intent       TEXT NOT NULL,
    confidence   NUMERIC(4,3) NOT NULL,
    method       TEXT NOT NULL,          -- rule | context | classifier | default
    target_quote_id UUID REFERENCES quotes(id),
    corrected_to TEXT,                   -- filled when a human relabels it
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON intent_decisions (tenant_id, created_at DESC);
```

### 4.4 Catalog

```sql
CREATE TABLE catalog_items (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    label         TEXT          NOT NULL,
    unit          TEXT          NOT NULL,  -- m2 | ml | u | forfait | h | kg | m3
    unit_price_ht NUMERIC(12,2) NOT NULL,
    vat_rate      NUMERIC(5,2),            -- NULL → tenant default
    category      TEXT,
    embedding     VECTOR(1024),
    usage_count   INT           NOT NULL DEFAULT 0,
    last_used_at  TIMESTAMPTZ,
    confirmed     BOOLEAN       NOT NULL DEFAULT FALSE,
    archived_at   TIMESTAMPTZ,
    created_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX ON catalog_items (tenant_id) WHERE archived_at IS NULL;
CREATE INDEX ON catalog_items USING hnsw (embedding vector_cosine_ops);
CREATE INDEX catalog_label_trgm ON catalog_items USING gin (label gin_trgm_ops);

-- Price history. Needed to reprice correctly and to explain an old quote.
CREATE TABLE catalog_price_history (
    id              BIGSERIAL PRIMARY KEY,
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    catalog_item_id UUID NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
    unit_price_ht   NUMERIC(12,2) NOT NULL,
    changed_by      TEXT NOT NULL,        -- user | operator | system
    valid_from      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON catalog_price_history (tenant_id);
CREATE INDEX ON catalog_price_history (catalog_item_id, valid_from DESC);

-- Every spoken variant ever mapped to an item. This is the moat.
CREATE TABLE catalog_aliases (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    catalog_item_id UUID NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
    raw_text        TEXT NOT NULL,
    embedding       VECTOR(1024),
    hit_count       INT  NOT NULL DEFAULT 1,
    UNIQUE (tenant_id, catalog_item_id, raw_text)
);
CREATE INDEX ON catalog_aliases USING hnsw (embedding vector_cosine_ops);
```

### 4.5 Clients and quotes

```sql
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

CREATE TABLE quotes (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    client_id      UUID REFERENCES clients(id),
    number         TEXT,                  -- 'DEV-2026-0042', assigned at render
    version        INT  NOT NULL DEFAULT 1,
    supersedes_id  UUID REFERENCES quotes(id),   -- previous version
    root_id        UUID,                  -- first version; groups the lineage
    state          TEXT NOT NULL DEFAULT 'received',
    source_wamid   TEXT REFERENCES inbound_messages(wamid),
    transcript     TEXT,
    transcript_confidence NUMERIC(4,3),
    asr_provider   TEXT,
    prompt_version TEXT,                  -- which extraction prompt produced it
    subtotal_ht    NUMERIC(12,2),
    discount_pct   NUMERIC(5,2) NOT NULL DEFAULT 0,
    net_ht         NUMERIC(12,2),
    vat_amount     NUMERIC(12,2),
    total_ttc      NUMERIC(12,2),
    valid_until    DATE,
    pdf_key        TEXT,
    audio_key      TEXT,
    sent_at        TIMESTAMPTZ,
    outcome        TEXT CHECK (outcome IN ('accepted','refused','no_reply')),
    outcome_at     TIMESTAMPTZ,
    outcome_source TEXT,                  -- user_button | user_text | inferred
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON quotes (tenant_id, created_at DESC);
CREATE INDEX ON quotes (root_id, version);
CREATE INDEX quotes_active ON quotes (state)
    WHERE state NOT IN ('sent','failed','cancelled','superseded');
CREATE UNIQUE INDEX ON quotes (tenant_id, number, version)
    WHERE number IS NOT NULL;
-- Follow-up scan (§11.4)
CREATE INDEX quotes_awaiting_outcome ON quotes (sent_at)
    WHERE outcome IS NULL AND sent_at IS NOT NULL;

CREATE TABLE quote_lines (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    quote_id         UUID NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
    position         INT  NOT NULL,
    raw_text         TEXT NOT NULL,
    catalog_item_id  UUID REFERENCES catalog_items(id),
    label            TEXT NOT NULL,
    quantity         NUMERIC(12,3) NOT NULL,
    unit             TEXT NOT NULL,
    unit_price_ht    NUMERIC(12,2) NOT NULL,   -- snapshot, never a live lookup
    line_total_ht    NUMERIC(12,2) NOT NULL,
    vat_rate         NUMERIC(5,2)  NOT NULL,
    match_score      NUMERIC(4,3),
    match_method     TEXT,   -- exact | alias | trigram | vector | created | manual
    quantity_verified BOOLEAN NOT NULL DEFAULT FALSE,
    UNIQUE (quote_id, position)
);
CREATE INDEX ON quote_lines (tenant_id);

CREATE TABLE quote_events (
    id         BIGSERIAL PRIMARY KEY,
    tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    quote_id   UUID NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
    from_state TEXT,
    to_state   TEXT NOT NULL,
    actor      TEXT NOT NULL,   -- system | user | operator
    payload    JSONB,
    trace_id   TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON quote_events (quote_id, created_at);
CREATE INDEX ON quote_events (tenant_id);

CREATE TABLE clarifications (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    quote_id    UUID NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
    field_path  TEXT NOT NULL,          -- 'lines[2].quantity'
    question    TEXT NOT NULL,
    options     JSONB,
    outbound_id UUID REFERENCES outbound_messages(id),
    asked_at    TIMESTAMPTZ,
    answered_at TIMESTAMPTZ,
    answer      JSONB,
    round       INT NOT NULL DEFAULT 1,
    expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX clarifications_open ON clarifications (quote_id)
    WHERE answered_at IS NULL;
CREATE INDEX ON clarifications (tenant_id);
```

**`unit_price_ht` on `quote_lines` is a snapshot, deliberately.** A quote sent in March must still print March's price in June. Joining live to `catalog_items` at render time would silently rewrite history.

### 4.6 Cost metering

```sql
CREATE TABLE usage_events (
    id          BIGSERIAL PRIMARY KEY,
    tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    quote_id    UUID REFERENCES quotes(id) ON DELETE SET NULL,
    kind        TEXT NOT NULL,   -- wa_message_in | wa_message_out | asr_seconds
                                 -- | llm_tokens_in | llm_tokens_out
                                 -- | embedding | render
    quantity    NUMERIC(12,4) NOT NULL,
    unit_cost   NUMERIC(12,6) NOT NULL,
    cost_mad    NUMERIC(12,4) NOT NULL,
    provider    TEXT,
    reference   TEXT,                            -- the wamid for wa_message_out;
                                                 -- the join key for reconciliation (§15.2)
    estimated   BOOLEAN NOT NULL DEFAULT TRUE,   -- FALSE once reconciled (§15.2)
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON usage_events (tenant_id, occurred_at DESC);
CREATE INDEX ON usage_events (reference) WHERE reference IS NOT NULL;
```

### 4.7 Row-level security

Application filtering is not enough. One forgotten `WHERE tenant_id = …` leaks a competitor's rate card.

```sql
ALTER TABLE catalog_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_items FORCE ROW LEVEL SECURITY;   -- the owner role bypasses otherwise
CREATE POLICY tenant_isolation ON catalog_items
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
```

Repeat for every tenant-scoped table:

`quotes` · `quote_lines` · `quote_events` · `clarifications` · `clients` ·
`catalog_aliases` · `catalog_price_history` · `usage_events` ·
`conversation_sessions` · `intent_decisions` · `outbound_messages`

**Aggregate children carry their own `tenant_id`.** `quote_lines`, `quote_events`,
`clarifications` and `catalog_price_history` reach their tenant only through a
parent id, which an RLS policy cannot follow — the policy expression must
reference a column on the row itself. Denormalising `tenant_id` onto them is what
makes the policy expressible at all, and it is also what the partial indexes want.
It is redundant data, and the redundancy is the point: a policy that cannot be
written is a table with no isolation.

The only tables legitimately outside this list are `tenants`, `tenant_phones`,
`plans`, `outbox`, and `inbound_messages` — the last because it is written before
the tenant is known. `scripts/check_tenant_isolation.py` holds the same exemption
set, and any addition to it needs a reason written down.

The `true` second argument to `current_setting` makes it return NULL rather than
erroring when the variable is unset. With NULL the comparison is NULL, the policy
denies everything, and an unscoped query returns zero rows instead of crashing.
Failing closed is the correct default.

```python
@asynccontextmanager
async def tenant_session(engine, tenant_id: UUID):
    async with AsyncSession(engine) as s:
        async with s.begin():
            await s.execute(text("SET LOCAL app.tenant_id = :t"),
                            {"t": str(tenant_id)})
            yield s
```

Workers that legitimately cross tenants (metering rollups, outbox poller) use a separate role with `BYPASSRLS`. That role is never used by request-handling code.

### 4.8 Migrations

Alembic, autogenerate reviewed by hand every time.

- **Separate CI step**, never on application startup. With N replicas, startup migrations race.
- **Expand/contract for anything destructive.** Add column → deploy code writing both → backfill → deploy code reading new → drop old. Four deploys, zero downtime, survives rollback.

---

## 5. Conversation layer and intent routing

This section did not exist in v1, and its absence was the largest gap. v1 treated every inbound message as a new quote request.

### 5.1 What actually arrives

| Message | Intent | Why v1 broke |
|---|---|---|
| *"devis pour Alami, 3 fenêtres…"* | `new_quote` | handled |
| *"non, 20 m² pas 200"* | `answer_clarification` | ambiguous target if 2 quotes pending |
| *"refais le devis d'hier avec 5 fenêtres"* | `revise_quote` | `sent` was terminal |
| *"c'est combien le total pour Alami ?"* | `query` | would have created an empty quote |
| tap on **[Oui]** button | `answer_outcome` | interactive type unhandled |
| *"salam"* | `smalltalk` | would have burned an ASR call |
| forwarded photo of a handwritten note | `unsupported` | undefined |
| voice note of the artisan talking to a client | `unknown` | would have produced a nonsense quote |

### 5.2 Routing cascade

Cheapest and most certain first. The LLM classifier is the **last** resort, not the first.

```python
async def route(msg: InboundMessage, session: ConversationSession) -> Route:
    # 1 · Interactive replies carry their own target. Free and certain.
    if msg.type in ("interactive", "button"):
        return Route.from_payload_id(msg.reply_id)      # 'clar:{uuid}' | 'outcome:{uuid}'

    # 2 · WhatsApp reply-context: the user quoted one of our messages.
    if msg.context_wamid:
        if target := await resolve_by_outbound_wamid(msg.context_wamid):
            return Route(intent=target.expected_intent, quote_id=target.quote_id)

    # 3 · Exactly one open clarification, answered within the window.
    open_clars = await open_clarifications(session.tenant_id)
    if len(open_clars) == 1 and msg.age < CLARIFICATION_WINDOW:
        return Route(Intent.ANSWER_CLARIFICATION, open_clars[0].quote_id, 0.85, "context")

    # 4 · More than one open: do not guess. Ask.
    if len(open_clars) > 1:
        return Route(Intent.DISAMBIGUATE, None, 1.0, "rule")

    # 5 · Cheap text rules before spending anything.
    if msg.type == "text" and (r := rule_match(msg.text)):
        return r

    # 6 · Classifier. Text is cheap; audio is not (see 5.4).
    return await classify(msg, session)
```

### 5.3 Disambiguation is explicit, never inferred

With two quotes pending, a bare *"20"* is unroutable. Guessing corrupts a real commercial document. Ask, with buttons:

> Vous répondez pour quel devis ?
> **[Alami — carrelage]** **[Benjelloun — fenêtres]**

The `pending_intent` and `pending_payload` columns on `conversation_sessions` hold the original message until the answer arrives, so the user does not repeat themselves.

**Hard rule:** at most **two** quotes may be in `needs_clarification` per tenant at once. A third forces the oldest to `expired`. Beyond two, disambiguation costs more friction than it saves.

### 5.4 Audio is classified after transcription, not before

Audio cannot be cheaply classified without transcribing it, and transcription is the expensive step. So:

1. Transcribe (always — an audio message is almost always intentful)
2. Classify from the transcript, which is now free text
3. If the intent is not quote-related, do not proceed to extraction

This wastes one ASR call on `smalltalk`, which is acceptable. Attempting to classify raw audio to save that call would cost a second model invocation on every message.

### 5.5 Classifier contract

```python
class IntentResult(BaseModel):
    intent: Literal["new_quote","revise_quote","answer_clarification",
                    "answer_outcome","query","catalog_update",
                    "smalltalk","unsupported","unknown"]
    confidence: float = Field(ge=0, le=1)
    target_hint: str | None = None   # "le devis d'hier", "Alami"
    reasoning: str
```

Below `INTENT_CONFIDENCE_THRESHOLD` (start 0.7) → `unknown` → ask the user plainly:

> Je n'ai pas bien compris. Vous voulez un nouveau devis, ou modifier un devis existant ?

**Never fall back to `new_quote` on low confidence.** A spurious quote is worse than a question, because it consumes a number, sends a document, and teaches the user the system is unreliable.

### 5.6 Every routing decision is logged

`intent_decisions` records intent, confidence, method and target for every message. Two uses:

- **Debugging:** "why did it do that" is answerable in one query.
- **Training data:** the `corrected_to` column lets an operator relabel a mistake, and those rows become the router's eval set (§20). The routing corpus is built the same way as the extraction corpus.

---

## 6. The quote state machine

### 6.1 States

```
                  ┌──────────┐
                  │ received │
                  └────┬─────┘
                       ▼
                ┌─────────────┐  audio unusable
                │ transcribing│─────────────────┐
                └──────┬──────┘                 │
                       ▼                        │
                 ┌───────────┐                  │
                 │ extracting│──────────────────┤
                 └─────┬─────┘                  │
                       ▼                        │
                 ┌──────────┐                   │
                 │ matching │                   │
                 └────┬─────┘                   │
            ┌─────────┴─────────┐               │
            ▼                   ▼               │
   ┌───────────────────┐  ┌──────────┐          │
   │needs_clarification│  │  priced  │          │
   └───┬──────────┬────┘  └────┬─────┘          │
       │ answer   │ timeout    │                │
       └────►─────┘            ▼                │
            │           ┌──────────┐            │
            ▼           │ rendering│            │
       ┌─────────┐      └────┬─────┘            │
       │ expired │           ▼                  │
       └─────────┘   ┌──────────────────┐       │
                     │awaiting_approval │       │
                     │  (copilot only)  │       │
                     └────────┬─────────┘       │
                              ▼                 ▼
                        ┌──────────┐      ┌─────────┐
                        │   sent   │      │ failed  │
                        └────┬─────┘      └─────────┘
                    ┌────────┼─────────┐
                    ▼        ▼         ▼
              ┌──────────┐ ┌──────┐ ┌────────────┐
              │ revising │ │outcome│ │ superseded │
              └────┬─────┘ │recorded│ └────────────┘
                   │       └───────┘
                   └──▶ new row, version = n+1, state = matching
```

### 6.2 Transition table

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
    REVISING = "revising"
    SUPERSEDED = "superseded"
    EXPIRED = "expired"
    FAILED = "failed"
    CANCELLED = "cancelled"

TRANSITIONS: dict[QuoteState, set[QuoteState]] = {
    QuoteState.RECEIVED:            {QuoteState.TRANSCRIBING, QuoteState.EXTRACTING,
                                     QuoteState.FAILED, QuoteState.CANCELLED},
    QuoteState.TRANSCRIBING:        {QuoteState.EXTRACTING, QuoteState.FAILED},
    QuoteState.EXTRACTING:          {QuoteState.MATCHING, QuoteState.NEEDS_CLARIFICATION,
                                     QuoteState.FAILED},
    QuoteState.MATCHING:            {QuoteState.PRICED, QuoteState.NEEDS_CLARIFICATION,
                                     QuoteState.FAILED},
    QuoteState.NEEDS_CLARIFICATION: {QuoteState.MATCHING, QuoteState.PRICED,
                                     QuoteState.EXPIRED, QuoteState.CANCELLED},
    QuoteState.PRICED:              {QuoteState.RENDERING, QuoteState.NEEDS_CLARIFICATION,
                                     QuoteState.FAILED},
    QuoteState.RENDERING:           {QuoteState.AWAITING_APPROVAL, QuoteState.SENT,
                                     QuoteState.FAILED},
    QuoteState.AWAITING_APPROVAL:   {QuoteState.SENT, QuoteState.REVISING,
                                     QuoteState.CANCELLED, QuoteState.EXPIRED},
    QuoteState.SENT:                {QuoteState.REVISING, QuoteState.SUPERSEDED,
                                     QuoteState.EXPIRED},
    QuoteState.REVISING:            {QuoteState.SUPERSEDED, QuoteState.SENT},
    QuoteState.FAILED:              {QuoteState.RECEIVED},   # operator retry
}

TERMINAL = {QuoteState.SUPERSEDED, QuoteState.EXPIRED,
            QuoteState.CANCELLED, QuoteState.FAILED}

class IllegalTransition(Exception): ...

def assert_can(frm: QuoteState, to: QuoteState) -> None:
    if to not in TRANSITIONS.get(frm, set()):
        raise IllegalTransition(f"{frm} -> {to}")
```

**Note that `outcome` is not a state.** Accepted / refused is a *property of a sent quote*, recorded on the row, not a lifecycle position. Modelling it as a state would have forced `accepted` and `revising` to be mutually exclusive, which they are not — clients accept quotes and then ask for changes.

### 6.3 Revision semantics

A revision never mutates a sent quote. The sent PDF is a commercial document that exists in someone else's WhatsApp.

```python
async def revise(session, original: Quote, delta: RevisionDelta, trace_id: str) -> Quote:
    await transition(session, original.id, QuoteState.SENT, QuoteState.REVISING,
                     actor="user", trace_id=trace_id)

    new = Quote(
        tenant_id=original.tenant_id,
        client_id=original.client_id,
        root_id=original.root_id or original.id,
        supersedes_id=original.id,
        version=original.version + 1,
        number=original.number,              # same number, new version
        state=QuoteState.MATCHING,
        prompt_version=CURRENT_PROMPT_VERSION,
    )
    new.lines = apply_delta(deepcopy(original.lines), delta)   # pure, in domain/
    session.add(new)
    await transition(session, original.id, QuoteState.REVISING,
                     QuoteState.SUPERSEDED, actor="system", trace_id=trace_id)
    return new
```

The document prints `DEV-2026-0042 · v2` and a line stating it replaces v1. Ambiguity about which version a client is holding is a real commercial risk, so it is stated on the page.

`apply_delta` is pure domain code — add line, remove line, change quantity, change VAT, change discount — and is exhaustively unit-tested. Revisions are where subtle pricing bugs hide.

### 6.4 Concurrency guard

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

`ConcurrentTransition` is caught and logged at INFO, not ERROR — under retries it is expected, and treating it as an error trains the team to ignore alerts.

---

## 7. End-to-end request lifecycle

```
t=0.00s  Meta POST /webhooks/whatsapp
t=0.01s  verify X-Hub-Signature-256 (HMAC-SHA256, constant-time, raw bytes)
t=0.02s  BEGIN
           INSERT inbound_messages ON CONFLICT (wamid) DO NOTHING
           → 0 rows? duplicate → COMMIT, return 200, stop
           resolve tenant from phone (unknown → onboarding, §12)
           INSERT outbox (job_name='route_message', payload={wamid})
         COMMIT                              ◄── single transaction, no dual write
t=0.04s  return 200 OK                       ◄── Meta is satisfied here

--- async ---

t=0.1s   [outbox-poller] claims the row, enqueues to Redis, marks dispatched
t=0.2s   [worker-router] load conversation session, run routing cascade (§5.2)
         intent = new_quote → create quote, enqueue ai job
         intent = smalltalk → reply, stop (no ASR spend)
t=0.3s   enqueue ONE acknowledgement via outbound_messages (deduped)

t=0.5s   [worker-ai] fetch media, stream to object storage, ffmpeg → 16k mono WAV
t=1.0s   ASR (cache key: sha256(wav)+provider) → transcript + segment confidence
t=6.0s   path B: multimodal audio-in extraction (parallel, numerics only)
t=8.0s   extraction from transcript (instructor/Pydantic)
t=9.0s   reconcile numerics between paths
t=9.1s   catalog matching per line
t=9.3s   unresolved field? → needs_clarification, ask one question, stop
t=9.4s   pricing (pure domain code)
t=9.5s   outbox → render job

t=10s    [worker-render] Jinja2 → HTML → Playwright → PDF → object storage
t=13s    assign quote number (short, separate transaction)
t=13.1s  automation_mode: auto → outbox send · copilot → awaiting_approval

t=14s    [worker-outbound] claim outbound_messages row, call Meta, store wamid
t=15s    state=sent, usage_events recorded

t=15–60s [gateway] status callbacks arrive: sent → delivered → read
t=+3d    [scheduler] no outcome recorded → follow-up with buttons (§11.4)
```

Target user-visible latency: **under 45 s at p95**. Above 90 s users re-send, which is why idempotency and the single throttled acknowledgement matter.

---

## 8. Message delivery guarantees

v1 had a dual-write hole inbound and no idempotency outbound. Both are fixed here. This section exists because the two incidents v1 declared unacceptable — a lost voice note and a duplicate PDF — were both caused by v1's own design.

### 8.1 Inbound: transactional outbox

The v1 code was:

```python
inserted = await store_if_new(...)   # committed
if inserted:
    await queue.enqueue_job(...)      # ← crash here loses the message forever
```

If the process dies in the gap, the row exists, so Meta's redelivery hits `ON CONFLICT DO NOTHING` and is silently swallowed. Correct version — one transaction, no external call inside it:

```python
async def receive_message(session, wamid, payload, phone) -> None:
    async with session.begin():
        res = await session.execute(
            insert(InboundMessage)
            .values(wamid=wamid, from_phone=phone, raw_payload=payload, ...)
            .on_conflict_do_nothing(index_elements=["wamid"])
            .returning(InboundMessage.wamid)
        )
        if res.scalar_one_or_none() is None:
            return                                    # genuine duplicate
        session.add(Outbox(job_name="route_message",
                           payload={"wamid": wamid},
                           trace_id=trace_id.get()))
```

The poller is a simple loop with `FOR UPDATE SKIP LOCKED`:

```sql
UPDATE outbox SET dispatched_at = now(), attempts = attempts + 1
WHERE id IN (
    SELECT id FROM outbox
    WHERE dispatched_at IS NULL AND available_at <= now()
    ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED
)
RETURNING *;
```

Delivery is **at-least-once**: the poller may enqueue twice if it crashes after dispatch and before commit. That is fine, because every job is idempotent (§8.3). At-least-once plus idempotent handlers is a far more robust contract than trying for exactly-once.

**Safety net regardless:** a sweeper every 2 minutes picks up `inbound_messages WHERE processed_at IS NULL AND failed_at IS NULL AND received_at < now() - interval '2 minutes'`. If a message ever escapes both mechanisms, this catches it. Alert if it fires more than a handful of times a day — that means one of the mechanisms is broken.

### 8.2 Outbound: claim before send

```python
async def send(session, dedupe_key, tenant_id, to, kind, body) -> None:
    # 1 · reserve. UNIQUE(dedupe_key) makes a second attempt a no-op.
    async with session.begin():
        res = await session.execute(
            insert(OutboundMessage)
            .values(dedupe_key=dedupe_key, tenant_id=tenant_id, to_phone=to,
                    kind=kind, body=body, status="pending")
            .on_conflict_do_nothing(index_elements=["dedupe_key"])
            .returning(OutboundMessage.id)
        )
        msg_id = res.scalar_one_or_none()
        if msg_id is None:
            return                                    # already queued or sent

    # 2 · claim, so two workers cannot both call Meta
    claimed = await claim(session, msg_id)             # pending → claimed
    if not claimed:
        return

    # 3 · the external call, outside any transaction
    try:
        wamid = await provider.send(to, kind, body)
    except ProviderTimeout:
        # Ambiguous: Meta may have accepted it. Do NOT blindly retry.
        await mark_uncertain(session, msg_id)          # §8.5
        raise
    await mark_sent(session, msg_id, wamid)
```

Dedupe keys are deterministic and derived from domain identity, never from a timestamp or UUID:

```
quote:{quote_id}:v{version}:document
quote:{quote_id}:ack
clarification:{clarification_id}:ask
quote:{quote_id}:followup:{n}
```

### 8.3 Job idempotency

The state guard in §6.4 prevents double transitions, but a worker dying after an ASR call and before commit will re-transcribe on retry — and you pay twice. Cache by content hash:

```python
async def transcribe_cached(wav: bytes, provider: str) -> Transcript:
    key = f"asr:{hashlib.sha256(wav).hexdigest()}:{provider}"
    if hit := await cache.get(key):
        return Transcript.model_validate_json(hit)
    t = await asr.transcribe(wav)
    await cache.set(key, t.model_dump_json(), ex=86400)
    return t
```

Same for embeddings (7-day TTL) and extraction (keyed on transcript hash + prompt version). Retries become free, which in turn makes aggressive retry policies safe.

### 8.4 Status callbacks

v1 parsed only `messages`. The same webhook delivers `statuses`, and ignoring them meant delivery was unknown and billing unverifiable.

```python
def iter_statuses(payload):
    for entry in payload.get("entry", []):
        for change in entry.get("changes", []):
            for st in change.get("value", {}).get("statuses", []):
                yield st

async def handle_status(session, st):
    # 'sent' | 'delivered' | 'read' | 'failed'
    await session.execute(
        update(OutboundMessage)
        .where(OutboundMessage.wamid == st["id"])
        .values(**status_columns(st))
    )
    if st["status"] == "failed":
        await on_delivery_failure(session, st["id"], st.get("errors", []))
    if pricing := st.get("pricing"):
        await record_actual_cost(session, st["id"], pricing)   # §15.2
```

What this unlocks:

- **Real delivery confirmation.** "Devis envoyé" is a lie until `delivered` arrives.
- **Failure classification.** Invalid number, blocked, out of window — each needs a different response, and none of them should be a blind retry.
- **Billing reconciliation.** Meta reports the billable category on the status callback. That is the only authoritative cost figure (§15.2).

Statuses arrive for messages we may not have committed yet (`sent` can precede our own commit). Handle the missing-row case by parking the status in a small `orphan_statuses` table and replaying it after 30 s, rather than dropping it.

### 8.5 Ambiguous sends

A timeout means "unknown", not "failed". Retrying a document send that actually succeeded is exactly the duplicate-PDF incident.

Rule: on timeout, mark `claimed` with `error_code='timeout'` and **do not auto-retry**. Wait 60 s for a status callback carrying a `wamid` we can match by recipient and time window. If none arrives, escalate to an operator. Sending a duplicate quote to a real client is worse than a delayed one.

### 8.6 Rate limiting and backpressure

Meta enforces per-number throughput limits. The outbound worker respects a token bucket in Redis, shared across replicas:

```python
async def acquire_send_slot(phone_number_id: str) -> None:
    while not await bucket.take(f"wa:{phone_number_id}", rate=20, per=1.0):
        await asyncio.sleep(0.05)
```

Under backpressure, prioritise: clarifications and documents first, acknowledgements second, follow-ups last. A delayed follow-up costs nothing; a delayed clarification stalls a quote.

---

## 9. WhatsApp integration layer

### 9.1 Webhook verification (GET)

```python
@router.get("/webhooks/whatsapp")
async def verify(request: Request):
    p = request.query_params
    if p.get("hub.mode") == "subscribe" and \
       hmac.compare_digest(p.get("hub.verify_token", ""), settings.WA_VERIFY_TOKEN):
        return PlainTextResponse(p.get("hub.challenge", ""))
    raise HTTPException(403)
```

### 9.2 Signature verification (POST)

Meta signs the **raw body**. Verify against bytes, never a re-serialised dict — key ordering will differ and every signature fails.

```python
@router.post("/webhooks/whatsapp")
async def receive(request: Request):
    raw = await request.body()
    expected = "sha256=" + hmac.new(
        settings.WA_APP_SECRET.encode(), raw, hashlib.sha256
    ).hexdigest()
    if not hmac.compare_digest(request.headers.get("X-Hub-Signature-256", ""), expected):
        logger.warning("webhook.bad_signature")
        raise HTTPException(403)

    payload = json.loads(raw)
    async with db.begin() as session:
        for st in iter_statuses(payload):
            await handle_status(session, st)              # §8.4
        for wamid, msg, phone in iter_messages(payload):
            await receive_message(session, wamid, msg, phone)   # §8.1
    return Response(status_code=200)
```

**Always return 200**, even on internal error. A non-200 makes Meta retry, and a retry on a bug is a retry loop. Errors go to the dead-letter table, not to the HTTP status code.

### 9.3 Media download

Two calls. The URL from step one is short-lived and the download also requires the bearer token.

```python
async def fetch_media(media_id: str) -> tuple[bytes, str]:
    async with httpx.AsyncClient(timeout=30) as c:
        meta = (await c.get(f"{GRAPH}/{media_id}", headers=AUTH)).json()
        if int(meta.get("file_size", 0)) > MAX_MEDIA_BYTES:
            raise MediaTooLarge(meta["file_size"])
        blob = await c.get(meta["url"], headers=AUTH)     # auth required here too
        return blob.content, meta["mime_type"]            # audio/ogg; codecs=opus
```

Store the raw original before any processing. It is your training corpus and your only evidence when a user disputes a quote.

### 9.4 The 24-hour window

Free-form replies are only allowed inside the 24-hour customer service window, and its economics changed on 1 October 2026 — service and utility messages inside the window became billable. Design accordingly:

- `conversation_sessions.last_inbound_at` is the authoritative window clock.
- Outside the window, only approved templates may be sent.
- **Batch outbound.** One acknowledgement, one result. Never "received", then "transcribing", then "here it is". Each extra message is a line item.

```python
def can_send_freeform(session: ConversationSession) -> bool:
    return session.last_inbound_at is not None and \
           (utcnow() - session.last_inbound_at) < timedelta(hours=24)
```

### 9.5 Template inventory

Templates need Meta review, which takes hours to days and can be rejected. **Submit these in week 2**, not week 6 — v1's timeline had them needed before they were requested.

| Name | Category | Use |
|---|---|---|
| `quote_ready` | utility | document delivered outside window |
| `clarification_needed` | utility | one open question, window expired |
| `quote_followup` | utility | outcome check after N days (§11.4) |
| `price_check` | utility | stale catalog item (§11.5) |
| `onboarding_welcome` | utility | first contact (§12) |

Keep the set small. Every template is a review cycle and a maintenance burden, and rejected templates block launch.

### 9.6 Provider abstraction

```python
class MessagingProvider(Protocol):
    async def send_text(self, to: str, body: str) -> str: ...
    async def send_document(self, to: str, url: str, filename: str,
                            caption: str | None) -> str: ...
    async def send_buttons(self, to: str, body: str, buttons: list[Button]) -> str: ...
    async def send_template(self, to: str, name: str, params: dict) -> str: ...
    async def fetch_media(self, media_id: str) -> tuple[bytes, str]: ...
```

Implementations: `MetaCloudProvider`, plus `FakeProvider` for tests and local dev. **No unofficial WhatsApp Web automation libraries** — they work in demos and get the number banned at volume.

---

## 10. The AI pipeline

### 10.1 Governing principle

> The LLM extracts intent. Deterministic code computes money.

No model output is ever multiplied by anything. The LLM returns items, quantities and units. Prices come from the database. Arithmetic comes from `domain/pricing.py`, covered by ordinary unit tests.

### 10.2 ASR provider interface

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

Candidates to benchmark against your own corpus:

| Provider | Notes |
|---|---|
| `atlasia/moulsot.v0.3` | Purpose-built for Darija, explicitly robust to Darija↔French↔Arabic code-switching; top of the public Darija ASR leaderboard. First candidate. |
| `anaszil/whisper-large-v3-turbo-darija` | LoRA adapter on Whisper Large v3 Turbo. Lighter to self-host. |
| `speechbrain/asr-wav2vec2-dvoice-darija` | wav2vec2 + CTC on DVoice. Older baseline, useful as a floor. |
| Commercial API | Baseline and fallback. Zero fixed cost, weaker on Darija. |

Serve self-hosted models behind their own inference service with its own queue. **Do not load a model inside the worker process** — it turns worker scaling into GPU scaling.

Selection is a per-tenant config value with a global default and an automatic failover chain. v1 shipped a speculative `fr_heavy` routing table; that is removed until measurement justifies it.

### 10.3 Extraction

`instructor` + Pydantic: fastest path to working code, multi-provider, and automatic retries that feed the validation error back to the model so it can self-correct.

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

### 10.4 Dual-path numeric reconciliation

The failure that destroys trust is `20 m²` heard as `200 m²`. A single pipeline cannot audit itself.

```python
async def extract_with_verification(wav: bytes, ctx: TenantContext) -> ExtractedQuote:
    transcript, direct = await asyncio.gather(
        transcribe_cached(wav, ctx.asr_provider),    # path A
        multimodal.extract_numerics(wav),            # path B — numbers only
    )
    primary = await llm_extract(transcript.text, ctx)

    for i, line in enumerate(primary.lines):
        b = direct.line_at(i)
        if b is None or b.quantity != line.quantity or b.unit != line.unit:
            line.quantity_confidence = min(line.quantity_confidence, 0.4)
        if seg := transcript.confidence_covering(line.raw_text):
            line.quantity_confidence = min(line.quantity_confidence, seg)
    return primary
```

Any line below `QUANTITY_CONFIDENCE_THRESHOLD` (start 0.75, tune from the corpus) triggers a targeted clarification — one question about one number, not a redo of the whole quote.

This converts an unsolvable accuracy problem into a tractable *uncertainty detection* problem. Path B runs on numeric fields only, so its marginal cost is small.

**Degradation:** if path B is unavailable, do not fail. Fall back to transcript confidence alone and **raise** the threshold from 0.75 to 0.85, so the system asks more questions rather than sending unverified numbers. Record the degraded mode on the quote for later analysis.

### 10.5 Clarification loop

```python
QUESTION_TEMPLATES = {
    "quantity": "Pour {label}, c'est bien {qty} {unit} ?",
    "unit":     "{label} : au m² ou au forfait ?",
    "price":    "Le {label}, à combien est-il facturé le {unit} ?",
    "client":   "Le devis est au nom de qui ?",
}
```

Rules that keep this from becoming a chatbot:

- **One question per message.** Batching produces partial answers you cannot map back.
- **Interactive buttons where the answer is closed.** Buttons carry their own routing id (§5.2 step 1) and need no parsing.
- **Expiry at 24 h**, matching the messaging window. `needs_clarification` → `expired`, partial quote retained.
- **Maximum three rounds** per quote, tracked in `clarifications.round`. Beyond that, hand to a human operator. A system asking a fourth question has failed its promise of zero friction.
- **At most two quotes in `needs_clarification` per tenant** (§5.3), else routing becomes unresolvable.

---

## 11. Catalog, cold start and lifecycle

### 11.1 Matching cascade

Cheapest and most certain first:

```python
async def match_line(session, tenant_id, raw_text, unit_hint) -> MatchResult:
    # 1 · exact alias — free, certain
    if hit := await find_alias_exact(session, tenant_id, normalize(raw_text)):
        return MatchResult(hit.item, 1.0, "alias")

    # 2 · trigram — cheap, handles typos and ASR noise
    if hit := await trigram_search(session, tenant_id, raw_text, threshold=0.55):
        return MatchResult(hit.item, hit.score, "trigram")

    # 3 · vector — semantic, handles genuine synonyms
    emb = await embed_cached(raw_text)
    if hit := await vector_search(session, tenant_id, emb, threshold=0.82):
        return MatchResult(hit.item, hit.score, "vector")

    # 4 · unknown — ask, never invent
    return MatchResult(None, 0.0, "unmatched")
```

`normalize()` handles the messy reality: lowercase, strip accents, collapse whitespace, map Arabic-Indic digits, canonicalise unit words (`mètre carré` / `m2` / `m²` / `metre carre` → `m2`).

**Ambiguity guard:** if the top two vector candidates are within 0.03 of each other, treat it as unmatched and ask. A confident wrong match is worse than a question, because it silently prices the wrong item.

### 11.2 Cold start

A new tenant has an empty catalog. The first quote is when they judge the product and when the system knows least. Handled by design:

1. **Onboarding capture** (§12) — one voice note listing usual services and prices yields 10–20 items.
2. **Learn on the fly.** Unmatched → ask price once → create item with `confirmed = true` → never ask again.
3. **Alias accumulation.** Every raw phrase that resolves is written to `catalog_aliases`. Match quality improves monotonically with usage.
4. **Trade starter packs.** After 20–30 tenants in a trade, ship an anonymised aggregated median-price template. Pre-filled and editable in the first conversation. This is the compounding advantage of holding data — and it delivers value at *onboarding*, where dashboards never would.

### 11.3 Price changes and history

Every price change writes `catalog_price_history`. Two reasons: explaining an old quote to a disputing client, and repricing a revision correctly.

**Revision repricing rule:** a revision uses the **prices of the original quote** for unchanged lines, and current prices only for newly added lines. Silently repricing a line the client already saw is a commercial incident. Where a price has moved, say so explicitly:

> Le prix du carrelage a changé depuis (180 → 195 DH). J'utilise l'ancien prix. Dites-moi si vous voulez le nouveau.

### 11.4 Outcome capture

v1 built follow-up reminders on `accepted_at`, which nothing ever populated. The feature was blind and the conversion analytics justifying the paid plan did not exist. Fixed:

```python
# scheduler, daily
async def request_outcomes(session):
    stale = await session.execute(
        select(Quote).where(
            Quote.outcome.is_(None),
            Quote.sent_at < utcnow() - timedelta(days=3),
            Quote.state == QuoteState.SENT,
        ).limit(500)
    )
    for q in stale.scalars():
        await send(session,
                   dedupe_key=f"quote:{q.id}:followup:1",
                   kind="buttons",
                   body={"text": f"Le devis {q.number} pour {q.client_name} ?",
                         "buttons": [
                             {"id": f"outcome:{q.id}:accepted",  "title": "Accepté"},
                             {"id": f"outcome:{q.id}:refused",   "title": "Refusé"},
                             {"id": f"outcome:{q.id}:no_reply",  "title": "Sans réponse"},
                         ]})
```

Three properties worth noting. The button ids carry their own routing, so §5.2 step 1 resolves them for free. The dedupe key prevents a second nag. And this single message both produces the data *and* is the feature users pay for — the reminder that recovers a forgotten quote. Instrumentation and value are the same message, which is why this is the right first paid feature.

Escalation: at day 3 ask; at day 10 ask once more with the template; then mark `no_reply` with `outcome_source='inferred'`. Never ask a third time.

### 11.5 Stale price nudge

Items untouched for 90 days:

> Le carrelage est toujours à 180 DH le m² ?

Cheap, useful, keeps the catalog trustworthy without an interface. Rate-limit to one such nudge per tenant per week — this is a background chore, not a conversation.

---

## 12. Onboarding

v1 said "resolve tenant from phone" and was silent on failure, which is every new customer's first message.

### 12.1 Unknown sender

```python
async def handle_unknown_sender(session, phone, msg):
    if pending := await find_invite(session, phone):     # pre-registered
        return await start_onboarding(session, pending, phone)
    if await is_rate_limited(phone):                     # abuse guard
        return
    await send_text(phone, WELCOME_UNKNOWN)              # explain, ask to sign up
    await log_lead(session, phone, msg)
```

**Never auto-create a tenant from an inbound message.** Anyone can message the number. Tenant creation requires an explicit signup — an invite link, a web form, or an operator action — and the phone must be verified before it is bound.

### 12.2 Onboarding state machine

```
new → awaiting_business_info → awaiting_catalog → awaiting_first_quote → active
```

| State | Prompt | Completion |
|---|---|---|
| `awaiting_business_info` | business name, ICE, address, logo | header is printable |
| `awaiting_catalog` | "envoyez un vocal avec vos prestations et vos prix" | ≥ 5 confirmed items |
| `awaiting_first_quote` | guided first real quote, always `copilot` | one quote sent |
| `active` | — | normal operation |

Each step is skippable and resumable — an artisan interrupted on site will come back two days later, and the flow must pick up where it stopped rather than restart.

### 12.3 Catalog capture

The single highest-leverage step. One voice note produces most of the starting catalog:

> "Envoyez-moi un vocal en listant vos prestations habituelles et vos prix. Par exemple : pose de carrelage 180 le mètre carré, fenêtre alu 1200 l'unité."

The same extraction pipeline runs with a different prompt (`catalog_capture.v1`) and a different schema (`label`, `unit`, `unit_price_ht` — price is *expected* here, because the user is stating it, not the model inventing it). Results are confirmed in one summary message before writing, since a wrong price here poisons every future quote.

### 12.4 Automation mode progression

```python
def eligible_for_auto(tenant, stats) -> bool:
    return (stats.quotes_sent >= 10
            and stats.correction_rate < 0.10
            and stats.clarification_rate < 0.30
            and tenant.created_at < utcnow() - timedelta(days=14))
```

Promotion is proposed, never imposed:

> Vos 10 derniers devis sont partis sans correction. Je peux les envoyer directement, sans validation ? **[Oui] [Je préfère valider]**

Automatic demotion to `copilot` on two corrections within five quotes. Degrading quietly is better than sending a third wrong document.

---

## 13. Pricing engine

Pure, synchronous, zero I/O, exhaustively tested. The only place money is computed.

### 13.1 Rounding convention (specified, not implied)

v1 quantised per VAT band then summed, which is self-consistent but can differ by 0.01 from VAT computed on the global net. That was an undocumented choice. It is now an explicit, tested rule:

> **RC-1** — Line totals are rounded to the centime.
> **RC-2** — Discount is applied proportionally across VAT bands, on rounded line totals.
> **RC-3** — VAT is computed **per band** on the discounted band base, then rounded.
> **RC-4** — `total_ttc` is the sum of the rounded net and the rounded per-band VAT amounts.
> **RC-5** — Half-up rounding throughout (`ROUND_HALF_UP`), matching Moroccan commercial practice.

Print the per-band VAT breakdown on the document. It makes the arithmetic auditable by the client's accountant and removes any argument about the total.

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
    def total_ht(self) -> Decimal:              # RC-1
        return q2(self.quantity * self.unit_price_ht)

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
    def vat_by_rate(self) -> dict[Decimal, Decimal]:   # RC-2, RC-3
        if not self.subtotal_ht:
            return {}
        ratio = self.net_ht / self.subtotal_ht
        bases: dict[Decimal, Decimal] = {}
        for l in self.lines:
            bases[l.vat_rate] = bases.get(l.vat_rate, Decimal(0)) + l.total_ht
        return {r: q2(q2(base * ratio) * r / 100) for r, base in bases.items()}

    @property
    def total_ttc(self) -> Decimal:                    # RC-4
        return q2(self.net_ht + sum(self.vat_by_rate.values(), Decimal(0)))
```

### 13.2 Invariant tests

```python
@given(lines=st.lists(priced_lines(), min_size=1, max_size=30),
       disc=st.decimals(min_value=0, max_value=50, places=2))
def test_invariants(lines, disc):
    q = PricedQuote(tuple(lines), disc)
    assert q.total_ttc == q2(q.net_ht + sum(q.vat_by_rate.values(), Decimal(0)))  # RC-4
    assert q.total_ttc >= q.net_ht
    assert q.net_ht <= q.subtotal_ht
    # order independence: line ordering must not move the total
    assert PricedQuote(tuple(reversed(lines)), disc).total_ttc == q.total_ttc

def test_golden_cases():
    """Hand-computed cases, verified once by a human against RC-1..RC-5.
    These are the regression anchor — never regenerate from code output."""
    for case in load_yaml("tests/fixtures/pricing_golden.yaml"):
        assert PricedQuote(**case["input"]).total_ttc == Decimal(case["expected_ttc"])
```

The golden cases matter more than the property tests: property tests confirm internal consistency, golden cases confirm the convention itself is right. Compute them by hand once and never regenerate them from the code, or the test becomes a tautology.

---

## 14. Document rendering

**Jinja2 → HTML → Playwright (Chromium) → PDF.** Layout iteration is CSS, not a report DSL, which matters because the template will change 50 times in the first two months.

```python
async def render(quote: PricedQuote, tenant: Tenant) -> bytes:
    html = env.get_template("quote_fr.html").render(quote=quote, tenant=tenant)
    page = await browser_pool.acquire()
    try:
        await page.set_content(html, wait_until="networkidle")
        return await page.pdf(format="A4", print_background=True,
                              margin={"top":"12mm","bottom":"14mm",
                                      "left":"12mm","right":"12mm"})
    finally:
        await browser_pool.release(page)
```

Operational notes:

- **One browser per worker, pooled pages.** Launching Chromium per render costs ~800 ms and a lot of memory.
- **Concurrency 2 per worker.** Chromium is memory-hungry; OOM is the most common render failure.
- **Bundle fonts in the image.** Missing fonts produce silent tofu boxes in production and look fine locally.
- **Snapshot-test the template**: render a fixed quote, rasterise, compare to a committed reference image with tolerance. Catches CSS regressions no unit test will.

### 14.1 Numbering

v1 required gapless numbering. **Removed.** Gapless sequences are a legal requirement for *invoices*, not quotes, and enforcing it takes a row lock on `tenants` that serialises quote creation per tenant — eventually inside a long transaction that also holds rendering.

```python
async def assign_number(session, tenant_id) -> str:
    async with session.begin():                       # short, isolated transaction
        n = await session.scalar(
            update(Tenant).where(Tenant.id == tenant_id)
            .values(quote_counter=Tenant.quote_counter + 1)
            .returning(Tenant.quote_counter))
    return f"DEV-{utcnow():%Y}-{n:04d}"
```

Assigned at render, not at creation, so abandoned quotes do not consume numbers. Gaps are acceptable and expected.

Revisions **keep the number** and increment `version`: `DEV-2026-0042 · v2`, with a printed line stating it replaces v1.

---

## 15. Cost metering

### 15.1 Estimated cost at time of use

Every external call writes a `usage_events` row in the same transaction as its result — a database row, not a metrics counter, because this drives pricing decisions.

```python
async def meter(session, tenant_id, kind, quantity, provider, quote_id=None):
    unit_cost = PRICE_BOOK[kind][provider]            # versioned, in config
    session.add(UsageEvent(
        tenant_id=tenant_id, quote_id=quote_id, kind=kind,
        quantity=Decimal(str(quantity)), unit_cost=unit_cost,
        cost_mad=q2(Decimal(str(quantity)) * unit_cost),
        provider=provider, estimated=True))
```

### 15.2 Reconciliation against Meta

New in v2. Estimated cost is a guess until Meta confirms the billable category on the status callback (§8.4). Message pricing depends on category and on whether the conversation window applied — which our own model cannot fully predict.

```python
async def record_actual_cost(session, wamid, pricing):
    await session.execute(
        update(UsageEvent)
        .where(UsageEvent.kind == "wa_message_out",
               UsageEvent.reference == wamid)
        .values(unit_cost=rate_for(pricing["category"]),
                cost_mad=rate_for(pricing["category"]),
                estimated=False))
```

Alert if estimated and actual diverge by more than 15% over a week. That divergence means the pricing model in config is stale — likely because Meta changed something.

### 15.3 The margin query

The one number that decides whether the business works:

```sql
SELECT
    t.id, t.business_name, t.plan,
    count(DISTINCT q.id)                                        AS quotes,
    round(sum(u.cost_mad), 2)                                   AS cost_mad,
    round(sum(u.cost_mad) / nullif(count(DISTINCT q.id),0), 2)  AS cost_per_quote,
    p.monthly_price_mad - sum(u.cost_mad)                       AS margin_mad,
    bool_or(u.estimated)                                        AS has_estimates
FROM tenants t
JOIN usage_events u ON u.tenant_id = t.id
LEFT JOIN quotes q ON q.tenant_id = t.id
                  AND q.created_at >= date_trunc('month', now())
JOIN plans p ON p.code = t.plan
WHERE u.occurred_at >= date_trunc('month', now())
GROUP BY t.id, t.business_name, t.plan, p.monthly_price_mad
ORDER BY margin_mad ASC;                                        -- worst first
```

Hard guard: at 2× plan price, alert; at 3×, throttle and require a conversation. An unbounded free tier on a per-message-cost product is a way to lose money at scale.

---

## 16. Repository layout

```
devis-whatsapp/
├── app/
│   ├── gateway/            main.py, webhooks.py, health.py, admin.py
│   ├── domain/             ← pure, no I/O
│   │   ├── entities.py
│   │   ├── state_machine.py
│   │   ├── intents.py          intent enum + routing rules (pure)
│   │   ├── revision.py         apply_delta
│   │   ├── pricing.py
│   │   ├── units.py            normalisation & conversion
│   │   └── numbering.py
│   ├── services/           routing.py, ingest.py, transcription.py,
│   │                       extraction.py, matching.py, quoting.py,
│   │                       clarification.py, onboarding.py, outcomes.py,
│   │                       metering.py
│   ├── adapters/
│   │   ├── messaging/      base.py, meta_cloud.py, fake.py
│   │   ├── asr/            base.py, moulsot.py, whisper_api.py, fake.py
│   │   ├── llm/            base.py, instructor_client.py, fake.py
│   │   ├── storage/        base.py, s3.py, local.py
│   │   └── pdf/            playwright_renderer.py, browser_pool.py
│   ├── workers/            outbox.py, router.py, ai.py, render.py,
│   │                       outbound.py, scheduler.py, sweeper.py
│   ├── db/                 models.py, session.py, repositories/
│   └── config.py           pydantic-settings, fail-fast on missing vars
├── migrations/
├── templates/              quote_fr.html, styles.css, fonts/
├── prompts/
│   ├── extraction.v3.jinja
│   ├── intent_router.v1.jinja
│   ├── catalog_capture.v1.jinja
│   └── registry.yaml           version → channel mapping (§19)
├── evals/
│   ├── corpus/
│   │   ├── dev/            ~60% — tune freely
│   │   ├── gate/           ~20% — PR gate
│   │   └── test/           ~20% — LOCKED, release only
│   ├── suites/             extraction.yaml, routing.yaml, pricing.yaml
│   └── run.py
├── tests/
│   ├── unit/               domain — fast, no I/O
│   ├── integration/        testcontainers: postgres + redis
│   ├── e2e/                fake providers, full flow
│   ├── fixtures/           pricing_golden.yaml, snapshots/
│   └── test_architecture.py
├── ops/
│   ├── Dockerfile
│   ├── docker-compose.yml
│   └── runbook.md
└── .github/workflows/      ci.yml, deploy.yml, evals-nightly.yml, prompt-rollout.yml
```

**Prompts live as versioned files** referenced by name and version. A prompt inlined in Python cannot be diffed, reviewed, evaluated or rolled back independently of code — and §19 depends on that independence.

---

## 17. Local development

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

  outbox:
    build: { context: .., dockerfile: ops/Dockerfile }
    command: python -m app.workers.outbox
    env_file: [../.env.local]

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

Default local config uses `FakeProvider` for messaging, ASR and LLM, so the whole flow runs offline with no keys and no cost. `PROVIDER_MODE=real` only when specifically testing integration.

**Conversation simulator.** Add a CLI that replays a scripted conversation against the local stack:

```bash
python -m app.dev.simulate scripts/revision_flow.yaml
```

Because the interesting bugs are now conversational (§5, §6.3), not single-message, and clicking through WhatsApp to test a two-quote disambiguation is unbearable.

---

## 18. CI/CD pipeline

### 18.1 Pull request

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
      - name: extraction gate
        env: { LLM_API_KEY: ${{ secrets.LLM_API_KEY_EVAL }} }
        run: uv run python evals/run.py --split gate --suite extraction
      - name: routing gate
        run: uv run python evals/run.py --split gate --suite routing
      - uses: actions/github-script@v7
        if: always()
        with:
          script: |
            const fs = require('fs');
            github.rest.issues.createComment({ ...context.repo,
              issue_number: context.issue.number,
              body: fs.readFileSync('evals/report.md', 'utf8') });

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

### 18.2 Deploy

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
          tags: ghcr.io/${{ github.repository }}:${{ github.sha }}

  staging:
    needs: image
    runs-on: ubuntu-latest
    environment: staging
    steps:
      - run: ./ops/run-migrations.sh staging ${{ needs.image.outputs.digest }}
      - run: ./ops/deploy.sh staging ${{ needs.image.outputs.digest }}
      - run: ./ops/smoke.sh https://staging.api.internal

  production:
    needs: staging
    runs-on: ubuntu-latest
    environment: production        # manual approval gate
    steps:
      - run: ./ops/run-migrations.sh production ${{ needs.image.outputs.digest }}
      - name: canary (5 named tenants)
        run: ./ops/deploy.sh production ${{ needs.image.outputs.digest }} --canary
      - name: watch 10 min
        run: ./ops/watch-canary.sh || (./ops/rollback.sh production && exit 1)
      - name: full rollout
        run: ./ops/deploy.sh production ${{ needs.image.outputs.digest }}
```

Three things this gets right:

- **Migrations are a separate step**, run once, before any new container starts.
- **Deploy by digest, not tag.** Tags are mutable; digests are what you actually rolled back to.
- **Canary by tenant, not traffic percentage.** In a multi-tenant system the variance comes from the tenant's trade, not from request volume. Five known tenants who agreed to be early beats 5% of traffic.

### 18.3 Environment separation

| | staging | production |
|---|---|---|
| WhatsApp number | dedicated test number | real number |
| Meta app | dev app | live app |
| Database | separate instance | separate instance |
| LLM/ASR keys | separate, budget-capped | production |
| Tenants | seeded fixtures | real customers |

Never point staging at the production number. A bug in staging then messages real tradespeople.

---

## 19. Prompt and model rollout

New in v2. A prompt or model change is riskier than a code change — it has no type system, no compiler, and a silent failure mode — yet v1 shipped both down the identical pipeline.

### 19.1 Prompts are versioned artefacts

```yaml
# prompts/registry.yaml
extraction:
  stable: v3
  canary: v4
  rollout_pct: 0            # 0 = canary tenants only
intent_router:
  stable: v1
  canary: null
```

Resolution is per tenant, at call time:

```python
def resolve_prompt(name: str, tenant: Tenant) -> PromptVersion:
    reg = registry[name]
    if tenant.prompt_channel == "canary" and reg.get("canary"):
        return load(name, reg["canary"])
    if reg.get("canary") and stable_hash(tenant.id) < reg["rollout_pct"]:
        return load(name, reg["canary"])
    return load(name, reg["stable"])
```

`quotes.prompt_version` records which version produced each quote. Without it, "did quality drop after Tuesday" is unanswerable.

### 19.2 Rollout procedure

```
1. new version passes the gate split in CI
2. merge → registry updated → deployed (no behaviour change, rollout_pct = 0)
3. promote 5 canary tenants                      → observe 48 h
4. rollout_pct 10 → 25 → 50 → 100                → observe 24 h between steps
5. old version stays loadable for 30 days
```

**Rollback is a config change, not a deploy.** Set `canary: null`, reload the registry. Seconds, not a pipeline run. That property is the entire reason prompts are separate from code.

### 19.3 Model version pinning

Pin exact model identifiers, never floating aliases. Providers update checkpoints behind stable names, and a silent checkpoint change is indistinguishable from your own regression.

The nightly eval (§20.5) runs the **full** corpus against the pinned model. A score drop with no code change is a provider-side change — one of the few things you cannot detect any other way.

---

## 20. Evaluation harness

This is what separates a demo from a product.

### 20.1 The v1 flaw

v1 had a PR suite and a full corpus, with **no held-out split**. Tuning prompts against the same cases the gate checks means the gate measures memorisation, not quality. Over ten iterations you drift to 0.99 on the corpus with unchanged field performance. Every quality number in v1 was therefore unreliable. This is the single most important correction in v2.

### 20.2 Corpus splits

```
evals/corpus/
  dev/    ~60%  tune freely, look as often as you like
  gate/   ~20%  runs on every PR, blocking
  test/   ~20%  LOCKED — release only, one person, results recorded
```

Rules, and they only work if they are actually followed:

- Split **by tenant and by recording session**, not by file. The same artisan's voice notes across splits leaks speaker characteristics and inflates every score.
- **Never look at `test/` while iterating.** Opened at release, results appended to `evals/history.md` with date, prompt version and model version.
- **If `dev` and `test` diverge by more than 5 points, you have overfit.** Stop tuning, add data.
- New cases land in `dev` by default. Promotion to `gate` requires review; `test/` grows only in deliberate quarterly batches.

### 20.3 Case format

```json
{
  "id": "002_menuiserie_darija",
  "split": "gate",
  "meta": { "tenant_ref": "t07", "session": "s03", "trade": "menuiserie",
            "language": "mixed", "noise": "high", "duration_s": 19.4,
            "source": "field_test_w1" },
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

**Sizing:** the gate suite must run on every pull request — tens to low hundreds of cases. Reserve the full corpus for release branches and the nightly job. A 20-minute eval on every PR gets disabled within a week.

### 20.4 Metrics

| Metric | Gate | Why |
|---|---|---|
| **Quantity exact-match** | ≥ 0.98 blocking | The trust-destroying failure |
| Unit exact-match | ≥ 0.95 blocking | Wrong unit = wrong price |
| Item recall | ≥ 0.92 blocking | A missing line is visible |
| **Intent accuracy** | ≥ 0.95 blocking | Misrouting corrupts a real document (§5) |
| **Disambiguation precision** | = 1.00 blocking | Never answer the wrong quote |
| Client name match | ≥ 0.85 warning | Easy for the user to fix |
| Clarification rate | ≤ 0.25 warning | Friction proxy |
| p95 latency | ≤ 45 s warning | Re-send trigger |
| Cost per quote | ≤ 1.20 MAD warning | Margin |

Word Error Rate is deliberately **not** a gate. An ASR system can misspell every word and still yield a perfect quote if the numbers and item nouns survive. Gate on what reaches the customer.

Warn on metrics still being calibrated; block only on metrics whose baseline has held steady and stopped producing false alarms. Promote a metric from warning to blocking, never the reverse.

### 20.5 Promptfoo and the nightly run

Test cases and assertions live in YAML — JSON schema validation, exact match, cost and latency thresholds, model-graded checks — run from the CLI and integrated with GitHub Actions to fail the build on regression.

```yaml
# evals/suites/extraction.yaml
prompts: [file://../../prompts/extraction.v3.jinja]
providers:
  - anthropic:messages:claude-sonnet-4-6
  - id: openai:gpt-4.1-mini        # cheaper challenger, always benchmarked
defaultTest:
  assert:
    - type: is-json
      value: file://../schemas/extracted_quote.json
    - type: cost
      threshold: 0.004
    - type: latency
      threshold: 8000
tests: file://../corpus/gate/*.json      # case format is JSON (§20.3)
```

Nightly: run the **full** corpus across all ASR candidates and both prompt channels, post the leaderboard to Slack. This is how you learn a provider silently changed a checkpoint.

### 20.6 The closed loop

```
user reports a wrong quote
        ↓
find the Langfuse trace by quote_id
        ↓
add trace to corpus/dev/ with the corrected output
        ↓
promote to gate/ at the next review if it represents a class of failure
        ↓
the regression can never silently return
```

Any trace or observation can be added to a dataset directly from the Langfuse UI, which turns every incident into a permanent regression test in one action. Source expected outputs from domain experts correcting real outputs rather than writing ideal answers from scratch — corrections carry information invented cases do not.

**Note the promotion step**, absent from v1. Incidents landing straight in the gate suite quietly turns the gate into the tuning set, which is exactly the flaw §20.1 fixes.

### 20.7 Tooling risk

Promptfoo was acquired by OpenAI in early 2026; the company has stated the open-source project continues under its existing licence. Worth monitoring, not worth avoiding. Keep the corpus format tool-agnostic (audio + JSON) and the runner stays replaceable — the corpus is the asset, not the tool.

---

## 21. Observability

### 21.1 Trace propagation

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

Context variables do not cross process boundaries, so the outbox row carries `trace_id` explicitly (§4.2) and the poller restores it on dispatch.

### 21.2 Structured logging

`structlog`, JSON to stdout, always with `trace_id`, `tenant_id`, `quote_id`.

```python
log.info("extraction.completed",
         lines=len(result.lines),
         min_confidence=min(l.quantity_confidence for l in result.lines),
         asr_provider=transcript.provider,
         prompt_version=ctx.prompt_version,
         duration_ms=elapsed)
```

**Never log** transcripts, client names, phone numbers or prices at INFO. That is customer commercial data. Log identifiers and let someone authorised join to the content.

### 21.3 Langfuse

Every LLM and ASR call is a span. Traces, cost tracking, prompt management and versioning, and evaluation datasets in one place — the reason to prefer it over rolling your own.

```python
@observe(name="extract_quote")
async def llm_extract(text: str, ctx: TenantContext) -> ExtractedQuote:
    langfuse_context.update_current_trace(
        session_id=ctx.quote_id, user_id=str(ctx.tenant_id),
        tags=[ctx.trade, ctx.language_hint, f"prompt:{ctx.prompt_version}"])
    ...
```

### 21.4 Business metrics, not just system metrics

v1 tracked only technical health. These matter as much:

| Metric | Cadence | Signal |
|---|---|---|
| Quotes per active tenant per week | weekly | retention, the week-0 exit criterion at scale |
| Correction rate per tenant | weekly | drives auto/copilot promotion (§12.4) |
| Time from voice note to sent | daily | the actual product promise |
| Outcome capture rate | weekly | whether §11.4 works |
| Quote acceptance rate | monthly | the number that sells the follow-up feature |
| Catalog size per tenant | monthly | cold start being solved or not |

### 21.5 Alerts

| Alert | Threshold | Severity |
|---|---|---|
| Webhook p99 latency | > 2 s over 5 min | page |
| Queue depth | > 200 for 10 min | page |
| Outbox lag | > 60 s | page (dual-write protection failing) |
| Quote failure rate | > 5% over 30 min | page |
| ASR provider errors | > 10% over 10 min | page (failover should have fired) |
| Duplicate outbound blocked | any | investigate (a dedupe key is wrong) |
| Sweeper picked up messages | > 5/day | investigate (outbox is leaking) |
| Intent confidence p50 drop | > 10 pts week over week | investigate |
| Clarification rate | > 40% over 1 h | investigate |
| Tenant cost > 2× plan | daily | investigate |
| Signature verification failures | sustained | security |

---

## 22. Security and compliance

### 22.1 Tenant isolation

Three layers, because one is never enough:

1. RLS in PostgreSQL (§4.7)
2. Repository layer requiring an explicit `tenant_id` argument — no default
3. An integration test attempting a cross-tenant read and asserting it fails

```python
async def test_cross_tenant_read_is_blocked(db, tenant_a, tenant_b, item_of_a):
    async with tenant_session(db, tenant_b.id) as s:
        assert await s.get(CatalogItem, item_of_a.id) is None
```

### 22.2 Phone number binding

New in v2, and the most likely real attack. If tenant resolution is by phone number alone, anyone who spoofs or acquires a former customer's number inherits their catalog and client list.

- Binding requires a verification code sent to that number during onboarding.
- Unbinding on churn is immediate and logged.
- Number recycling is real: if a tenant has been inactive 12 months, require re-verification before serving them.

### 22.3 Secrets

GitHub Environments for CI, a secrets manager at runtime. Never in the repo, never in the image. Rotate the Meta app secret and system user token quarterly — both are high value.

`app/config.py` fails fast at startup on any missing variable. A worker that boots and silently misbehaves because `WA_APP_SECRET` was empty is worse than one that refuses to start.

### 22.4 Data protection

- Audio is customer speech, potentially containing third-party personal data. Retain 90 days by default, then delete unless the tenant opted into corpus contribution.
- **Opt-in for training use** must be explicit and timestamped. This is both correct practice and what makes the dataset legally usable later.
- Encrypt at rest and in transit.
- Implement per-tenant export and deletion before you have 50 customers, not after.
- **Deletion must cascade to the corpus.** If a tenant withdraws consent, their audio has to leave `evals/corpus/` too — which means corpus files carry `tenant_ref` (§20.3) precisely so this is possible.

**Morocco:** processing personal data requires declaration with the CNDP under law 09-08. Handle it early — inexpensive, and blocking if a customer's own compliance review asks. If any tenant serves EU clients, GDPR applies to that data too.

### 22.5 Input handling

Webhook payloads are untrusted. Validate against a Pydantic model before touching anything. Cap audio duration (reject > 5 min) and file size. A 40-minute voice note is either an accident or an attack, and either way it should not reach the ASR provider on your budget.

Rate-limit per phone number, including unknown senders (§12.1). The webhook is a public endpoint and unknown-sender handling must not be a free amplification path.

---

## 23. Deployment topology and scaling

### 23.1 v1 (0–500 tenants)

Managed platform — Railway, Render or Fly.io. Managed Postgres with `pgvector`, managed Redis, S3-compatible object storage. Roughly $150–400/month before AI costs.

**No Kubernetes.** At this size it is a second product to maintain with no user. Docker keeps the exit open.

### 23.2 Scaling order

Bottlenecks appear in this sequence:

1. **AI workers** — first and most predictable. Scale horizontally on queue depth.
2. **GPU inference** (if self-hosting ASR) — the real cost cliff. Batch aggressively; queue rather than autoscale, because GPU cold starts are minutes.
3. **Render workers** — memory-bound. Add replicas, never concurrency.
4. **Postgres** — read replicas for analytics long before anything else. The write path is light.
5. **Gateway** — last. It does almost nothing.

The outbox poller is a **singleton and therefore a throughput ceiling**. At 100 dispatches/second it is nowhere near binding, but it is the first thing to shard (by hash range) if it ever is.

### 23.3 The self-host decision

Compute the crossover rather than guessing:

```
API:        cost_per_second × total_audio_seconds
Self-host:  gpu_hourly × 730  +  ops_time_value
```

At a 20 s average voice note and 15 000 quotes/month, that is ~83 hours of audio. Run the numbers against a current GPU quote and current API pricing. Below the crossover the API is not just cheaper, it is less operational surface. Revisit quarterly.

### 23.4 Backups

Daily automated Postgres backups, 30-day retention, plus point-in-time recovery. **Test the restore quarterly and write down how long it took.** An untested backup is a belief, not a backup.

Object storage (audio, PDFs) needs its own backup policy. A sent PDF that no longer exists is a customer-facing failure, and versioned bucket + lifecycle rules is the cheap answer.

---

## 24. Business continuity

New in v2. The product depends on one phone number controlled by a company that can suspend it, and v1 had no answer.

### 24.1 Loss of the WhatsApp number

Causes: policy violation, quality-rating collapse, billing failure, or an error. Recovery via Meta support takes days.

Mitigation:

- **A second number, pre-registered and template-approved**, kept warm with low traffic. `tenant_phones` already maps tenants to a sending number, so failover is a config change.
- **Quality rating monitored daily.** A drop to "medium" is the early warning; users marking messages as spam is the usual cause, which makes §9.4's batching a reliability measure, not only a cost one.
- **An alternative channel for the announcement.** Tenant email or SMS collected at onboarding, purely so you can say "we're down, here's what's happening". Silence during an outage costs more trust than the outage.

### 24.2 Provider failure

| Failure | Mitigation |
|---|---|
| ASR provider down | automatic failover chain (§10.2); quality is logged, so degradation is visible |
| LLM provider down | secondary provider behind the same `instructor` interface |
| Object storage down | queue documents, retry; do not fail the quote |
| Postgres down | full outage; nothing to do but restore quickly, so measure the restore |

### 24.3 Degraded mode

When the AI path is unavailable, the product should not vanish. A minimal fallback — acknowledge, store the audio, tell the user honestly, and process when service returns — keeps the promise partially intact:

> Je reçois bien votre message, mais j'ai un problème technique. Je vous envoie le devis dès que c'est réglé.

The voice note is safe in object storage. That is the difference between a delay and a data loss.

---

## 25. Failure modes and runbook

| Failure | Detection | Automatic response | Human action |
|---|---|---|---|
| ASR provider down | error rate > 10% | failover to secondary | verify quality did not silently drop |
| LLM rate-limited | 429s | backoff, then queue | raise quota |
| Extraction empty | empty `lines` | ask user to re-send | inspect trace, add to `corpus/dev/` |
| Audio corrupt / silent | ffmpeg fails or < 1 s | ask user to re-record | none |
| Low confidence | pipeline check | targeted clarification | none |
| Intent unclear | confidence < 0.7 | ask plainly (§5.5) | relabel in `intent_decisions` |
| Two quotes pending | routing rule | disambiguation buttons | none |
| Render OOM | container restart | retry once at concurrency 1 | reduce replica concurrency |
| Send timeout | provider exception | mark uncertain, wait for callback (§8.5) | operator decides after 60 s |
| Delivery failed | status callback | classify: invalid / blocked / window | contact tenant if invalid |
| Webhook storm | queue depth spike | idempotency absorbs duplicates | check for a redelivery loop |
| Outbox lag | poller metric | — | **incident**: messages are stalling |
| Duplicate quote sent | user complaint | — | **incident**: a dedupe key is wrong |
| Wrong price sent | user complaint | — | **incident**: trace, correct, corpus, notify tenant |
| Cross-tenant data seen | any report | — | **critical**: RLS breach, stop deploys |

The last four are true incidents. Everything else is degraded service, which the user experiences as a delay or a question, not a broken promise.

**Dead letters:** jobs failing 3 times land in `failed_jobs` with full payload and traceback, surfaced in a daily digest. Never silently drop a voice note — if it cannot be processed, tell the person so they can try again.

---

## 26. Build sequence

Order matters more than speed. Each step de-risks the next.

### Week 0 — Manual operation (no code)

One WhatsApp number, ten tradespeople, quotes produced by hand within 30 minutes. Collect every audio file, every quote, every price mentioned.

**Also record, from day one:** every message that is *not* a quote request. That log is the seed corpus for the intent router (§5) — the component v1 forgot, and the one with no data source unless you start now.

**Exit:** at least 3 of 10 send an unprompted second voice note.

### Week 1–2 — Skeleton, measurement, templates

- Repo, Docker, compose, CI on an empty suite
- Postgres schema + migrations + RLS + the cross-tenant test
- Webhook: signature verification, inbound outbox, status callbacks, ACK only
- **Benchmark all ASR candidates** against the week-0 corpus; write the numbers down
- **Submit WhatsApp templates for review** (§9.5) — weeks of lead time, so this is the earliest possible moment

**Exit:** a chosen ASR provider justified by measured numbers on your own audio, and templates in review.

### Week 3–4 — The core path

- Ingest → route → transcribe → extract → match → price → render → send
- Intent router with rules; classifier only where rules cannot decide
- Fake providers for every dependency; e2e runs offline
- Pricing engine with golden cases and property tests
- First PDF a real person would send

**Exit:** a quote produced end-to-end from a real voice note, correct.

### Week 5 — Making it honest

- Dual-path numeric reconciliation
- Clarification loop with buttons, expiry, round limit
- Outbound idempotency and the claim protocol
- Catalog matching cascade and alias learning
- Eval harness with corpus splits, wired into CI as blocking gates

**Exit:** the gate blocks a deliberately introduced regression, and `dev`/`test` scores agree.

### Week 6 — Making it operable

- Langfuse, structured logging, trace propagation through the outbox
- Cost metering, status reconciliation, the margin query
- `automation_mode` per tenant; week-0 users move to `copilot`
- Alerts, dead-letter digest, runbook

**Exit:** week-0 users are on the automated system in copilot mode.

### Week 7 — Revisions and onboarding

- Quote versioning and the revision flow (§6.3)
- Onboarding state machine and catalog capture (§12)
- Conversation simulator for the flows that are painful to test by hand

**Exit:** a tenant can onboard themselves and revise a sent quote.

### Week 8 — Making it earn

- Outcome capture and follow-up reminders (§11.4)
- Graduate the best tenants to `auto`
- Payment and plan enforcement
- Prompt rollout machinery (§19) before the first prompt change ships to everyone

**Exit:** first paying customer, and a measured cost per quote.

---

## 27. Open decisions

| # | Decision | Options | Blocking |
|---|---|---|---|
| D1 | Primary segment | solo tradesperson vs 5–20 person firm | pricing, product depth |
| D2 | BSP for the WhatsApp API | 360dialog / Twilio / Wati / direct Cloud API | week 1 |
| D3 | ASR: self-host or API first | depends on §23.3 crossover | week 2 |
| D4 | Multimodal provider for path B | must accept audio input | week 5 |
| D5 | Hosting platform | Railway / Render / Fly.io / Scaleway | week 1 |
| D6 | Data residency requirement | does any target customer require MA or EU hosting | week 1 |
| D7 | Corpus licence | exactly what tenants consent to on opt-in | week 0 |
| D8 | **Second WhatsApp number** | when to register it (§24.1) | before first paying customer |
| D9 | **Operator tooling** | copilot approval and disambiguation need *some* interface — WhatsApp-based, or a minimal internal web page | week 6 |

D9 is worth flagging: v1 and this document both assume an operator can approve a quote in copilot mode and resolve escalations, without ever specifying how. A minimal internal page is probably 200 lines and should not be discovered as missing in week 6.

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
| **wamid** | WhatsApp message id, the inbound idempotency key |
| **dedupe key** | Deterministic outbound identity, e.g. `quote:{id}:v2:document` |
| **outbox** | Job intents written in the same transaction as the state they describe |
| **BSP** | Business Solution Provider, Meta-approved API reseller |
| **tenant** | One business using the product |
| **gate split** | The ~20% of the corpus that blocks pull requests |
| **locked test split** | The ~20% opened only at release, never used for tuning |
| **copilot mode** | System drafts, a human approves before sending |
| **cold start** | A new tenant with an empty catalog |
| **RC-1..RC-5** | The rounding convention (§13.1) |
| **ICE / RC / IF** | Moroccan company identifiers printed on commercial documents |

## Appendix C — Review checklist for v3

Questions to ask of this document at the next review, in the same spirit that produced v2:

1. What arrives that §5 still does not classify?
2. Where does a network call still sit inside a database transaction?
3. Which piece of state has exactly one writer and no audit trail?
4. What in the eval harness is now being tuned against?
5. Which failure is detected only by a customer complaint?
6. What did we specify that no user has asked for?
