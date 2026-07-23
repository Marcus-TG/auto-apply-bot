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
2. **Adversarial materials review** — before rehearsing, red-team the tailored
   materials against the posting. Ground truth is the live posting text
   captured during the liveness check (postings change after scoring), plus
   the gap keywords on `<PUBLIC_BASE_URL>/review/<id>`. Read
   `artifacts/<id>/resume.json` and `cover-letter.txt` and actively try to
   reject the application the way a skeptical hiring manager would:
   - Wrong-company or wrong-role leakage, or emphasis tailored to a different
     job than the one now live.
   - Fabrication: any claim touching a gap keyword, or not traceable to
     `config/profile.json` / `config/projects/`.
   - Must-haves in the posting the candidate genuinely has but the materials
     bury or omit.
   - Template smell: lines that would survive a company swap unchanged; an
     opener quoting the posting when the quoted line isn't
     company-distinctive.

   Fix what you find:
   - Resume: `POST <PUBLIC_BASE_URL>/review/<id>/resume/revise` with a
     targeted form-encoded `instruction`. It re-selects from the approved
     bullet bank (never writes new claims) and rewrites
     `artifacts/<id>/resume.{json,pdf}` in place.
   - Letter: `POST .../review/<id>/letter/revise` with an `instruction`, or
     `POST .../review/<id>/letter` with the full corrected `text` for
     surgical edits.

   Re-read the regenerated files and re-review; two rounds max. If round two
   still fails on substance (not polish), bring it to the user instead of
   iterating. If no faults survive scrutiny, say so and move on — do not
   invent edits to justify the review. Give the user a one-line verdict per
   job: clean, or what changed and why.
3. **Rehearse** — `SUBMIT_JOB_ID=<id> npx tsx scripts/submit-interactive.ts`
   with DRY_RUN on. Three outcomes:
   - exit 2: it prints the required questions it can't answer. Bring them to
     the user (with proposed drafts grounded in their real materials when the
     question is substantive). To ground a draft in project work, start from
     `config/projects/INDEX.md` — a one-paragraph summary of every project
     README with when-to-cite guidance — then open only the 1-2 relevant
     READMEs. Eligibility questions revealing a mismatch
     (city residency, enrollment, work authorization) → recommend rejecting
     the job instead of answering around it.
   - captcha/interstitial error: hand off; do not attempt to bypass.
   - clean: `presubmit.png` is the filled form.
4. **Record answers** — write the user-approved answers to
   `artifacts/<id>/answers.json` as `[{ "match": "<label substring>", "value": "..." }]`.
   Dropdowns need option-text values ("Yes"), not prose. Consent checkboxes
   (privacy policies, AI-use guidelines) are only ever checked after the user
   has actually read the linked policy and said yes.
5. **Show the form** — re-rehearse, then show the user `presubmit.png`.
6. **Go live** — `DRY_RUN=false SUBMIT_JOB_ID=<id> npx tsx scripts/submit-interactive.ts`
   (run in background; it waits up to 20 min at the code gate).
7. **Verification code** — Greenhouse emails an 8-char security code to the
   applicant address. Fetch it (Gmail MCP: `from:greenhouse-mail.io
   subject:"Security code"`, newest, addressed for THIS company) or ask the
   user, then write it to `artifacts/<id>/verify-code.txt`. The waiting run
   polls that file.
8. **Verify, don't assume** — success = `CONFIRMED SUBMITTED` in the log plus
   the confirmation email arriving. The ledger at `<PUBLIC_BASE_URL>/applications`
   should show the row. If the log is ambiguous, read `postsubmit.png`.

## Pacing

Space applications to the same company across days, not minutes. Prefer one
application per small company at a time. Respect MAX_SUBMISSIONS_PER_DAY.
