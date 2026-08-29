# Meta WhatsApp Cloud API notes

## Contents
- [Template inventory](#template-inventory)
- [Message categories and cost](#message-categories-and-cost)
- [Error codes worth handling](#error-codes-worth-handling)
- [Quality rating](#quality-rating)
- [Webhook payload shapes](#webhook-payload-shapes)

## Template inventory

Templates require Meta review — hours to days, and rejection is possible.
Submit before the code that needs them is merged.

| Name | Category | Use |
|---|---|---|
| `quote_ready` | utility | document delivered outside the 24h window |
| `clarification_needed` | utility | one open question, window expired |
| `quote_followup` | utility | outcome check after N days |
| `price_check` | utility | stale catalog item |
| `onboarding_welcome` | utility | first contact |

Keep the set small. Every template is a review cycle and a maintenance
burden, and a rejected template blocks a launch.

Rejection causes, in rough order of frequency: promotional language in a
utility template, variables at the start or end of the body, missing sample
values, and placeholder text left in.

## Message categories and cost

Since July 2025 billing is per message rather than per 24-hour conversation.
Since 1 October 2026 service and utility messages sent inside the customer
service window are also billable — the free-window assumption that made
conversational products cheap no longer holds.

Practical consequences for this codebase:

- Batching is a cost control, not a nicety. One acknowledgement, one result.
- The `usage_events` estimate is a guess until the status callback reports the
  actual billable category. Reconcile, and alert if estimate and actual
  diverge by more than 15% over a week — that means the price book in config
  is stale.

## Error codes worth handling

| Code | Meaning | Response |
|---|---|---|
| 131026 | Message undeliverable | invalid or unregistered number — mark, tell the tenant |
| 131047 | Outside 24h window | switch to a template, do not retry as-is |
| 131051 | Unsupported message type | fix the payload; a retry will fail identically |
| 130429 | Rate limit hit | backoff, respect the token bucket |
| 132000–132015 | Template problems | wrong param count, or paused/disabled template |
| 133010 | Number not registered | configuration error, page someone |

Anything not in this list: log the full error body before retrying. Blind
retries on unknown codes are how duplicate sends happen.

## Quality rating

Meta assigns each number a quality rating driven largely by users blocking or
reporting messages. A drop to "medium" is the early warning; "low" precedes
restriction.

Monitor it daily. The main lever is not sending messages people did not ask
for — which makes batching (`devis-messaging`) a reliability measure as much
as a cost one.

## Webhook payload shapes

Messages and statuses arrive on the same endpoint, in the same envelope.
Handle both.

```json
{
  "entry": [{
    "changes": [{
      "value": {
        "messages": [{
          "id": "wamid.XXX",
          "from": "212661234567",
          "type": "audio",
          "audio": {"id": "MEDIA_ID", "mime_type": "audio/ogg; codecs=opus"},
          "context": {"id": "wamid.PREVIOUS"}
        }],
        "statuses": [{
          "id": "wamid.OURS",
          "status": "delivered",
          "recipient_id": "212661234567",
          "pricing": {"category": "utility", "billable": true}
        }]
      }
    }]
  }]
}
```

Notes that cause bugs if missed:

- `context.id` is present only when the user explicitly replied to a message.
  It is the cheapest routing signal available — use it before any classifier.
- `pricing` on the status is the authoritative billable category.
- Statuses can arrive before your own send has committed. Park unmatched ones
  in `orphan_statuses` and replay after 30 s rather than dropping them.
- Media download needs the bearer token on **both** calls: the metadata
  lookup and the download URL itself.
