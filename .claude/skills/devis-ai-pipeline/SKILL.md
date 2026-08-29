---
name: devis-ai-pipeline
description: Add or change ASR, LLM and extraction steps in the voice-to-quote project — versioned prompt files, Instructor/Pydantic schemas that exclude money fields, dual-path numeric verification, confidence thresholds, content-hash caching, cost metering and Langfuse tracing. Use this whenever a task touches a model call: writing or editing a prompt, changing an extraction schema, swapping or benchmarking an ASR provider, adding a classifier, handling transcription confidence, or anything phrased as "have the model", "use AI to", "improve the extraction", or "make it understand". Putting a price field in an extraction schema lets a hallucinated number reach a client, so consult this before writing any model-facing code.
---

# AI pipeline

One rule governs everything here:

> **The LLM extracts intent. Deterministic code computes money.**

Every other rule in this skill is downstream of that one.

## Schemas exclude money

```python
class ExtractedLine(BaseModel):
    raw_text: str
    quantity: Decimal | None
    unit: Literal["m2","ml","u","forfait","h","kg","m3"] | None
    quantity_confidence: float = Field(ge=0, le=1)
```

There is no `unit_price` and no `total`, and their absence is load-bearing. The model returns what was asked for; prices come from `catalog_items`; arithmetic comes from `app/domain/pricing.py`. If a task seems to need the model to produce a price, the answer is almost always catalog matching (`devis-data-layer`) or a clarification question (`devis-conversation-flow`), not a wider schema.

**The one exception** is `catalog_capture.v1`, where the user is *stating* their prices out loud during onboarding. There the price is user-supplied data being transcribed, not model-generated. It is confirmed back to the user in a summary message before anything is written, because a wrong price captured here poisons every future quote.

## Prompts are versioned files

Prompts live in `prompts/` as `.jinja` files with a version in the filename, listed in `prompts/registry.yaml`. Never inline a prompt in Python.

```yaml
extraction:
  stable: v3
  canary: v4
  rollout_pct: 0
```

This exists so that rollback is a config change taking seconds, not a deploy taking a pipeline run. A prompt change is riskier than a code change — no compiler, no type system, silent failure mode — so it needs a faster escape hatch, not a slower one.

Editing a prompt means creating `v{n+1}`, not modifying `v{n}`. The old version stays loadable for 30 days because `quotes.prompt_version` records which version produced each quote, and "did quality drop after Tuesday" needs both versions available to answer.

Rollout procedure and the resolution logic: `references/prompt-registry.md`.

## Providers go behind interfaces

```python
class ASRProvider(Protocol):
    name: str
    async def transcribe(self, wav: bytes, *, language_hint: str = "ary") -> Transcript: ...
```

Darija ASR quality is the project's largest technical unknown, so provider choice must stay a measurable decision rather than a structural commitment. Candidates: `atlasia/moulsot.v0.3` (built for Darija, robust to Darija↔French code-switching), `anaszil/whisper-large-v3-turbo-darija`, `speechbrain/asr-wav2vec2-dvoice-darija`, plus a commercial API as fallback.

Never load a model inside a worker process. It turns worker scaling into GPU scaling. Self-hosted models sit behind their own inference service with their own queue.

Do not add per-tenant routing heuristics until measurement justifies them. An earlier draft shipped a `fr_heavy` routing table based on intuition; it was removed because there was no data behind it.

## Numbers get two independent paths

`20 m²` heard as `200 m²` is the failure that destroys trust, and a single pipeline cannot audit itself.

```python
transcript, direct = await asyncio.gather(
    transcribe_cached(wav, provider),      # path A: ASR → LLM
    multimodal.extract_numerics(wav),      # path B: audio-in, numbers only
)
# disagreement on quantity or unit → confidence drops to 0.4 → clarification
```

This converts an unsolvable accuracy problem into a tractable uncertainty-detection problem. Path B runs on numeric fields only, so the marginal cost is small.

**Deadline-aware.** Path B runs only if the budget allows — `if dl.remaining > 20`. Pass the `Deadline` to every adapter as its client timeout; an adapter using its own fixed timeout is what breaks the 45 s target, because the budget then describes nothing.

**Degrade rather than fail.** With path B skipped or unavailable, fall back to transcript confidence alone and *raise* the threshold to 0.85, so the system asks more questions instead of sending unverified numbers. Record it in `documents.degraded_modes` — without that, a quality dip during a slow period looks like a model regression and the investigation starts in the wrong place.

## Extraction is not creative writing

```python
EXTRACTION_PARAMS = {"temperature": 0.0, "top_p": 1.0, "max_tokens": 2000}
```

Temperature zero for extraction, classification and catalog capture. There is one correct answer to "how many square metres did they say"; sampling variety only adds variance to eval scores and makes a regression indistinguishable from noise. This is not full determinism — batching and hardware still vary — but it removes the largest controllable source.

Record `prompt_version`, `model_id`, `asr_provider` and `params_hash` on the document. Three weeks later, those four columns are the difference between answering a quality question and guessing.

## Cache by content hash

```python
key = f"extract:{sha256(transcript)}:{prompt_version}:{model_id}:{params_hash}"
```

Retries are the normal operating mode here, and a worker dying after an ASR call and before commit will otherwise re-transcribe and pay twice. ASR keys on `sha256(wav) + provider` (24 h), embeddings on the normalised text (7 d).

The key must include **everything that changes the output**. Omitting `prompt_version` serves stale results after a prompt change; omitting `model_id` serves the old model's answers after a swap. Both look exactly like a deploy that failed to take effect, which is a miserable thing to debug.

## Every call is metered and traced

```python
@observe(name="extract_quote")
async def llm_extract(text, ctx):
    langfuse_context.update_current_trace(
        session_id=ctx.quote_id, user_id=str(ctx.tenant_id),
        tags=[ctx.trade, ctx.language_hint, f"prompt:{ctx.prompt_version}"])
    ...
    await meter(session, ctx.tenant_id, "llm_tokens_in", n_in, provider, ctx.quote_id)
```

Two separate obligations. `usage_events` is a database row because it drives pricing decisions — the margin query in the architecture doc reads it. Langfuse is the trace, and it is what makes the eval feedback loop possible: an incident becomes a corpus case by adding the trace to a dataset.

An unmetered model call is invisible in the margin calculation, which means the business number is quietly wrong.

## Structured output

Use `instructor` with Pydantic. Validation failures are fed back to the model automatically, which handles most malformed output without custom retry logic. Keep the retry count low (2) — a model failing schema validation three times is signalling a prompt problem, not a transient one, and burning tokens on it hides the signal.

## Changing anything here requires evals

A prompt edit, a schema change, a provider swap, or a threshold change all need the gate suite run before merge and the full corpus run nightly. See the `devis-evals` skill — in particular, do not add the failing case that motivated the change directly to the gate split.

## Checklist

- No price or total field in any extraction schema
- Prompt is a new versioned file, registry updated, old version retained
- Provider call goes through the Protocol, not a concrete client
- Cache key includes the prompt version where relevant
- `usage_events` row written; Langfuse span opened with `prompt_version` tag
- `temperature=0.0` for extraction, classification and capture
- Cache key includes prompt version, model id and params
- Timeouts derived from the deadline, not hardcoded
- Degradation path defined and recorded in `degraded_modes`
- Gate eval suite run and reported in the PR
