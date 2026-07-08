# Edge cases & how they're handled

| Case | Handling | Where |
|---|---|---|
| **Missing required field** we can't answer | Pause → `needs_human` with the field label. Never guess. | `apply/field-map.ts`, `fillers/generic.ts` |
| **EEO / demographic questions** | Left `null` in the profile → treated as unknown → human answers. We never fabricate demographics. | `apply/field-map.ts` |
| **Open-ended "why this company?"** | Deferred to the cover letter + human; the filler won't invent an answer. | `apply/field-map.ts::answerFor` |
| **CAPTCHA / anti-bot challenge** | Detected → hand off to human via live view. We do **not** solve CAPTCHAs. | `apply/captcha.ts` |
| **Login / account wall** | Detected as an unresolved required step → `needs_human`. | `apply/index.ts` |
| **Unknown ATS / site variation** | ATS detection with a generic DOM-walking fallback filler. | `apply/ats-detect.ts`, `fillers/generic.ts` |
| **Duplicate posting across boards** | Per-source dedupe hash + `crossSourceKey` for cross-board detection. | `normalize/dedupe.ts` |
| **Missing compensation** | Never a reject reason; only a *stated* max below floor filters. | `scoring/prefilter.ts` |
| **Model returns invalid JSON** | Tool-use forces schema; Zod validates and throws → job → `failed`, logged. | `llm/client.ts` |
| **Model invents a bullet id** | Unknown ids are dropped; falls back to top-impact approved bullets. | `resume/tailor.ts` |
| **Double submission** | `submissions` table + status lock (`submitting`); idempotent. | `apply/index.ts` |
| **Rate / politeness** | `MAX_SUBMISSIONS_PER_DAY` cap; randomized human-like delays between fields. | `apply/index.ts`, `fillers/generic.ts` |
| **Source API down / 4xx** | Adapter skips that company, logs `source_error`, continues. | `discovery/index.ts` |
| **Approval never answered** | Expires to `rejected` on the sweep — fails closed. | `approval/index.ts` |

## The `needs_human` queue

Anything parked in `needs_human` is surfaced for you to finish by hand (open the
live-view URL from the event log, or the apply URL). These are deliberate stops, not
failures — the system chooses to ask rather than risk a bad submission.
