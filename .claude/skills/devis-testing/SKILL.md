---
name: devis-testing
description: Write tests for the voice-to-quote project — injected clock and id generator for determinism, builders instead of fixtures, provider contract suites that keep fakes honest, fault injection for the idempotency and outbox guarantees, and which layer a given test belongs in. Use this whenever writing or fixing any test, adding a fixture, setting up test data, mocking a provider, or when asked "add a test for this", "why is this test flaky", "how do I test this", or after implementing a feature that needs coverage. Tests calling datetime.now() are flaky by construction and a fake provider that only succeeds leaves every error path untested, so consult this before writing test setup.
---

# Testing

Tests that are hard to write do not get written, and tests that are flaky get skipped. Most of this skill is about removing the friction rather than about assertions.

## Which layer

| Layer | What | Services | Budget |
|---|---|---|---|
| `unit/` | `app/domain/` — pricing, state machine, value objects, routing rules | none | < 5 s for ~400 tests |
| `integration/` | repositories, RLS, migrations, outbox | testcontainers: pg + redis | < 60 s |
| `e2e/` | full pipeline on fake providers | fakes only | < 120 s |
| `contract/` | adapters against real providers | staging number, real keys | nightly only |
| `evals/` | model quality on the gate corpus | LLM API | see `devis-evals` |

The domain layer being pure (I2) is what makes 400 tests run in five seconds, and that speed is the entire return on the purity constraint — it is what makes people run them before pushing.

If a test needs a database to check a pricing rule, the logic is in the wrong layer. Move it into `domain/` rather than moving the test into `integration/`.

## Determinism: never call the clock directly

Half the system reasons about time — 24-hour windows, expiry, follow-up scheduling, `valid_until`. A test calling `datetime.now()` is flaky by construction and will be marked skip within a month.

```python
def test_clarification_expires_after_24h(clock, quote_in_clarification):
    clock.advance(hours=25)
    run_expiry_scan(clock)
    assert quote.state is QuoteState.EXPIRED
```

`Clock` is injected through the constructor like any other dependency (I7). `FrozenClock` in tests, `SystemClock` in production. The same applies to id generation — `SequentialIdGen` makes assertions readable and diffs stable.

Because of I9, add at least one test that crosses the **20 September 2026 Morocco offset change**, and one that checks `tzdata` is current. Date arithmetic that works in August and breaks in October is the kind of bug that ships.

## Builders, not fixtures

```python
quote = (DocumentBuilder()
         .for_tenant(tenant)
         .with_line("carrelage", qty=Quantity(20, Unit.M2), price=Money("180.00"))
         .with_line("fenêtre alu", qty=Quantity(3, Unit.U), price=Money("1200.00"))
         .in_state(QuoteState.PRICED)
         .build())
```

A shared pytest fixture forces every test to accept the same shape, so tests either fight it or duplicate setup. A builder lets each test state only what it cares about, which is also the line a reader is looking for.

Build value objects, not primitives — a builder taking `price="180.00"` and constructing a bare `Decimal` quietly reintroduces the bug I6 exists to prevent.

## Provider contract tests keep the fakes honest

`FakeProvider` is used in every test; the real one runs in production. **Nothing otherwise keeps them consistent**, and when they drift the tests pass and production breaks.

```python
class MessagingProviderContract:
    """Subclassed per implementation. The fake must reproduce every
    behaviour the real one exhibits — including the failures."""
    provider: MessagingProvider

    async def test_send_text_returns_wamid(self): ...
    async def test_invalid_number_raises_InvalidRecipient(self): ...
    async def test_outside_window_raises_OutsideWindow(self): ...
    async def test_unknown_media_raises_MediaNotFound(self): ...
    async def test_timeout_raises_AmbiguousOutcome(self): ...

class TestFakeMessaging(MessagingProviderContract):
    provider = FakeMessaging()

@pytest.mark.nightly
class TestMetaMessaging(MessagingProviderContract):
    provider = MetaCloudProvider(settings.staging)
```

The fake must reproduce the **error taxonomy**, not just the success path. A fake that only ever succeeds means every error path in the system is untested — which is exactly where the bugs are.

Write a contract suite for each Protocol: messaging, ASR, LLM, storage.

## Fault injection for the guarantees that only fail on crash

The outbox and idempotency guarantees are unfalsifiable by normal tests, because normal tests do not crash halfway.

```python
async def test_crash_between_commit_and_dispatch_is_recovered(app, faults):
    faults.crash_after("outbox.insert")
    with pytest.raises(SimulatedCrash):
        await app.receive_webhook(payload)

    assert await count_dispatched() == 0     # nothing went out
    await app.run_sweeper()                  # the safety net
    assert await count_dispatched() == 1     # exactly one
```

Three crash points, one per guarantee. These are the highest-value tests in the suite because they cover the two failures the product cannot survive:

| Crash point | Guarantee | Expected |
|---|---|---|
| after inbound insert, before outbox | no lost message | sweeper recovers it |
| after provider send, before `mark_sent` | no duplicate | dedupe key blocks the second |
| mid-transition | no double advance | optimistic guard rejects |

## Property tests where the invariant is general

Pricing (order independence, `total_ttc` reconciliation), unit conversion, and `apply_delta` on revisions. Use `hypothesis` and constrain the strategies to realistic ranges — a property test over the full `Decimal` space finds arithmetic edge cases nobody will ever hit and hides the ones they will.

Property tests confirm internal consistency. **Golden cases confirm the convention is right**, and they matter more — see `devis-pricing`. Never regenerate a golden file from code output; it becomes an assertion that the code equals itself.

## Testing async code

- `pytest-asyncio` in strict mode, so a forgotten `async` marker fails rather than silently skipping.
- Never `asyncio.sleep()` to wait for something. Poll a condition with a timeout, or expose a hook.
- Assert that blocking calls are absent (I8) — enable `loop.set_debug(True)` with `slow_callback_duration = 0.2` in the e2e suite and fail on a slow-callback warning.

## What not to test

- Adapter internals beyond the contract suite. Testing that `httpx` was called with certain arguments asserts the implementation, not the behaviour, and breaks on every refactor.
- Third-party libraries.
- Getters, dataclass construction, `__repr__`.

Coverage is 80% as a floor, not a target. The domain layer should be near 100%; adapters are covered by contract tests; the last 15% of a gateway is usually error paths already covered by the taxonomy.

## Checklist

- Correct layer, and the logic is not in the wrong one
- Clock and ids injected, never called directly
- Builders for setup, value objects not primitives
- New Protocol implementation added to its contract suite
- Fake reproduces the error taxonomy, not only success
- New guarantee has a fault-injection test
- No `asyncio.sleep` used as synchronisation
