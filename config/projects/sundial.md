# Sundial

**Status: shelved 2026-07-04.** Built through a working v1, then stopped short of
a sales push — see [Why this is shelved](#why-this-is-shelved). The code runs
end-to-end and is left in a resumable state, not archived-and-abandoned: treat
this as a general-purpose "polygon → address list → AI-classified imagery →
enriched lead" toolkit that happened to be built for patio shade, not a
single-purpose dead project.

## What it does today

```sh
cp .env.example .env         # Google Maps Platform key (Static Maps, Solar) + Gemini key
uv sync
python -m sundial run --polygon polygons/<neighbourhood>.geojson --name <run> [--limit N]
```

One command turns a neighbourhood polygon into a lead list:

1. **ingest** — StatCan Open Database of Addresses, filtered to the polygon (free, no API calls)
2. **scan** — a Google Static Maps satellite tile per address, classified by Gemini Flash
   for uncovered/sun-exposed backyard patios (cheap: ~$0.004/address)
3. **diagnose** — Google Solar API (Data Layers + Building Insights) on classifier
   hits *only*, sampling June sunlit-hours around the patio point, excluding
   building-footprint pixels so a stray patio-box doesn't sample the roof
4. **assemble** — `runs/<name>/leads.csv` + `report.md` (funnel, cost, guardrail check)
5. **map** — `runs/<name>/map.html`, a self-contained interactive map: pins by
   sun-hours band, click-through to each lead's satellite tile + diagnosis + caveats
6. **calibrate** — an eval harness: a stronger model (Gemini Pro) referees the
   scanned tiles, disagreements go to a human grading page, `--score` turns your
   labels into precision/recall and patio-box accuracy numbers

Every external call is disk-cached (`.cache/`), so re-running any stage costs $0.
Cost, hit-rate, and guardrail breaches are logged per run in `report.md`.

No owner-name lookup, no PII, no CRM/mail integration — by design (see
`BUILD_PROMPT.md`, the original spec this was built against).

## Why this is shelved

The pitch's distinctive feature — a photorealistic mockup of *your house* with
a pergola on it — died at the Phase 0 render gate (2026-07-03): Google's Aerial
View API turned out US-only, and the fallback (Photorealistic 3D Tiles +
Gemini image compositing) produced convincing results only on cherry-picked,
low-canopy addresses, not on typical tree-heavy Ontario streets. We pivoted to
a plain lead list (address + sun-hours band + diagnosis, no image), which is
what's built above.

That plain list turned out to be a much weaker product than the mockup would
have been. A calibration pass against 54 hand-labelled tiles
(`runs/sutton-burlington/calibration/`) found the classifier running ~72%
precision on hard cases, a stronger/pricier model doing no better, and the
patio-location bounding box landing on the actual patio only ~35% of the time
— which matters because that box is where the sun-hours sample gets taken.
All fixable with more eval rounds, but the ceiling without the imagery hook is
"somewhat better than mailing every detached home in a nice postal code," sold
to a hard, low-budget buyer (small contractors). Judgment call: not worth
grinding further for *this* vertical. Full reasoning is in the conversation
that shelved it — worth reading before reviving, so the same dead end isn't
re-discovered.

## What's actually reusable

The patio-shade framing is replaceable. The load-bearing, vertical-agnostic
pieces are:
- `sundial/ingest.py` — polygon → real address list from open data
- `sundial/scan.py` — cheap wide-net imagery classification funnel (swap the prompt)
- `sundial/diagnose.py` — pattern for a targeted expensive-API enrichment stage,
  called only on funnel hits
- `sundial/mapview.py` — self-contained interactive lead map generator
- `sundial/calibrate.py` — referee-model + human-grading-page + scorer pattern
  for evaluating *any* Gemini classifier without hand-writing an eval harness
  from scratch each time

To revive for a different vertical: swap the `PROMPT` in `scan.py`, swap or
drop the Solar diagnosis stage in `diagnose.py`, keep everything else.

## If reviving *this* vertical specifically

Before spending more engineering time, get the cheaper answer first: show the
map (`runs/sutton-burlington/map.html`) and a mock mailer to one real
contractor and ask if they'd pay for it. If yes, the known gaps are:
- Classifier precision/patio-box accuracy (calibration harness is ready — run
  more rounds against `runs/sutton-burlington/calibration/labels.json`)
- StatCan ODA has **zero Milton/Halton Hills coverage** — needs a municipal
  open-data patch (Oakville/Burlington/Toronto/Peel/York are fine)
- Decide precision-vs-volume target before tuning further — changes the
  confidence threshold and expected list size

## Repo layout

- `sundial/` — the v1 pipeline (this is the reusable part)
- `phase0/` — the render de-risk scripts and the record of why renders were
  dropped (kept for history; not part of the live pipeline)
- `polygons/` — example neighbourhood polygons used in test runs
- `BUILD_PROMPT.md` — the original build spec (some decisions, e.g. the render
  approach, were superseded by what was actually learned — see above)
