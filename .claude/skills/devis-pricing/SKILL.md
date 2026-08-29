---
name: devis-pricing
description: Compute money correctly in the voice-to-quote project — the RC-1..RC-5 rounding convention, per-band VAT, proportional discount, Decimal arithmetic, revision repricing rules and golden test cases. Use this whenever a task touches a monetary value: totals, subtotals, VAT, discounts, line amounts, currency formatting, repricing a revision, or anything phrased as "calculate the total", "add a discount", "handle multiple VAT rates", or "the numbers are wrong". Computing VAT on a global total instead of per band produces centime errors that a client's accountant will find, so consult this before writing any arithmetic on a price.
---

# Pricing

This is the smallest module in the codebase and the one where a bug is most expensive. Everything lives in `app/domain/pricing.py`, which is pure — no I/O, no database, no model calls — precisely so it can be tested exhaustively and reasoned about completely.

## The rounding convention

These five rules are the specification. They are not derived from the code; the code implements them.

> **RC-1** — Line totals are rounded to the centime.
> **RC-2** — Discount is applied proportionally across VAT bands, on rounded line totals.
> **RC-3** — VAT is computed **per band** on the discounted band base, then rounded.
> **RC-4** — `total_ttc` is the sum of the rounded net and the rounded per-band VAT amounts.
> **RC-5** — Half-up rounding throughout (`ROUND_HALF_UP`), matching Moroccan commercial practice.

The two that get implemented wrong by default:

**VAT is per band, not global.** A quote mixing 20% and 14% lines cannot compute VAT once on the total. Compute a base per rate, apply VAT per rate, sum the results.

**Discount is proportional, applied before VAT.** A 10% discount on a mixed-rate quote reduces each band's base by the same ratio. Applying the discount after VAT, or entirely to one band, changes the total and is wrong.

Print the per-band breakdown on the document. It makes the arithmetic auditable by the client's accountant and removes the argument before it starts.

## Money is a value object, not a Decimal

```python
@dataclass(frozen=True, slots=True)
class Money:
    amount: Decimal
    currency: str = "MAD"

    def __post_init__(self):
        object.__setattr__(self, "amount",
                           self.amount.quantize(CENTS, rounding=ROUND_HALF_UP))
```

Rounding happens in `__post_init__`, so RC-1 and RC-5 are enforced by construction — an incorrectly rounded `Money` cannot exist, rather than depending on someone remembering to call `q2()`.

`Money * Money` is deliberately undefined; it is meaningless, and its absence catches a real class of mistake. `Money + Money` raises on a currency mismatch.

`Quantity` carries its unit for the same reason:

```python
line_a.quantity + line_b.quantity     # 20 m² + 3 u → IncompatibleUnits
quantity.price_at(rate, rate_unit)    # raises if the rate is per a different unit
```

Without this, both sides are `Decimal`, the type system is silent, and a plausible wrong total reaches a client. In a system whose worst failure is a wrong number on a document, that is the wrong place for silence.

Value objects live in `app/domain/values.py` and are pure. Adapters convert at the boundary — the database stores `NUMERIC` and `TEXT`, and SQLAlchemy type decorators map to and from `Money` and `Quantity`. Primitives at the edges, value objects inside.

## Decimal underneath

```python
from decimal import Decimal, ROUND_HALF_UP
CENTS = Decimal("0.01")

def q2(x: Decimal) -> Decimal:
    return x.quantize(CENTS, rounding=ROUND_HALF_UP)
```

Never `float`. Never `round()`. Construct from strings, not floats: `Decimal("180.50")`, not `Decimal(180.50)` — the second one carries binary representation error into the value before any arithmetic happens.

Values arriving from the database as `NUMERIC` are already `Decimal`. Values from JSON or a model are strings and must be converted explicitly.

## Dates are computed in the tenant's zone

`valid_until` is a date printed on a commercial document, so it must mean 30 calendar days as the tradesperson experiences them:

```python
def valid_until(issued_at_utc: datetime, days: int) -> date:
    local = issued_at_utc.astimezone(ZoneInfo("Africa/Casablanca"))
    return (local + timedelta(days=days)).date()
```

Never do arithmetic on local times — convert to UTC, add, convert back. Morocco's offset changes on 20 September 2026, so a boundary computed the naive way lands on the wrong day across the change. `tzdata` is pinned and tested.

## Revision repricing

The rule that is easy to get wrong and commercially significant:

> A revision uses the **prices of the original quote** for unchanged lines, and current prices only for newly added lines.

Silently repricing a line the client has already seen is a commercial incident, not a rounding detail. When a price has moved, say so rather than deciding for the user:

> Le prix du carrelage a changé depuis (180 → 195 DH). J'utilise l'ancien prix. Dites-moi si vous voulez le nouveau.

This is why `quote_lines.unit_price_ht` is a snapshot column and never a live join to `catalog_items`. Price history lives in `catalog_price_history` when you need to explain an old quote.

## Two kinds of test, and they do different jobs

**Property tests** confirm internal consistency:

```python
@given(lines=st.lists(priced_lines(), min_size=1, max_size=30),
       disc=st.decimals(min_value=0, max_value=50, places=2))
def test_invariants(lines, disc):
    q = PricedQuote(tuple(lines), disc)
    assert q.total_ttc == q2(q.net_ht + sum(q.vat_by_rate.values(), Decimal(0)))
    assert q.net_ht <= q.subtotal_ht
    # line ordering must not move the total
    assert PricedQuote(tuple(reversed(lines)), disc).total_ttc == q.total_ttc
```

**Golden cases** confirm the convention itself is right, and they matter more:

```python
def test_golden_cases():
    for case in load_yaml("tests/fixtures/pricing_golden.yaml"):
        assert PricedQuote(**case["input"]).total_ttc == Decimal(case["expected_ttc"])
```

Compute golden cases **by hand** against RC-1..RC-5, once, and never regenerate them from code output. A golden file generated from the implementation asserts only that the code equals itself, which is a tautology dressed as a test. If a golden case fails after a change, the presumption is that the change is wrong.

Add a golden case for every new scenario: mixed VAT bands, discount with mixed bands, zero-rated lines, a single line, a large quantity with a small unit price, and any case a real customer disputed.

## Never compute money outside this module

Templates format, they do not calculate. Services orchestrate, they do not calculate. If a total appears in a Jinja template or a service function, move it into `PricedQuote` as a property and reference it. Arithmetic scattered across the codebase is arithmetic that will diverge.

The same applies to display: currency formatting belongs in one place, and the document shows `1 234,56 DH` with a non-breaking space before the unit.

## Checklist

- `Money` and `Quantity`, never bare `Decimal` or `float`, in domain code
- Unit compatibility checked by the type, not by a comment
- VAT computed per band, discount applied proportionally before VAT
- A golden case added for the new scenario, computed by hand
- Property tests still pass, including order independence
- No arithmetic added outside `app/domain/pricing.py`
- Revision path uses original prices for unchanged lines
