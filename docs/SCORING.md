# Fit scoring

Two stages, to keep quality high and token spend low.

## Stage 1 — deterministic prefilter (free)

`src/scoring/prefilter.ts`. Hard filters that need no LLM:

- excluded company / excluded keyword / missing must-have keyword
- onsite role outside your preferred locations
- stated max comp below your floor (same currency) — **missing comp is never a reject**

A job that fails here goes straight to `prefiltered_out`. No tokens spent.

## Stage 2 — LLM rubric score

`src/scoring/llm-scorer.ts`. Claude scores the survivor against a rubric, returning
JSON (forced via tool-use). The dimensions and their weights live in
`config/thresholds.json`:

```json
"weights": {
  "skills_match": 0.30,
  "domain_match": 0.20,
  "seniority_match": 0.20,
  "compensation_growth": 0.15,
  "culture_logistics": 0.15
}
```

The model returns a 0–100 per dimension with a rationale; **we compute the weighted
`overall` ourselves** (never trust the model's arithmetic). It also returns:

- `confidence` (0–1) — how sure it is; drives whether the auto lane is allowed.
- `recommendedVariant` — which resume variant fits best.
- `matchedKeywords` / `gapKeywords` — the honesty guardrail for tailoring.
- `summary` — the one-liner shown on the approval card.

### Cost controls
- The candidate profile + variant summaries + rubric are passed as **prompt-cached**
  context (identical on every job) — you pay for them roughly once per 5-minute window.
- Pre-scoring uses the cheap model (`MODEL_PREFILTER`, e.g. Haiku); generation and
  any finalist re-score use the strong model (`MODEL_GENERATION`).

## Tuning

- Raise `applyFloor` to be pickier about what's worth tailoring at all.
- Raise `reviewFloor` to auto-apply to more of the mid-band (only if
  `autoApplyEnabled` is true).
- Reweight dimensions to match what you actually care about — they need not sum to
  exactly 1 (the scorer normalizes).
