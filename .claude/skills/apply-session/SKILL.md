---
name: apply-session
description: Run a supervised application session - walk the approved queue with the user, surface bespoke form questions for their answers, then submit interactively with verification-code handling. Use when the user wants to "apply", "submit applications", or "do an apply session".
---

# Supervised apply session

The pipeline automates discovery → scoring → tailoring → approval cards. The
final mile stays human-supervised because real forms ask bespoke questions
(essays, eligibility, consents) that need the user's judgment. This skill is
the playbook for that final mile.

## Preconditions

- Jobs in status `approved` (user clicked Approve on their card).
- Worker `.env` present; `DRY_RUN=true` until the user has seen the filled form.

## Per-job loop

1. **Liveness check** — open the posting headless; Greenhouse redirects closed
   jobs to `?error=true` / "no longer open". Mark closed jobs `rejected`
   (postings go stale within days).
2. **Rehearse** — `SUBMIT_JOB_ID=<id> npx tsx scripts/submit-interactive.ts`
   with DRY_RUN on. Three outcomes:
   - exit 2: it prints the required questions it can't answer. Bring them to
     the user (with proposed drafts grounded in their real materials when the
     question is substantive). Eligibility questions revealing a mismatch
     (city residency, enrollment, work authorization) → recommend rejecting
     the job instead of answering around it.
   - captcha/interstitial error: hand off; do not attempt to bypass.
   - clean: `presubmit.png` is the filled form.
3. **Record answers** — write the user-approved answers to
   `artifacts/<id>/answers.json` as `[{ "match": "<label substring>", "value": "..." }]`.
   Dropdowns need option-text values ("Yes"), not prose. Consent checkboxes
   (privacy policies, AI-use guidelines) are only ever checked after the user
   has actually read the linked policy and said yes.
4. **Show the form** — re-rehearse, then show the user `presubmit.png`.
5. **Go live** — `DRY_RUN=false SUBMIT_JOB_ID=<id> npx tsx scripts/submit-interactive.ts`
   (run in background; it waits up to 20 min at the code gate).
6. **Verification code** — Greenhouse emails an 8-char security code to the
   applicant address. Fetch it (Gmail MCP: `from:greenhouse-mail.io
   subject:"Security code"`, newest, addressed for THIS company) or ask the
   user, then write it to `artifacts/<id>/verify-code.txt`. The waiting run
   polls that file.
7. **Verify, don't assume** — success = `CONFIRMED SUBMITTED` in the log plus
   the confirmation email arriving. The ledger at `<PUBLIC_BASE_URL>/applications`
   should show the row. If the log is ambiguous, read `postsubmit.png`.

## Pacing

Space applications to the same company across days, not minutes. Prefer one
application per small company at a time. Respect MAX_SUBMISSIONS_PER_DAY.
