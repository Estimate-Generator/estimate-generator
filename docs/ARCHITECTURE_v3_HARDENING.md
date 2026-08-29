# Architecture v3 — Reliability, performance and extensibility hardening

**Status:** v3.0 · **Date:** 28 August 2026
**Relationship to v2:** additive. These sections slot into `TECHNICAL_ARCHITECTURE_v2.md` at the numbers indicated. §A also corrects three things v2 got wrong.

---

## Why this pass exists

v2 specifies the happy path precisely and the failure paths vaguely. It says "circuit breaker" once without defining one. It says "retry" without saying which errors are retryable. It never says what happens to an in-flight quote when a deploy kills the worker — which is a thing that will happen several times a week.

The result is that every service will invent its own error handling, and they will disagree. That divergence is the most expensive kind of technical debt, because it is invisible until an incident and then it is everywhere at once.

Six additions, in dependency order:

| § | Addition | Fixes |
|---|---|---|
| B | Error taxonomy | Every service inventing its own failure semantics |
| C | Deadline budget | One slow provider blowing the whole latency SLA |
| D | Retry policy and circuit breakers | Blind retries; unspecified breaker behaviour |
| E | Graceful shutdown | Deploys killing in-flight quotes |
| F | Performance: pools, batching, N+1 | Connection exhaustion at 20 AI workers |
| G | The document seam | Invoicing requiring a rewrite rather than an extension |
| H | Test infrastructure | Non-deterministic tests, fake/real provider drift |
| I | Decision records | No written reason for anything six months from now |

---

## §A — Corrections to v2

Three things worth removing or changing before adding anything.

### A.1 Remove `shadow` automation mode

v2 defines three modes: `shadow`, `copilot`, `auto`. `shadow` (process, show nobody) has no user and no exit criterion. `copilot` already gives the safety it was meant to provide, with the benefit of a human actually looking at the output.

```sql
ALTER TABLE tenants DROP CONSTRAINT tenants_automation_mode_check;
ALTER TABLE tenants ADD CONSTRAINT tenants_automation_mode_check
    CHECK (automation_mode IN ('copilot','auto'));
```

Every unused state is a branch that must be reasoned about forever.

### A.2 `orphan_statuses` should not be a table

v2 parks unmatched status callbacks in a table and replays after 30 s. This is a 30-second buffer with a natural TTL — Redis is the correct home, and it avoids a table that grows forever if the replay ever silently stops working.

```python
await redis.setex(f"orphan_status:{wamid}", 300, json.dumps(status))
```

### A.3 `intent_decisions.corrected_to` is currently dead weight

v2 adds the column and describes it as the router's training signal, but specifies no interface for anyone to set it. A column nobody can write is documentation pretending to be a feature.

Either build the correction path (one line in the operator tooling, D9 in v2's open decisions) or drop the column until the tooling exists. **Recommendation:** keep the column, and add setting it to the D9 scope, because the operator is already looking at the misrouted message when they fix it manually.

---

## §B — Error taxonomy

*Insert as §8.7, and referenced everywhere.*

This is the highest-value addition in v3. One hierarchy drives four decisions that are currently made ad hoc in each service: retry or not, tell the user or not, alert or not, dead-letter or not.

### B.1 The hierarchy

```python
# app/domain/errors.py  — pure, no I/O
from dataclasses import dataclass
from typing import Literal

AlertLevel = Literal["none", "investigate", "page"]

class AppError(Exception):
    """Base. Every deliberate failure in the system is one of these.
    A bare Exception escaping a service is itself a defect."""
    retryable: bool = False
    user_message_key: str | None = None   # key into app/copy/fr.py
    alert: AlertLevel = "investigate"
    dead_letter: bool = True

# ── The user did something the system cannot work with ────────────────
class UserInputError(AppError):
    """Not a system failure. Tell the person, do not retry, do not alert."""
    retryable = False
    alert = "none"
    dead_letter = False

class AudioUnusable(UserInputError):
    user_message_key = "audio_unusable"

class AudioTooLong(UserInputError):
    user_message_key = "audio_too_long"

class UnsupportedMessageType(UserInputError):
    user_message_key = "unsupported_type"

class NothingExtracted(UserInputError):
    user_message_key = "nothing_understood"

# ── The world is temporarily unavailable ──────────────────────────────
class TransientError(AppError):
    """Retry. Do not tell the user unless it persists past the deadline."""
    retryable = True
    alert = "none"          # individual occurrences are noise
    dead_letter = True      # after the retry budget is exhausted

class ProviderUnavailable(TransientError): ...
class ProviderRateLimited(TransientError): ...
class DeadlineExceeded(TransientError):
    user_message_key = "taking_longer"

# ── We do not know whether it worked ──────────────────────────────────
class AmbiguousOutcome(AppError):
    """The critical class. A send timed out; Meta may have delivered it.
    Retrying risks a duplicate document in a client's WhatsApp."""
    retryable = False       # ← deliberately NOT retryable
    alert = "investigate"
    dead_letter = False     # goes to the escalation queue, not the DLQ

# ── The request was wrong and will be wrong again ─────────────────────
class PermanentProviderError(AppError):
    retryable = False
    alert = "investigate"

class InvalidRecipient(PermanentProviderError):
    user_message_key = "invalid_number"

class TemplateRejected(PermanentProviderError):
    alert = "page"          # a rejected template blocks a whole flow

# ── An invariant is broken ────────────────────────────────────────────
class IntegrityError(AppError):
    """Something that should be impossible happened. Never retry —
    retrying a broken invariant just breaks it repeatedly."""
    retryable = False
    alert = "page"

class IllegalTransition(IntegrityError): ...
class TenantScopeViolation(IntegrityError): ...
class PricingInvariantViolation(IntegrityError): ...

# ── Cost control ──────────────────────────────────────────────────────
class BudgetExceeded(AppError):
    retryable = False
    alert = "investigate"
    user_message_key = "budget_reached"
```

### B.2 One handler, driven by the taxonomy

Because the classification lives on the exception, the handler is generic and there is exactly one of it:

```python
async def handle_job_error(exc: BaseException, ctx: JobContext) -> Disposition:
    if not isinstance(exc, AppError):
        # An undeclared failure. Treat as integrity: we do not know what
        # state it left behind, so a human looks at it.
        log.exception("unclassified_error", job=ctx.job_name)
        await alert("page", f"unclassified {type(exc).__name__}", ctx)
        return Disposition.DEAD_LETTER

    log.warning("job_error", error=type(exc).__name__, retryable=exc.retryable,
                attempt=ctx.attempt, quote_id=ctx.quote_id)

    if exc.alert != "none":
        await alert(exc.alert, str(exc), ctx)

    if exc.user_message_key and ctx.can_reply:
        await send_copy(ctx, exc.user_message_key)

    if exc.retryable and ctx.attempt < retry_budget(exc):
        return Disposition.RETRY
    if isinstance(exc, AmbiguousOutcome):
        return Disposition.ESCALATE
    return Disposition.DEAD_LETTER if exc.dead_letter else Disposition.DROP
```

The value is not the code, it is that **adding a new failure mode means adding a class, not editing a handler**. The decision table cannot drift out of sync with the behaviour because it *is* the behaviour.

### B.3 User-facing copy in one place

```python
# app/copy/fr.py
MESSAGES = {
  "audio_unusable":    "Je n'arrive pas à lire ce message vocal. "
                       "Pouvez-vous le renvoyer ?",
  "audio_too_long":    "Le message est un peu long pour moi. "
                       "Un vocal de moins de 3 minutes fonctionne mieux.",
  "nothing_understood":"Je n'ai pas réussi à identifier les articles. "
                       "Pouvez-vous redire la prestation et la quantité ?",
  "taking_longer":     "Ça prend plus de temps que prévu. "
                       "Je vous envoie le devis dès qu'il est prêt.",
  "invalid_number":    "Le numéro de ce client ne semble pas valide.",
  "budget_reached":    "Vous avez atteint la limite de votre formule. "
                       "Écrivez-moi pour l'augmenter.",
  "system_problem":    "J'ai un problème technique de mon côté. "
                       "Votre message est bien enregistré, "
                       "je vous envoie le devis dès que c'est réglé.",
}
```

Three rules for this file, and they matter more than the wording:

- **Never blame the user.** "Je n'arrive pas à lire", not "votre message est illisible".
- **Always say what happens next.** A message that only reports a failure leaves the person unsure whether to re-send, which produces duplicate work for them and duplicate cost for us.
- **Never expose internals.** No provider names, no error codes, no stack traces. The tradesperson cannot act on `ProviderUnavailable`.

Keeping copy out of the exception classes is what allows a non-engineer to improve the wording, and lets a second locale be added without touching `domain/`.

---

## §C — Deadline budget

*Insert as §7.1.*

v2 states a 45 s p95 target and then never enforces it. Without a budget, one slow ASR call consumes the entire allowance and the user re-sends, doubling the cost of an already-slow request.

### C.1 The budget

| Step | Budget | Notes |
|---|---|---|
| Webhook ACK | 100 ms | hard; Meta is waiting |
| Outbox dispatch | 500 ms | poller interval |
| Media fetch + transcode | 3 s | two HTTP calls plus ffmpeg |
| ASR | 12 s | dominant cost; the thing to watch |
| Extraction | 8 s | runs after ASR |
| Path B (numerics) | 8 s | **parallel** with ASR+extraction, so free in wall-clock |
| Matching | 2 s | batched (§F.3) |
| Pricing | 100 ms | pure computation |
| Render | 5 s | pooled browser |
| Send | 3 s | |
| **Sum** | **~34 s** | leaving ~11 s of slack against the 45 s target |

The slack is deliberate. A budget with no slack is a budget that is always exceeded.

### C.2 Deadline object, propagated

```python
@dataclass(frozen=True)
class Deadline:
    at: float                      # monotonic clock

    @classmethod
    def in_seconds(cls, s: float) -> "Deadline":
        return cls(time.monotonic() + s)

    @property
    def remaining(self) -> float:
        return max(0.0, self.at - time.monotonic())

    def check(self, step: str) -> None:
        if self.remaining <= 0:
            raise DeadlineExceeded(f"budget exhausted before {step}")

    def budget_for(self, step: str, nominal: float) -> float:
        """Never give a step more than what is left, minus a reserve for
        the steps after it."""
        return min(nominal, max(0.5, self.remaining - RESERVE[step]))
```

The deadline is created at job start, stored on the job payload, and passed to every adapter as the client timeout. An adapter that ignores it and uses its own fixed timeout is the thing that breaks the budget.

### C.3 Degrade, do not fail

Exceeding the budget is not an error condition — it is a signal to do less:

```python
async def extract_with_verification(wav, ctx, dl: Deadline):
    tasks = [transcribe_cached(wav, ctx.asr_provider, timeout=dl.budget_for("asr", 12))]
    if dl.remaining > 20:                     # only if there is room
        tasks.append(multimodal.extract_numerics(wav))
    else:
        log.info("degraded.skip_path_b", remaining=dl.remaining)
        ctx.degraded.add("path_b")            # recorded on the quote
    ...
```

With path B skipped, the confidence threshold rises to 0.85 (v2 §10.4), so the system asks more questions instead of sending unverified numbers. Slower and more cautious beats fast and wrong.

`quotes.degraded_modes JSONB` records which degradations applied. Without it, a quality dip during a slow period looks like a model regression, and you go looking in the wrong place.

---

## §D — Retry policy and circuit breakers

*Insert as §8.7 alongside the taxonomy.*

### D.1 Retry budgets

Retryability comes from the taxonomy; the *schedule* comes from cost:

| Operation | Attempts | Backoff | Why |
|---|---|---|---|
| Media fetch | 3 | 1s, 2s, 4s + jitter | cheap, usually transient |
| ASR | 2 | 2s, 8s | expensive; a third try rarely differs |
| LLM extraction | 2 | 1s, 4s | expensive |
| Embedding | 3 | 0.5s, 1s, 2s | very cheap |
| Render | 2 | 1s, 3s | second attempt at concurrency 1 |
| Outbound send | **0** | — | ambiguity risk (§B, `AmbiguousOutcome`) |
| DB write | 3 | 0.1s, 0.3s, 1s | serialisation failures are normal |

Full jitter, not fixed backoff: `sleep(random.uniform(0, base * 2**attempt))`. Synchronised retries after a provider recovers produce a thundering herd that knocks it over again.

### D.2 Poison message detection

A job that fails the same way repeatedly consumes worker capacity that healthy jobs need. v2 mentions dead-lettering after three failures but does not detect the *pattern*.

```python
async def check_poison(job_key: str, error_type: str) -> None:
    k = f"poison:{job_key}:{error_type}"
    n = await redis.incr(k)
    await redis.expire(k, 3600)
    if n >= 5:
        raise PoisonJob(f"{job_key} failed {n}× with {error_type}")
```

Straight to the dead letter queue, no further attempts, one alert. The signal is not "this job is broken" but "something systematic is broken" — five identical failures in an hour is a code path, not bad luck.

### D.3 Circuit breaker, specified

v2 says each external dependency "gets a circuit breaker" and stops there. Specifying it:

```python
@dataclass
class BreakerConfig:
    window_s: int = 60
    min_calls: int = 20        # below this, one bad call is not a signal
    failure_ratio: float = 0.5
    open_s: int = 30
    half_open_probes: int = 3

class CircuitBreaker:
    """State in Redis, shared across replicas. A per-process breaker in a
    20-replica deployment means 20 independent opinions about whether a
    provider is up, which is worse than none."""

    async def call(self, fn, *args, **kw):
        state = await self._state()
        if state is State.OPEN:
            raise ProviderUnavailable(f"{self.name} circuit open")
        if state is State.HALF_OPEN and not await self._take_probe():
            raise ProviderUnavailable(f"{self.name} probing")
        try:
            result = await fn(*args, **kw)
        except TransientError:
            await self._record_failure()
            raise
        except PermanentProviderError:
            raise                      # a 400 is not evidence the provider is down
        await self._record_success()
        return result
```

Two details that are wrong in most implementations:

**Only transient failures trip the breaker.** A stream of 400s means *our* requests are malformed. Opening the circuit hides the bug and delays the fix.

**Opening the circuit triggers failover, not failure.** For ASR, `ProviderUnavailable` moves to the next provider in the chain. The breaker is a routing signal first and an error second.

### D.4 Failover chain

```python
ASR_CHAIN = ["moulsot_v03", "whisper_darija_lora", "commercial_api"]

async def transcribe_with_failover(wav, dl: Deadline) -> Transcript:
    last: Exception | None = None
    for name in ASR_CHAIN:
        dl.check(f"asr:{name}")
        try:
            t = await breakers[name].call(providers[name].transcribe, wav)
            if name != ASR_CHAIN[0]:
                log.warning("asr.failover_used", provider=name)
                metrics.incr("asr.failover", provider=name)
            return t
        except (ProviderUnavailable, ProviderRateLimited) as e:
            last = e
    raise ProviderUnavailable("all ASR providers unavailable") from last
```

**Failover must be loud.** Silent failover to a weaker Darija model degrades quality invisibly, which is exactly the failure the eval harness exists to catch and cannot see if nobody knows it happened. `quotes.asr_provider` already records which one ran — the metric makes it visible in aggregate.

---

## §E — Graceful shutdown

*Insert as §23.5.*

v2 never mentions this, and deploys happen several times a week. Without it, every deploy kills quotes mid-flight.

### E.1 The failure

A worker receives `SIGTERM` 8 seconds into a 34-second pipeline. Default behaviour: the process dies, the ASR call is abandoned, the job is neither completed nor returned to the queue. The user waits for a document that never arrives.

### E.2 Handling

```python
class GracefulWorker:
    def __init__(self):
        self._draining = asyncio.Event()
        self._in_flight: set[asyncio.Task] = set()

    def install(self):
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, self._begin_drain)

    def _begin_drain(self):
        log.info("shutdown.draining", in_flight=len(self._in_flight))
        self._draining.set()          # stop claiming new jobs

    async def run(self):
        while not self._draining.is_set():
            job = await self.queue.claim(timeout=1.0)
            if job:
                t = asyncio.create_task(self.process(job))
                self._in_flight.add(t)
                t.add_done_callback(self._in_flight.discard)

        if self._in_flight:
            log.info("shutdown.waiting", n=len(self._in_flight))
            done, pending = await asyncio.wait(self._in_flight, timeout=GRACE_S)
            for t in pending:
                t.cancel()            # the queue will redeliver; handlers are idempotent
            log.warning("shutdown.cancelled", n=len(pending))
```

### E.3 The configuration detail that gets this wrong

The platform's termination grace period **must exceed the longest job**, or the orchestrator sends `SIGKILL` while draining is still in progress and the handler achieves nothing.

| Role | Longest job | Grace period |
|---|---|---|
| `gateway` | 100 ms | 15 s (connection drain) |
| `worker-ai` | ~34 s | **60 s** |
| `worker-render` | ~5 s | 30 s |
| `worker-outbound` | ~3 s | 30 s |
| `outbox-poller` | ~500 ms | 15 s |

A cancelled job is safe because delivery is at-least-once and every handler is idempotent (v2 §8.3). That property, established for retries, is what makes deploys non-destructive — which is a good illustration of why it was worth establishing.

### E.4 Singleton lease release

The outbox poller and scheduler hold Redis leases. Release on shutdown rather than waiting for TTL expiry, or the system runs without a poller for up to 30 seconds after every deploy:

```python
async def _begin_drain(self):
    await redis.delete(f"lease:{self.name}")
```

---

## §F — Performance

*Insert as §23.6.*

### F.1 Connection pool arithmetic — the real first bottleneck

This is the ceiling nobody calculates until it is hit. With v2's replica counts:

| Role | Replicas | Pool | Total |
|---|---|---|---|
| gateway | 2 | 10 | 20 |
| worker-router | 2 | 5 | 10 |
| worker-ai | **20** | 5 | **100** |
| worker-render | 2 | 3 | 6 |
| worker-outbound | 2 | 5 | 10 |
| outbox-poller | 1 | 2 | 2 |
| **Total** | | | **148** |

PostgreSQL's default `max_connections` is 100, and managed instances at this tier often cap around 100–200. **The system exhausts connections before it exhausts CPU**, and the symptom — timeouts under load — looks like a slow database rather than a configuration limit.

Two fixes, and use both:

**pgbouncer in transaction mode**, which multiplexes 148 client connections onto ~25 server ones. Two things must be true for this to work, and both already are:

- The RLS approach uses `SET LOCAL`, which is transaction-scoped. Session-scoped `SET` would break under transaction pooling. This was the right choice for a different reason and pays off again here.
- asyncpg must disable prepared statement caching (`statement_cache_size=0`), or it will reuse statements across different server connections.

**Right-size the pools.** AI workers spend most of their time waiting on HTTP, not holding a transaction. A pool of 2 is enough:

```python
POOL_SIZE = {"gateway": 10, "router": 3, "ai": 2, "render": 2,
             "outbound": 3, "outbox": 2}
# → 20 + 6 + 40 + 4 + 6 + 2 = 78, under the cap even without pgbouncer
```

Rule of thumb: pool size should reflect *concurrent transactions*, not concurrent tasks. A worker that awaits a 12-second ASR call while holding a connection is the anti-pattern, and it is easy to write by accident.

### F.2 Never hold a transaction across an await on I/O

Same rule as v2's I5, restated as a performance concern rather than a correctness one. Fetch, release, call, re-acquire:

```python
async with tenant_session(engine, tid) as s:      # short
    quote = await load_quote(s, qid)
transcript = await asr.transcribe(wav)            # long, no connection held
async with tenant_session(engine, tid) as s:      # short
    await save_transcript(s, qid, transcript)
```

### F.3 Batch the matching — the one real N+1

v2's matching cascade runs per line. A 12-line quote produces 12 embedding calls and 12 vector queries.

```python
async def match_lines(session, tenant_id, lines) -> list[MatchResult]:
    # 1 · exact aliases in one query
    normalised = [normalize(l.raw_text) for l in lines]
    aliases = await find_aliases_bulk(session, tenant_id, normalised)

    # 2 · one embedding call for everything still unmatched
    todo = [n for n in normalised if n not in aliases]
    embeddings = await embed_batch(todo) if todo else {}

    # 3 · one vector query using UNNEST, not N queries
    hits = await vector_search_bulk(session, tenant_id, embeddings)
    ...
```

Roughly 24 round trips become 3. On a 12-line quote this is the difference between ~2 s and ~200 ms, and the embedding API call is billed once instead of twelve times — so it improves both the latency budget and the margin.

### F.4 The render browser pool

v2 says "one browser per worker". Make it explicit, because a leaked page is a slow memory leak that looks like a gradual OOM:

```python
class BrowserPool:
    async def acquire(self) -> Page:
        async with self._sem:                  # concurrency 2
            page = await self._pages.get() if not self._pages.empty() \
                   else await self._browser.new_page()
            return page

    async def release(self, page: Page) -> None:
        if self._uses[page] > 50:              # recycle periodically
            await page.close()
        else:
            await page.goto("about:blank")     # drop the previous document
            await self._pages.put(page)
```

Recycle after 50 renders. Chromium accumulates memory across page loads, and a pool that never recycles reaches OOM in hours rather than never.

### F.5 What is worth measuring

Per-step histograms, not just end-to-end. An end-to-end p95 tells you the system is slow; per-step tells you which provider changed.

```python
with metrics.timer("pipeline.step", step="asr", provider=name):
    ...
```

Track the **budget consumption ratio** — actual over allocated per step. A step consistently at 0.9 is about to start failing; a step at 0.2 is over-allocated and its budget can be given to a step that needs it.

---

## §G — The document seam

*Insert as §6.5.*

v2 says invoicing is a non-goal but that the schema should "leave room". It never says how, which means in practice no room is left.

Invoicing is coming — the Moroccan e-invoicing mandate reaches this customer segment in January 2027. The cost of preparing now is one abstraction; the cost of not preparing is a rewrite of the state machine, numbering, rendering and lifecycle.

### G.1 What actually differs between a devis and a facture

| | Devis | Facture |
|---|---|---|
| Numbering | gaps allowed | **gapless, legally required** |
| Mutability | revisable | immutable once issued; corrected by avoir |
| Lifecycle | sent → outcome | issued → cleared → paid |
| Format | PDF | **structured XML (UBL 2.1), PDF is not sufficient** |
| Validation | none | DGI clearance before it is legally valid |
| Signature | none | qualified or advanced electronic signature |

That is a substantial difference — but it is a difference in *policy*, not in structure. Both are a tenant, a client, priced lines, totals and a lifecycle.

### G.2 The seam: a policy protocol, not a subclass

```python
# app/domain/documents.py — pure
class DocumentSpec(Protocol):
    kind: str                                   # 'devis' | 'facture' | 'avoir'
    template: str
    requires_gapless_numbering: bool
    is_mutable_after_issue: bool
    required_tenant_fields: frozenset[str]      # ICE, RC, IF for factures
    lifecycle: dict[State, set[State]]

    def next_number(self, ctx: NumberingContext) -> str: ...
    def validate_before_issue(self, doc: PricedDocument) -> list[str]: ...
```

`quotes` becomes `documents` with a `kind` column (one migration, done now while the table is small). The state machine takes its transition table from `spec.lifecycle` instead of a module-level constant. Pricing, matching, extraction, messaging and the conversation layer are unchanged — they already work on lines and totals, not on quote-ness.

### G.3 What to do now versus later

**Now** (roughly a day, while the table has hundreds of rows):

- Rename `quotes` → `documents`, add `kind TEXT NOT NULL DEFAULT 'devis'`.
- Move `TRANSITIONS` behind `DevisSpec.lifecycle`.
- Move numbering behind `spec.next_number()`.

**Later, when invoicing is actually built:** `FactureSpec`, the XML serialiser, the DGI adapter, the signature chain. None of it touches the pipeline.

The judgment call: this is the *only* speculative abstraction in the whole architecture, and it is justified because the requirement is dated, external, and not optional. Everything else speculative should still be refused.

---

## §H — Test infrastructure

*Insert as §18.4.*

v2 lists test directories and a coverage threshold. Neither makes tests easy to write, and tests that are hard to write do not get written.

### H.1 Determinism: inject the clock and the id generator

Half the system reasons about time — 24-hour windows, expiry, follow-up scheduling. Tests that call `datetime.now()` are flaky by construction and will be marked skip within a month.

```python
class Clock(Protocol):
    def now(self) -> datetime: ...
    def monotonic(self) -> float: ...

class FrozenClock:
    def __init__(self, at: datetime): self._at = at
    def now(self): return self._at
    def advance(self, **kw): self._at += timedelta(**kw)
```

```python
def test_clarification_expires_after_24h(clock, quote_in_clarification):
    clock.advance(hours=25)
    run_expiry_scan(clock)
    assert quote.state is QuoteState.EXPIRED
```

Same for ids: a `SequentialIdGen` in tests makes assertions readable and diffs stable.

### H.2 Builders, not fixtures

```python
quote = (QuoteBuilder()
         .for_tenant(tenant)
         .with_line("carrelage", qty=20, unit="m2", price="180.00")
         .with_line("fenêtre alu", qty=3, unit="u", price="1200.00")
         .in_state(QuoteState.PRICED)
         .build())
```

Every test that needs a two-line priced quote otherwise writes fifteen lines of setup, and the important part of the test — the one line that differs — gets lost in it.

### H.3 Provider contract tests — the drift problem

`FakeProvider` is used in every test. The real provider is used in production. **Nothing currently keeps them consistent**, and when they drift, the tests pass and production breaks.

One suite, run against both:

```python
class MessagingProviderContract:
    """Subclassed once per implementation. The fake must satisfy every
    behaviour the real one exhibits, including the failure modes."""

    provider: MessagingProvider

    async def test_send_text_returns_wamid(self): ...
    async def test_send_to_invalid_number_raises_InvalidRecipient(self): ...
    async def test_send_outside_window_raises_OutsideWindow(self): ...
    async def test_fetch_unknown_media_raises_MediaNotFound(self): ...
    async def test_timeout_raises_AmbiguousOutcome(self): ...

class TestFakeProvider(MessagingProviderContract):
    provider = FakeProvider()

@pytest.mark.nightly          # real test number, not in the PR gate
class TestMetaProvider(MessagingProviderContract):
    provider = MetaCloudProvider(settings.staging)
```

The fake must reproduce the **error taxonomy**, not just the success path. A fake that only ever succeeds means every error path in the system is untested, which is precisely where the bugs are.

### H.4 Fault injection for the guarantees that only fail on crash

The outbox and idempotency guarantees are unfalsifiable by normal tests, because normal tests do not crash halfway.

```python
async def test_crash_between_commit_and_dispatch_is_recovered(app, faults):
    faults.crash_after("outbox.insert")
    with pytest.raises(SimulatedCrash):
        await app.receive_webhook(payload)

    assert await count_dispatched() == 0        # nothing went out
    await app.run_sweeper()                     # the safety net
    assert await count_dispatched() == 1        # exactly one
```

Three crash points worth testing explicitly, one per guarantee:

| Crash point | Guarantee | Expected |
|---|---|---|
| after inbound insert, before outbox | no lost message | sweeper recovers it |
| after provider send, before `mark_sent` | no duplicate | dedupe key blocks the second |
| mid-transition | no double advance | optimistic guard rejects |

### H.5 The test pyramid, with a real target

| Layer | Count | Runtime | Runs |
|---|---|---|---|
| `unit/` (domain) | ~400 | < 5 s | every save |
| `integration/` (db, redis) | ~80 | < 60 s | every PR |
| `e2e/` (fake providers) | ~15 | < 120 s | every PR |
| `contract/` (real providers) | ~10 | < 300 s | nightly |
| `evals/` (gate split) | ~60 | < 300 s | every PR |

The domain layer being pure (v2 I2) is what makes 400 tests run in under five seconds. That speed is the whole return on the purity constraint — it is what makes people actually run them.

---

## §I — Decision records

*Insert as §28.*

The v1→v2 changelog was written retrospectively and only because someone asked. Six months from now, "why is `outcome` a column and not a state" will be asked by someone who was not in the room.

`docs/adr/NNNN-title.md`, one page, written when the decision is made:

```markdown
# ADR 0007 — Outcome is a column, not a state

**Status:** accepted · **Date:** 2026-08-28

## Context
Quotes end as accepted, refused, or unanswered. The obvious modelling
is three terminal states on the quote state machine.

## Decision
`outcome` is a column on `documents`, not a state.

## Rationale
Clients accept a quote and then ask for changes. As states, `accepted`
and `revising` would be mutually exclusive, which contradicts observed
behaviour. States answer "what is the system doing next"; columns answer
"what is true about this row".

## Consequences
- The follow-up scan queries `outcome IS NULL AND sent_at < …`, not a state.
- A quote can be accepted and superseded simultaneously, which is correct.
- Anyone looking for an `accepted` state will not find one — hence this record.
```

Backfill these fifteen from v2 and v3 while the reasoning is fresh — it will not survive another month:

modular monolith over microservices · arq over Celery · transactional outbox · LLM never touches money · dual-path numeric verification · RLS plus repository plus test · outcome as column · revisions as new rows · gapless numbering rejected for quotes · WER rejected as a gate metric · corpus split discipline · prompts outside the code · canary by tenant not traffic · `shadow` mode removed · document seam introduced early.

An ADR that records a **rejected** option is worth more than one that records the chosen one. The chosen path is visible in the code; the rejected path is what someone will otherwise propose again next quarter.

---

## §J — What this pass deliberately does not add

Stated so the next review does not re-litigate it:

- **Distributed tracing (OpenTelemetry).** `trace_id` plus Langfuse covers a single-service system. Revisit if a second service appears.
- **Feature flag service.** `tenants.automation_mode` and `prompt_channel` are the two flags that exist. Two columns beat a dependency.
- **Read replicas.** The write path is light and there is no analytics load yet. §23.2 already names this as the trigger.
- **Multi-region.** No requirement, and data residency (D6) is still open.
- **Event sourcing.** `quote_events` gives the audit trail without the cost of rebuilding state from a log.
- **A metrics backend beyond what the platform provides.** Postgres answers the business questions; the platform answers the system ones.

Each of these becomes correct at a scale this system is not at, and adding them now buys complexity against a problem that does not exist.

---

## Revised build sequence impact

These additions are not a new phase. They fold into the existing weeks:

| Week | Addition |
|---|---|
| 1–2 | Error taxonomy (§B) and copy file — before any service invents its own |
| 1–2 | Document seam (§G.3) — while the table is small |
| 3–4 | Clock and id injection, builders (§H.1–H.2) — before 400 tests exist |
| 5 | Deadline budget (§C), retry matrix and breakers (§D) |
| 5 | Fault injection tests (§H.4) — same week as the guarantees they verify |
| 6 | Graceful shutdown (§E), pool sizing (§F.1) — before real users |
| 6 | Provider contract suite (§H.3) |
| 7 | Batched matching (§F.3) — when quotes are long enough to notice |
| ongoing | ADRs written at decision time, not retrospectively |

The two with real deadlines are the error taxonomy and the document seam. Both get harder every week they are deferred: the taxonomy because each service that ships without it adds a divergent error path to unwind, the seam because the table only grows.
