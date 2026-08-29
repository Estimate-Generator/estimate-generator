---
name: devis-architecture-review
description: Review a change in the voice-to-quote project against its architectural invariants before merge — tenant isolation, LLM/money separation, domain purity, idempotency in both directions, no network calls inside transactions, and metering coverage. Use this whenever asked to review, audit, critique or sanity-check code or a pull request, when asked "does this follow our architecture", "is this right", "what am I missing", or before merging anything that touches messaging, money, model calls or the schema. Also use it proactively after implementing a non-trivial feature, since the failures this catches are silent ones that no test will surface on its own.
---

# Architecture review

Review against the invariants first, then style. The nine invariants each exist because violating them causes a customer-visible failure that ordinary tests do not catch — a leaked rate card, a duplicate PDF, a hallucinated price. Style issues are recoverable; these are not.

## The nine checks, in severity order

**1 · Tenant isolation.** Does every new table have `tenant_id` and an RLS policy in the same migration? Does every new query run inside `tenant_session()`? Is there an isolation test?

Red flag: `admin_session()` or a `BYPASSRLS` role appearing anywhere in request-handling code. That is legitimate only in the outbox poller and metering rollups.

```bash
python ../devis-data-layer/scripts/check_tenant_isolation.py "$DATABASE_URL"   # RLS gaps
python scripts/check_domain_purity.py app/                                     # import and money checks
```

The first needs a live database, so it runs after migrations. The second is static
and belongs in CI. Neither proves anything on its own — both are heuristics.

**2 · The LLM never touches money.** Search any new or changed Pydantic model for `price`, `total`, `amount`, `cost`, `montant`. In an extraction schema, these should not exist. The single exception is `catalog_capture`, where the user is stating their own prices aloud and the result is confirmed back before being written.

Red flag: a service multiplying a value that came from a model response.

**3 · Domain purity.** `app/domain/` imports nothing from `adapters`, `db`, or any third-party client. `tests/test_architecture.py` enforces this, so a violation shows as a test failure — but check that the new code did not move logic *out* of `domain/` to get around it. Business rules drifting into `services/` is the slower version of the same problem.

**4 · Idempotency, both directions.** Inbound handlers keyed on `wamid`. Outbound sends carrying a deterministic `dedupe_key` derived from domain identity.

Red flags: a `dedupe_key` containing `uuid4()`, `now()`, or a timestamp. A direct call to `provider.send_*` bypassing `send()`. A retry on a timeout for an outbound message.

**5 · No network call inside a transaction.** Trace each new external call and check what transaction is open around it. Job intents go into the `outbox` table in the same transaction as the state they describe; the poller dispatches them afterwards.

Red flag: `async with session.begin():` with an `await provider.…` or `await httpx.…` inside it.

**6 · Metering and tracing.** Every external call writes a `usage_events` row and opens a Langfuse span. An unmetered model call is invisible in the margin query, which quietly makes the business number wrong.

**7 · Composition root.** Adapters are constructed only in `app/composition.py`. Each of `MetaCloudProvider(`, `InstructorClient(`, `S3Storage(` should appear exactly once in `app/`.

Red flags: a client instantiated at module scope, which makes tests import-order dependent and `PROVIDER_MODE=fake` meaningless. A service whose constructor takes the whole `Container` — that is a service locator, and the class stops declaring what it uses.

**8 · Nothing blocks the event loop.** `subprocess.run`, `requests`, `time.sleep`, or Playwright's sync API inside async code stalls every concurrent quote in that worker. The symptom is p99 latency with no obviously slow component, which is miserable to debug.

**9 · Errors are classified.** Every raise is an `AppError` subclass. Provider exceptions are translated inside the adapter, never leaked upward.

Red flags: `except Exception:` that logs and continues, swallowing an `IntegrityError` that should page someone. A retry on an outbound send timeout. A user-facing message built inline rather than via `user_message_key`.

## Then the second pass

- **Money is `Money`, quantities are `Quantity`** — not bare `Decimal`, never `float`. Computed only in `app/domain/pricing.py`. A golden case added if behaviour changed.
- **One transaction, one aggregate.** Nothing spanning a document and the catalog.
- **No connection held across a network call.**
- **Instants in UTC**; date boundaries computed in `Africa/Casablanca` then converted.
- **`temperature=0.0`** for extraction and classification; cache keys include prompt version and model id.
- **Clock and ids injected**, never called directly, in anything new that reasons about time.
- **State transitions declared** in the kind's `spec.lifecycle`, not a module-level constant, with the optimistic guard.
- **Sent quotes superseded, not mutated.**
- **New intent registered** in the enum, the classifier prompt, the handler map *and* the routing eval suite. The eval suite is the usual omission.
- **Prompt changes are new versioned files**, registry updated, old version retained.
- **Eval gate run and reported** if any model-facing code changed.
- **Migration reviewed by hand** — autogenerate omits RLS policies, partial indexes and check constraints.
- **No transcripts, names, phones or prices logged** above DEBUG.
- **An ADR written** if the change settles a question someone could reasonably decide differently — especially where a plausible option was rejected.
- **Errors return 200 from the webhook.** A non-200 makes Meta retry, and a retry on a bug is a retry loop.

## Questions that surface the silent problems

These catch what a checklist cannot. Ask them of any non-trivial change:

1. **What happens if this runs twice?** Retries are the normal operating mode, not an exception. If the answer is "a second message" or "a double charge", the change is not finished.
2. **What happens if this crashes halfway?** Specifically between a commit and an external call, and between an external call and its commit.
3. **Which tenant's data does this touch, and how is that enforced?** "The query filters on it" is the second line of defence, not the first.
4. **If a user says the output is wrong, how do we find out why?** A `trace_id` reaching every log line and event, or the answer is a debugging session with no evidence.
5. **What is the degraded behaviour?** Every external dependency will be unavailable at some point. Failing the quote is rarely the right answer; the voice note is safe in object storage and the user can be told honestly.
6. **Does this add a message the user did not need?** Each one costs money and quality rating, and quality rating is what gets numbers suspended.
7. **What happens when a deploy kills this mid-flight?** Workers get `SIGTERM` several times a week. In-flight jobs are cancelled and redelivered — safe only if the handler is idempotent.
8. **Is this the only speculative abstraction?** The document seam is justified by a dated external mandate. Everything else speculative should still be refused.

## Writing the review

Lead with anything from the nine invariants — those block. Then the second pass. Then style, clearly marked as optional.

Be specific about consequence rather than citing a rule. "This dedupe key contains `uuid4()`, so a retry after a timeout sends the client a second PDF" lands; "violates I4" does not. The person reading needs to understand the failure well enough to check for it themselves next time.

If the change looks correct, say so plainly and note which invariants you verified, so the author knows what was actually checked rather than assuming everything was.
