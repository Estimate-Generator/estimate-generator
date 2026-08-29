---
name: devis-conversation-flow
description: Handle inbound WhatsApp messages in the voice-to-quote project — intent routing, the quote state machine, clarification loops, disambiguation between pending quotes, revisions and versioning, and onboarding states. Use this whenever a task involves what happens when a user sends something: a new message type, a new intent, a new quote state or transition, a clarification question, a "the user replies with X" flow, a revision to an already-sent quote, or anything phrased as "when they say", "handle the case where", or "what if the user". Treating every inbound message as a new quote request corrupts real commercial documents, so consult this before adding message-handling logic.
---

# Conversation flow

The system does not receive quote requests. It receives *messages*, and only some of them are quote requests. Every handler starts by establishing what kind of message this is and which quote, if any, it concerns.

## Route before you do anything expensive

The cascade in `app/services/routing.py` is ordered cheapest-and-most-certain first. Preserve that order when extending it — each step exists to avoid paying for the next one.

1. **Interactive reply** — the button id carries its own target. Free, certain.
2. **WhatsApp reply context** — the user quoted one of our messages; `context_wamid` resolves to the original.
3. **Exactly one open clarification** within the window — safe to attribute.
4. **More than one open** — do not guess, ask (see below).
5. **Text rules** — cheap pattern matches before spending anything.
6. **Classifier** — last resort, and only on text.

Adding a new intent means adding it to `Intent`, to the classifier prompt, to the routing eval suite, and to the handler map. Missing the eval suite is the common omission and it means the new intent has no regression protection.

## Audio is classified after transcription

Audio can't be cheaply classified without transcribing it, and transcription is the expensive step. So transcribe first, then classify the text, then decide whether to continue to extraction. This wastes one ASR call on a "salam", which is acceptable. Adding a second model call on every message to avoid that would cost more than it saves.

## Never guess between pending quotes

With two quotes in `needs_clarification`, a bare "20" is unroutable. Guessing writes a wrong number into a document a client will receive.

```python
if len(open_clarifications) > 1:
    return Route(Intent.DISAMBIGUATE, None, 1.0, "rule")
```

Ask with buttons, and hold the original message in `conversation_sessions.pending_payload` so the user doesn't repeat themselves. The eval gate on disambiguation precision is **1.00** — this is the one metric with no tolerance, because a wrong attribution is silent and lands in a real document.

The system also caps pending clarifications at **two per tenant**. A third forces the oldest to `expired`. Beyond two, disambiguation costs more friction than the clarification saves.

## Low confidence never falls back to "new quote"

```python
if result.confidence < INTENT_CONFIDENCE_THRESHOLD:
    return Route(Intent.UNKNOWN, ...)   # ask plainly
```

A spurious quote consumes a number, sends a document, and teaches the user the system is unreliable. A question costs one message. When in doubt, ask.

## The state machine is data, and it comes from the document spec

Transitions live in `spec.lifecycle`, supplied by the `DocumentSpec` for the document's `kind` — `DevisSpec` today, `FactureSpec` when e-invoicing arrives. Adding a state means editing that spec, not a module-level constant, so a devis lifecycle change cannot silently alter an invoice.

The table is still plain data. Adding a state means adding the entry *and* every legal edge into and out of it. `assert_can()` raises on anything not listed, so an unlisted edge fails loudly in tests rather than quietly in production.

Transitions persist with an optimistic guard so two workers racing cannot both advance a quote:

```python
update(Document).where(Document.id == qid, Document.state == frm).values(state=to)
```

`ConcurrentTransition` is expected under retries. Log it at INFO. Treating it as an error trains the team to ignore alerts.

Full state diagram and the reasoning behind each edge: `references/state-machine.md`.

## Outcome is not a state

Accepted / refused / no-reply is a **property of a sent quote** (`quotes.outcome`), not a lifecycle position. Modelling it as a state would make "accepted" and "revising" mutually exclusive, and clients accept quotes and then ask for changes constantly.

If you find yourself wanting to add a state, check first whether it's actually a property of an existing state. States are for "what is the system doing next"; columns are for "what is true about this row".

The same test applies to `kind`: a genuinely different lifecycle is a new `DocumentSpec`; a variation within one lifecycle is a column.

## Revisions create rows, never mutate

A sent quote exists in someone else's WhatsApp. It is immutable.

```python
new = Document(kind=original.kind,           # a revision never changes kind
               root_id=original.root_id or original.id,
               supersedes_id=original.id,
               version=original.version + 1,
               number=original.number,       # same number
               state=QuoteState.MATCHING)
new.lines = apply_delta(deepcopy(original.lines), delta)
```

Then `original` transitions `SENT → REVISING → SUPERSEDED`. The document prints `DEV-2026-0042 · v2` with a line stating it replaces v1, because ambiguity about which version a client holds is a real commercial risk.

`apply_delta` is pure domain code and exhaustively unit-tested. Revisions are where subtle pricing bugs hide, particularly around repricing — see the `devis-pricing` skill for the rule on which prices a revision uses.

## Clarification loop discipline

- **One question per message.** Batching produces partial answers you cannot map back to fields.
- **Buttons where the answer is closed.** They route themselves.
- **Expire at 24 h**, matching the messaging window, keeping the partial quote.
- **Maximum three rounds** (`clarifications.round`), then hand to a human. A system asking a fourth question has failed its promise of zero friction.

## Log every routing decision

`intent_decisions` records intent, confidence, method and target for every message. Two payoffs: "why did it do that" becomes one query, and the `corrected_to` column lets an operator relabel a mistake — which is how the routing eval corpus grows. Skipping the log to save a write means the router has no path to improvement.

## Checklist

- New intent added to enum, classifier prompt, handler map **and** routing eval suite
- New state added to the relevant `DocumentSpec.lifecycle` with all edges in and out
- Ambiguity resolved by asking, never by picking
- Low confidence routes to `unknown`, not to `new_quote`
- Sent quotes are superseded, never edited
- A row is written to `intent_decisions`
