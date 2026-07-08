# Approval flow

You said you don't want to fly blind: **high-fit jobs get flagged for review before
submitting.** That's encoded in three lanes, assigned in `src/scoring/index.ts::assignLane`.

## Lanes

| Condition | Lane | What happens |
|---|---|---|
| `overall < applyFloor` | `reject` | Never applied to. Marked `rejected`. |
| `overall >= reviewFloor` | `review` | **Always** queued for your approval (the high-fit band). |
| in between | `auto` | Auto-applied **only if** `autoApplyEnabled` **and** `confidence >= minConfidenceForAuto`; otherwise falls through to `review`. |

Defaults (`config/thresholds.json`): `applyFloor: 55`, `reviewFloor: 75`,
`autoApplyEnabled: false`. So out of the box **nothing auto-submits** — every job
worth applying to waits for you. Flip `autoApplyEnabled` once you trust the scoring.

## The gate mechanism

1. After tailoring, a `review`-lane job creates an **approval request** (`approvals`
   table) with an unguessable UUID and an expiry (`approvalTimeoutHours`, default 48h).
2. The worker POSTs an **ApprovalCard** to n8n (`N8N_APPROVAL_WEBHOOK`): the score
   summary, matched strengths vs. gaps, the tailored resume path, the cover-letter
   text, and two one-click links:
   - `GET /approval/:id/approve`
   - `GET /approval/:id/reject`
3. n8n formats + delivers that card (email/Telegram/Slack) and, if you use its
   **Wait** node, holds the workflow until the decision webhook fires.
4. You click Approve → job → `approved`. The next submit run picks it up.
   You click Reject → job → `rejected`. Nothing is sent.
5. No response before expiry → `POST /run/sweep` (on a timer) times it out to
   `rejected`. **Timeout fails closed** — silence never submits.

Decisions are **idempotent**: a second click on an already-resolved link returns
"already used" and changes nothing.

## Editing before submit

The card includes `resumePath` / `coverLetterText`. To tweak before approving, edit
the artifacts under `artifacts/<jobId>/` (or `POST /approval/:id` with
`decision: "edit"` and a note), then approve. The submit step reads whatever is on
disk at submit time.
