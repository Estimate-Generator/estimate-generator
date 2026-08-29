---
name: devis-data-layer
description: Write schema changes, Alembic migrations, SQLAlchemy models and repository code for the voice-to-quote WhatsApp project, with multi-tenant isolation and row-level security applied correctly. Use this whenever the task involves adding or altering a table or column, writing a migration, adding an index, writing a query or repository method, or storing any new kind of data — including when the user just says "store this", "add a field", "save the result", or describes a feature that obviously needs persistence. Forgetting tenant_id or RLS on a new table leaks one customer's rate card to another, so consult this before writing any DDL rather than copying the shape of a nearby table.
---

# Data layer

Every table in this system is tenant-scoped, and getting that wrong is the highest-severity bug the project can ship. This skill covers the mechanics.

The primary table is `documents` (with a `kind` column), not `quotes` — the seam that lets invoicing be an extension rather than a rewrite.

## Before writing DDL, answer three questions

1. **Is this row owned by a tenant?** Almost always yes. The exceptions are `tenants`, `tenant_phones`, `outbox`, `plans`, and `inbound_messages` (which is written before the tenant is known). Everything else gets `tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE`.
2. **What is the natural idempotency key?** If this table records something that arrives from outside or gets sent outside, it needs a `UNIQUE` constraint that makes a retry a no-op. Retries are not exceptional here; they are the normal operating mode.
3. **Does this value need to be true later, or true now?** Anything printed on a document is a *snapshot* and gets copied into the row (`quote_lines.unit_price_ht`). Joining live to `catalog_items` at render time silently rewrites history when a price changes.

## Table template

```sql
CREATE TABLE thing (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- columns
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON thing (tenant_id);

ALTER TABLE thing ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON thing
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
```

The RLS policy is part of the same migration as the table. A table that exists for even one deploy without its policy is a table someone will query without a filter.

## Column rules

| Kind of value | Type | Why |
|---|---|---|
| Money | `NUMERIC(12,2)` | `float` loses centimes; see the `devis-pricing` skill |
| Quantity | `NUMERIC(12,3)` | 0.5 m³ and 12.75 ml are real |
| Rate / percentage | `NUMERIC(5,2)` | stored as `20.00`, not `0.20` |
| Confidence score | `NUMERIC(4,3)` | 0.000–1.000 |
| Timestamp | `TIMESTAMPTZ` | never `TIMESTAMP`; stores UTC, and Morocco's offset changes in Sept 2026 |
| Date boundary | `DATE`, computed in `Africa/Casablanca` then converted | `valid_until` must mean 30 days as the user experiences them |
| Enum-like | `TEXT` + `CHECK` | Postgres enums need a migration to extend; text plus a check does not |
| Vector | `VECTOR(1024)` | with an `hnsw` index using `vector_cosine_ops` |

## Indexes

Add the index in the same migration as the query that needs it. Two patterns worth knowing:

**Partial indexes for state scans.** Most queries look at the small set of in-flight rows, so index only those:

```sql
CREATE INDEX documents_active ON documents (kind, state)
    WHERE state NOT IN ('sent','failed','cancelled','superseded','expired');
```

Every resting state belongs in that predicate. Leaving one out — `expired` was
missed originally — keeps terminal rows in an index whose whole purpose is to be
small.

**Partial unique for optional keys.** A column that is unique when present:

```sql
CREATE UNIQUE INDEX ON documents (tenant_id, kind, number, version)
    WHERE number IS NOT NULL;
```

`kind` is in the key because a devis and a facture do not share a sequence.

## Transaction boundaries follow aggregates

Three aggregates, and one transaction touches one of them:

| Aggregate | Root | Inside |
|---|---|---|
| Document | `documents` | `quote_lines`, `clarifications`, `quote_events` |
| Catalog | `catalog_items` | `catalog_aliases`, `catalog_price_history` |
| Conversation | `conversation_sessions` | `intent_decisions` |

```python
# wrong — one transaction across two aggregates
async with tenant_session(engine, tid) as s:
    await save_lines(s, doc_id, lines)
    await create_aliases(s, learned)        # different aggregate

# right — the document is the consistency requirement; the alias is not
async with tenant_session(engine, tid) as s:
    await save_lines(s, doc_id, lines)
    s.add(Outbox(job_name="learn_aliases", payload={...}))
```

The rule of thumb: **if the second write failing should not undo the first, they belong to different aggregates.** Alias learning failing must not roll back a correctly matched document — the learning is an optimisation, the document is the product.

## Keep transactions short — connections are the real bottleneck

With 20 AI workers, naive pool sizing totals ~148 connections against a Postgres default of 100. The system exhausts connections before CPU, and the symptom looks like a slow database rather than a configuration limit.

```python
# wrong — holds a connection across a 12-second network call
async with tenant_session(engine, tid) as s:
    doc = await load(s, doc_id)
    transcript = await asr.transcribe(wav)     # ← connection held, idle
    await save(s, doc_id, transcript)

# right — fetch, release, call, re-acquire
async with tenant_session(engine, tid) as s:
    doc = await load(s, doc_id)
transcript = await asr.transcribe(wav)
async with tenant_session(engine, tid) as s:
    await save(s, doc_id, transcript)
```

Pool size reflects *concurrent transactions*, not concurrent tasks. AI workers need a pool of 2, not 5.

The RLS approach uses `SET LOCAL`, which is transaction-scoped and therefore pgbouncer-compatible in transaction mode. Session-scoped `SET` would not be. If asyncpg runs behind pgbouncer, set `statement_cache_size=0`.

## Batch, do not loop

A 12-line document matched line-by-line produces 12 embedding calls and 12 vector queries. Batch: one bulk alias lookup, one embedding call, one `UNNEST` vector query. Roughly 24 round trips become 3, and the embedding API is billed once instead of twelve times — better latency and better margin from the same change.

## Session handling

Every request-scoped transaction sets the RLS variable. Use the helper rather than opening a bare session:

```python
async with tenant_session(engine, tenant_id) as s:
    ...   # RLS is now active for this transaction
```

Cross-tenant work (metering rollups, the outbox poller) uses the `BYPASSRLS` role via `admin_session()`. If you find yourself reaching for `admin_session()` inside request handling, that is the signal that something is wrong with the design, not with RLS.

## Migrations

Generate, then **read the generated file before committing it**. Alembic autogenerate misses RLS policies, partial indexes, and check constraints — everything in this document that matters most.

```bash
uv run alembic revision --autogenerate -m "add thing table"
# open the file, add the RLS policy and partial indexes by hand
uv run alembic upgrade head
uv run alembic downgrade -1 && uv run alembic upgrade head   # reversibility
```

Two rules with real consequences:

- **Migrations never run on application startup.** With N replicas they race. They are a separate CI step, run once, before any new container starts.
- **Destructive changes use expand/contract**, four deploys: add the new column → deploy code writing both → backfill → deploy code reading new → drop old. This is the only sequence that survives a rollback halfway through.

For the full RLS setup, the `BYPASSRLS` role, and worked expand/contract examples, read `references/rls-and-migrations.md`.

## Verify isolation

Every new tenant-scoped table gets a test. It is three lines and it is the only thing standing between a bug and a data breach:

```python
async def test_thing_is_tenant_isolated(db, tenant_a, tenant_b, thing_of_a):
    async with tenant_session(db, tenant_b.id) as s:
        assert await s.get(Thing, thing_of_a.id) is None
```

`scripts/check_tenant_isolation.py` scans the schema and reports any table with a `tenant_id` column but no RLS policy. Run it after any migration:

```bash
python scripts/check_tenant_isolation.py "$DATABASE_URL"
```

## Common mistakes in this codebase

**Copying a nearby table's shape.** `inbound_messages` has no RLS because the tenant is unknown at write time. Copying it as a template for a tenant-scoped table produces exactly the bug this skill exists to prevent.

**Adding a foreign key without an index.** Postgres indexes the referenced side, not the referencing side. Every `REFERENCES` needs its own index or deletes become table scans.

**`ON DELETE CASCADE` on `documents`.** A sent quote is a commercial document that exists in someone else's WhatsApp. Reference it with `ON DELETE SET NULL` from anything that is not itself part of the document aggregate.

**Storing a live reference where a snapshot is needed.** `quote_lines.unit_price_ht` is copied, not joined. A March quote must still print March's price in June.
