# Quote state machine reference

## Contents
- [Diagram](#diagram)
- [State meanings](#state-meanings)
- [Why each edge exists](#why-each-edge-exists)
- [Adding a state](#adding-a-state)
- [Intent taxonomy](#intent-taxonomy)

## Diagram

```
received → transcribing → extracting → matching ─┬→ priced → rendering
                                                 │              ↓
                                    needs_clarification    awaiting_approval
                                       ↓ (timeout)              ↓
                                    expired                    sent
                                                          ┌─────┴─────┐
                                                       revising   (outcome
                                                          ↓        recorded
                                                      superseded  on the row)
any state → failed (unrecoverable) → received (operator retry)
```

## State meanings

| State | The system is | Waiting on |
|---|---|---|
| `received` | holding an inbound message | queue |
| `transcribing` | converting audio to text | ASR provider |
| `extracting` | pulling items and quantities | LLM |
| `matching` | resolving items against the catalog | database |
| `needs_clarification` | blocked on one open question | the user |
| `priced` | totals computed, ready to render | queue |
| `rendering` | producing the PDF | Playwright |
| `awaiting_approval` | drafted, needs a human (copilot mode) | operator |
| `sent` | delivered to the tradesperson | nothing |
| `revising` | building version n+1 | itself, briefly |
| `superseded` | replaced by a later version | terminal |
| `expired` | abandoned after timeout | terminal |
| `failed` | unrecoverable error | operator |
| `cancelled` | user abandoned it | terminal |

## Why each edge exists

**`received → extracting`** (skipping transcription) — text messages exist.
Not every quote request is a voice note.

**`extracting → needs_clarification`** — extraction can succeed structurally
while leaving a field unusable, most often a quantity below the confidence
threshold. Failing here would discard work the user already did.

**`needs_clarification → matching`** — an answer re-enters the pipeline at
matching rather than at extraction. Re-extracting would discard the fields the
user already confirmed and could ask about them again.

**`priced → needs_clarification`** — matching can succeed while pricing
reveals a gap, typically an item with no confirmed price. Going back is
correct; guessing a price is not.

**`awaiting_approval → revising`** — an operator reviewing a draft can
correct it directly rather than rejecting and forcing the user to redo it.

**`sent → revising`** — the core UX promise. The absence of this edge in an
earlier draft meant "non, la TVA c'est 14" had no implementation path.

**`revising → sent`** — a revision that needs no clarification goes straight
through. It has already been matched and priced.

**`failed → received`** — an operator retry after fixing the cause, for
example a provider outage. Without it, a transient failure permanently loses a
customer's voice note.

## Adding a state

1. Add to `QuoteState`.
2. Add its entry in the relevant spec's `lifecycle` with every edge **out** —
   `DevisSpec.lifecycle`, not a module-level constant, so a devis change cannot
   silently alter an invoice.
3. Add the edge **in** from every state that can reach it. This is the step
   that gets missed; the state then exists but is unreachable.
4. Decide whether it is terminal and add it to `spec.terminal` if so. Terminal
   means *no edges out at all* — `failed` is not terminal, because an operator
   can retry it back to `received`. A state in both places makes `terminal`
   mean nothing.
5. Add it to the `documents_active` partial index predicate if it is *not* an
   in-flight state, or the index stops being selective.
6. Cover the new path in `tests/unit/test_state_machine.py`.

Before adding one, check whether it is actually a property of an existing
state. `outcome` is a column, not a state, precisely because a quote can be
both accepted and under revision. States answer "what is the system doing
next"; columns answer "what is true about this row".

## Intent taxonomy

| Intent | Trigger | Handler |
|---|---|---|
| `new_quote` | a request with items | create quote, run pipeline |
| `revise_quote` | reference to an existing quote plus a change | `revise()` |
| `answer_clarification` | reply to an open question | resume pipeline |
| `answer_outcome` | button tap or explicit statement | record `outcome` |
| `query` | question about an existing quote | read-only reply |
| `catalog_update` | a price stated outside a quote | update catalog, confirm |
| `smalltalk` | greeting, thanks | short reply, no pipeline |
| `unsupported` | image, document, location | explain what is accepted |
| `unknown` | below the confidence threshold | ask plainly |

Adding an intent means touching four places: the enum, the classifier prompt,
the handler map, and the routing eval suite. The eval suite is the usual
omission, and it means the new intent ships with no regression protection.
