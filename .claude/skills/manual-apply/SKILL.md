---
name: manual-apply
description: Hand a job's application materials to the user for a manual submit - resolve the job, make sure the artifacts folder is complete, give one scp command that drops it in their Downloads, plus a fill checklist. Use when automation is blocked (spam flag, captcha) or the user says "manual apply" / "give me the files for <job>".
---

# Manual apply handoff

When the interactive submitter can't finish (Ashby spam flag, Workable
Turnstile, any captcha) or the user just wants to submit by hand, package the
job's materials and hand them over. Never retry an automated submit into a
spam flag without being asked.

## Steps

1. **Resolve the job** — take a job id or company/title fragment; look it up in
   `data/app.sqlite` (`jobs` table, via `src/store/db.ts` with
   `~/.local/node/bin` on PATH). If ambiguous, list matches and ask.
2. **Complete the folder** — `artifacts/<id>/` should hold `resume.pdf`,
   `cover-letter.txt`, `answers.json` (the user's approved answers), and
   `presubmit.png`. If answers or the screenshot are missing, run the
   apply-session rehearse flow first (DRY_RUN on) so the user gets a filled
   form to copy from — do not hand over an incomplete folder.
3. **Give the download** — one command, folder lands in Downloads, named by
   company:

   ```bash
   scp -r docker@aria:auto-apply-bot/artifacts/<id> ~/Downloads/<company>-application
   ```

4. **Fill checklist** — from `presubmit.png` and the rehearse output, tell the
   user which fields will NOT autofill from the resume upload (typically:
   LinkedIn URL, phone, mailing address, location dropdown, Yes/No toggles,
   consent radios) and what value to put in each, citing `answers.json`. Note
   where the cover letter goes if the form has no upload field (often a
   "Comments" box) or that it is unused.
5. **Record after the fact** — when the user says it's submitted, write the
   ledger row (`submissions` table: job_id, submitted_at, confirmation URL or
   note) and set the job's status to `submitted`. Ask for the confirmation
   URL or email subject as the confirmation value. Do not record before the
   user confirms.

## Notes

- The host is `aria`; remote user is `docker`. Paths in the scp command are
  relative to the remote home directory.
- Respect the same pacing rules as apply-session (MAX_SUBMISSIONS_PER_DAY,
  spacing per company) — manual submits still count.
