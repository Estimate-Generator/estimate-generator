---
name: devis-error-handling
description: Handle failures correctly in the voice-to-quote project — the AppError taxonomy, which errors retry and which never do, deadline budgets and degradation, circuit breakers and provider failover, graceful shutdown, and user-facing French error copy. Use this whenever a task involves something going wrong: adding a try/except, deciding whether to retry, a provider being down or slow, a timeout, writing a message shown to a user after a failure, handling a webhook error, or anything phrased as "what if this fails", "handle the error", "add retry logic", or "it timed out". Retrying an ambiguous send delivers a duplicate PDF to a real client and a bare except swallows an invariant violation, so consult this before writing any error path.
---

# Error handling

Every deliberate failure in this system is an `AppError` subclass, and the class carries four decisions that would otherwise be made inconsistently in every service: retry or not, tell the user or not, alert or not, dead-letter or not.

A bare `Exception` escaping a service is itself a defect. It means the failure was not anticipated, so the handler pages someone — we do not know what state it left behind.

## Pick the class, not the behaviour

```python
raise AudioUnusable()          # not: raise ValueError("bad audio")
```

| Situation | Class | Retry | User told | Alert |
|---|---|---|---|---|
| Audio silent, corrupt, too long | `UserInputError` | no | yes | none |
| Nothing extractable from a valid transcript | `NothingExtracted` | no | yes | none |
| Provider 5xx, timeout, rate limit | `TransientError` | **yes** | only if it persists | none individually |
| **Send timed out, delivery unknown** | `AmbiguousOutcome` | **never** | no | investigate |
| Provider 4xx, malformed request | `PermanentProviderError` | no | sometimes | investigate |
| Template rejected by Meta | `TemplateRejected` | no | no | **page** |
| Illegal transition, RLS violation, pricing invariant | `IntegrityError` | **never** | no | **page** |
| Tenant over cost cap | `BudgetExceeded` | no | yes | investigate |

Two rows deserve attention because they invert the instinct.

**`AmbiguousOutcome` is not retryable.** A send that timed out may have been delivered. Retrying puts a second quote in a client's WhatsApp, which is a commercial incident. Mark it, wait 60 s for a status callback carrying a matching `wamid`, then escalate to a human. A delayed quote is an annoyance; a duplicate is not recoverable.

**`IntegrityError` is never retryable.** Something impossible happened. Retrying a broken invariant just breaks it repeatedly, and the retries destroy the evidence of what went wrong first.

## Never catch broadly

```python
# wrong — swallows IntegrityError, which must page someone
try:
    await do_the_thing()
except Exception:
    log.error("failed")
    return None

# right — the generic handler classifies, alerts and disposes
await do_the_thing()          # let it propagate
```

The generic handler in `handle_job_error()` reads the class and acts. Catching locally to log and continue is how an invariant violation becomes a silent data problem discovered weeks later.

Catch narrowly only to *translate* an external exception into the taxonomy, which belongs in the adapter, not the service:

```python
# in app/adapters/messaging/meta_cloud.py
except httpx.TimeoutException as e:
    raise AmbiguousOutcome("send timed out") from e
except httpx.HTTPStatusError as e:
    raise classify_meta_error(e.response) from e
```

Adapters are the boundary. Nothing above them should ever see an `httpx` exception — that leak is what makes services couple to a provider.

## Deadlines: degrade, do not fail

The pipeline has a ~34 s budget against a 45 s target. Exceeding it is a signal to do less, not to give up:

```python
if dl.remaining > 20:
    tasks.append(multimodal.extract_numerics(wav))   # path B
else:
    ctx.degraded.add("path_b")     # threshold rises to 0.85, asks more questions
```

Pass the `Deadline` to every adapter as its client timeout. An adapter using its own fixed timeout is what breaks the budget, because the budget then describes nothing.

Record what degraded on `documents.degraded_modes`. Without it, a quality dip during a slow period looks like a model regression and the investigation starts in the wrong place.

## Retry schedules come from cost, retryability from the class

| Operation | Attempts | Backoff |
|---|---|---|
| Media fetch | 3 | 1s, 2s, 4s |
| ASR | 2 | 2s, 8s |
| LLM extraction | 2 | 1s, 4s |
| Embedding | 3 | 0.5s, 1s, 2s |
| Render | 2 | 1s, 3s (second at concurrency 1) |
| **Outbound send** | **0** | ambiguity risk |
| DB write | 3 | 0.1s, 0.3s, 1s |

Full jitter — `sleep(random.uniform(0, base * 2**attempt))`. Fixed backoff synchronises every client to retry at the same instant when a provider recovers, which knocks it over again.

## Circuit breakers trip on transient failures only

A stream of 400s means our requests are malformed. Opening the circuit on those hides the bug. Only `TransientError` counts toward the failure ratio.

Breaker state lives in Redis, shared across replicas. A per-process breaker in a 20-replica deployment produces 20 independent opinions about whether a provider is up, which is worse than having none.

**Opening a circuit triggers failover, not failure.** For ASR, it moves to the next provider in the chain — and that failover must be logged and counted. Silent failover to a weaker Darija model degrades quality invisibly, which is exactly what the eval harness cannot see.

## User-facing copy lives in `app/copy/fr.py`

Never build a user message inline. The exception carries a `user_message_key`; the copy file owns the wording.

Three rules that matter more than the phrasing:

- **Never blame the user.** "Je n'arrive pas à lire ce message vocal", not "votre message est illisible".
- **Always say what happens next.** A message that only reports failure leaves the person unsure whether to re-send — which doubles their work and our cost.
- **Never expose internals.** No provider names, no error codes. A tradesperson cannot act on `ProviderUnavailable`.

## Shutdown is a failure mode too

Workers get `SIGTERM` on every deploy, several times a week. In-flight jobs are cancelled after the grace period and redelivered — safe only because handlers are idempotent. If you add a handler that is not idempotent, deploys start corrupting data, and it will look like a random bug.

Grace period must exceed the longest job: 60 s for `worker-ai`, whose pipeline runs ~34 s. A shorter grace means `SIGKILL` arrives mid-drain and the handler accomplishes nothing.

## Checklist

- A specific `AppError` subclass, never a bare `ValueError` or `Exception`
- External exceptions translated in the adapter, not the service
- No broad `except Exception` that logs and continues
- Timeouts derived from the deadline, not hardcoded
- Send timeouts raise `AmbiguousOutcome` and do not retry
- Degradation path defined and recorded, rather than failing outright
- User message via `user_message_key`, not built inline
- New failure mode added to the taxonomy table, and to the runbook if it needs a human
