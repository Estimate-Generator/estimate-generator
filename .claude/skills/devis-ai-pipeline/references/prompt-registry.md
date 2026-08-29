# Prompt registry and rollout

## Contents
- [Registry format](#registry-format)
- [Resolution](#resolution)
- [Rollout procedure](#rollout-procedure)
- [Rollback](#rollback)
- [Model pinning](#model-pinning)
- [Writing a prompt file](#writing-a-prompt-file)

## Registry format

```yaml
# prompts/registry.yaml
extraction:
  stable: v3
  canary: v4
  rollout_pct: 0        # 0 = canary-channel tenants only
intent_router:
  stable: v1
  canary: null
catalog_capture:
  stable: v1
  canary: null
```

## Resolution

```python
def resolve_prompt(name: str, tenant: Tenant) -> PromptVersion:
    reg = registry[name]
    if tenant.prompt_channel == "canary" and reg.get("canary"):
        return load(name, reg["canary"])
    if reg.get("canary") and stable_hash(tenant.id) < reg["rollout_pct"]:
        return load(name, reg["canary"])
    return load(name, reg["stable"])
```

`stable_hash` must be deterministic across processes and restarts — hash the
tenant UUID, never use `random()`. A tenant flipping between prompt versions
between messages produces inconsistent behaviour inside one conversation,
which is far more confusing than either version alone.

Record the resolved version on `documents.prompt_version`. Without it, "did
quality drop after Tuesday" has no answer.

## Rollout procedure

```
1. new version passes the gate split in CI
2. merge → registry updated → deployed (rollout_pct 0, no behaviour change)
3. promote 5 canary tenants                    → observe 48 h
4. rollout_pct 10 → 25 → 50 → 100              → observe 24 h between steps
5. old version stays loadable for 30 days
```

Watch during each step: quantity match rate, clarification rate, cost per
quote, and correction rate. A clarification rate rise with a flat match rate
means the new prompt is more cautious, which may be correct — read it as a
signal to check the threshold, not automatically as a regression.

## Rollback

```yaml
extraction:
  stable: v3
  canary: null      # ← that is the rollback
```

Reload the registry. Seconds, no deploy, no pipeline run. This property is
the entire reason prompts live outside the code. A prompt change is riskier
than a code change — no compiler, no type system, silent failure — so it
needs a *faster* escape hatch, not the same one.

## Model pinning

Pin exact model identifiers, never floating aliases. Providers update
checkpoints behind stable names, and a silent checkpoint change is
indistinguishable from your own regression.

```yaml
providers:
  extraction: "claude-sonnet-4-6-20260401"    # pinned
  # not: "claude-sonnet-latest"
```

The nightly full-corpus run against the pinned model is what surfaces a
provider-side change. A score drop with no code change and no prompt change
is the signature.

## Writing a prompt file

```jinja
{# prompts/extraction.v4.jinja
   Changes from v3: explicit unit disambiguation for "mètre"
   Owner: <name> · Created: 2026-09-02 #}

Tu extrais les articles d'une demande de devis dictée par un artisan
marocain. La langue mélange darija et français.

Retourne UNIQUEMENT les articles, quantités et unités.
Ne calcule aucun prix et n'invente aucun montant.
{# ← this instruction mirrors the schema, which has no price field. #}

{% if tenant.trade %}Métier : {{ tenant.trade }}.{% endif %}
{% if recent_labels %}
Articles habituels de cet artisan : {{ recent_labels | join(", ") }}.
{% endif %}

Transcription : {{ transcript }}
```

Three habits worth keeping:

- **Header comment** with the diff from the previous version, an owner and a
  date. Six months later this is the only record of why a phrasing exists.
- **Tenant context** (trade, recent labels) improves matching noticeably and
  costs few tokens. Keep the recent-label list short — 20 or so — or it
  starts to bias extraction toward past items.
- **The no-price instruction stays** even though the schema already excludes
  those fields. Belt and braces on the invariant that matters most.
