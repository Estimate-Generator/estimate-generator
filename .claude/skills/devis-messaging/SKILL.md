---
name: devis-messaging
description: Send WhatsApp messages correctly in the voice-to-quote project — outbox pattern, deterministic dedupe keys, the claim protocol, the 24-hour window, templates, status callbacks and rate limits. Use this for any task that results in a message reaching a user: sending a quote PDF, asking a clarification question, an acknowledgement, a follow-up reminder, a price nudge, an error notice, or anything phrased as "reply to them", "notify the user", "send it back", or "let them know". Sending without a dedupe key delivers a second PDF to a real client, so consult this before writing any call to a messaging provider.
---

# Outbound messaging

Two failures define this area. A duplicate quote sent to a real client destroys trust permanently. A message silently lost leaves a tradesperson waiting for a document that never arrives. Both are prevented by the same discipline.

## Never call the provider directly

```python
# wrong — no dedupe, no retry safety, no delivery record
await provider.send_document(phone, url, filename)

# right
await send(session,
           dedupe_key=f"quote:{quote.id}:v{quote.version}:document",
           tenant_id=quote.tenant_id,
           to=phone, kind="document",
           body={"url": url, "filename": f"{quote.number}.pdf"})
```

`send()` inserts into `outbound_messages` with `ON CONFLICT (dedupe_key) DO NOTHING`, claims the row, calls the provider, and records the returned `wamid`. A second call with the same key is a no-op. That single property is what makes the whole retry story safe.

## Dedupe keys are derived from domain identity

The key must be reproducible from the domain state alone. If you can't reconstruct it in a later process without looking anything up, it's wrong.

```
quote:{quote_id}:v{version}:document
quote:{quote_id}:ack
quote:{quote_id}:followup:{n}
clarification:{clarification_id}:ask
catalog:{item_id}:price_check:{yyyymm}
onboarding:{tenant_id}:welcome
```

Never put a UUID you just generated, a timestamp, or `now()` in a dedupe key. Those make every retry a new message, which is the bug the key exists to prevent. If a message genuinely should be sendable more than once, the differentiator has to be a domain value — the version, the follow-up round, the month.

## Batch aggressively

Every message costs money, and since 1 October 2026 that includes service and utility messages inside the 24-hour window. It also costs quality rating, which is the thing that gets numbers suspended.

Send **one** acknowledgement and **one** result. Never narrate progress:

```
wrong:  "reçu" → "je transcris" → "je calcule" → [PDF]
right:  "reçu, je prépare le devis" → [PDF]
```

If you are adding a message and an existing message already goes to that user in the same flow, extend the existing one rather than adding a second send.

## Free-form versus template

```python
if can_send_freeform(session_row):        # last_inbound_at within 24h
    await send(..., kind="text", body={"text": msg})
else:
    await send(..., kind="template", body={"name": "quote_ready", "params": {...}})
```

Templates require Meta review, which takes hours to days and can be rejected. The approved set is small and deliberately so — see `references/meta-api-notes.md` for the inventory. **Adding a new template is a lead-time decision, not a code change**: submit it for review before the code that needs it is merged.

## Interactive replies carry their own routing

When the answer is closed, use buttons. The button id becomes the routing key on the way back, which removes an entire class of parsing ambiguity:

```python
body={"text": f"Le devis {q.number} pour {client} ?",
      "buttons": [
          {"id": f"outcome:{q.id}:accepted", "title": "Accepté"},
          {"id": f"outcome:{q.id}:refused",  "title": "Refusé"},
          {"id": f"outcome:{q.id}:no_reply", "title": "Sans réponse"},
      ]}
```

Id format is `{domain}:{uuid}:{value}`. The router resolves it with no classifier call and no ambiguity. Free text for a closed question means paying an LLM to guess something a button would have told you.

## A timeout is not a failure

This is the subtle one, and getting it wrong produces the duplicate-PDF incident.

```python
try:
    wamid = await provider.send(...)
except ProviderTimeout:
    raise AmbiguousOutcome("send timed out")   # never retried — see devis-error-handling
```

Meta may have accepted the message. `AmbiguousOutcome` is the one error class that is explicitly **not** retryable: mark the row, wait 60 seconds for a status callback carrying a `wamid` matching the recipient and time window, then escalate to a human. A delayed quote is a minor annoyance; a second quote in a client's WhatsApp is a commercial incident.

The retry budget for outbound send is **zero attempts** for this reason. Every other operation has a schedule; this one does not.

Genuine failures — HTTP 4xx with an error code — are safe to classify and act on: invalid number, blocked, outside window. Each gets a different response and none of them is a blind retry.

## Status callbacks

The same webhook that delivers messages delivers `statuses`. Handle both in `iter_statuses()` and `iter_messages()`. They give you three things nothing else does: real delivery confirmation, failure classification, and the billable category Meta actually charged — which is the only authoritative cost figure for `usage_events`.

Statuses can arrive before your own commit. Park unmatched ones in `orphan_statuses` and replay after 30 s rather than dropping them.

## Backpressure priority

Under rate limiting, order matters: clarifications and documents first, acknowledgements second, follow-ups last. A delayed follow-up costs nothing. A delayed clarification stalls a quote that a user is waiting on.

## Checklist before merging a send

- Deterministic dedupe key, no timestamp or fresh UUID
- Goes through `send()`, not the provider
- Window checked; template used if outside
- A `usage_events` row is written
- Buttons used if the answer is closed
- Timeout path does not auto-retry
- No second message added where an existing one could carry the content
- Provider exceptions translated into the taxonomy inside the adapter, never leaked to services
