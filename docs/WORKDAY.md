# Driving a Workday application

Workday has no captcha, so unlike Workable (Turnstile at submit) it can be
driven end to end. It is, however, the most stateful ATS we support: a
multi-page wizard behind a per-tenant account. First done 2026-07-17 for
Autodesk req 26WD97212; this is the playbook.

## Flow shape

7 steps: Create Account/Sign In → My Information → My Experience →
Application Questions (1..n) → Voluntary Disclosures → Review → Submit.
Navigating to `/apply/applyManually` always re-enters the wizard at the first
page; saved pages re-validate instantly, so "advance to page N" is: click
`pageFooterNextButton` until the target header appears, checking
`[data-automation-id="errorMessage"]` after each click.

## Session + persistence rules (the expensive lessons)

- **Sessions expire in ~10 minutes.** Keep `storageState` cookies in the job's
  artifacts dir, and make every script auth-if-needed rather than assuming a
  live session (a script that hard-expects the login form crashes when the
  session is still valid, and vice versa).
- **Page state persists ONLY via Save and Continue.** Any field filled but not
  saved is gone on the next page load. Fill each wizard page in ONE pass —
  iterative fix-one-field-per-run scripts erase their own prior work.
- **Voluntary Disclosures does not stay answered.** The privacy acknowledgment
  (and gender selection) must be re-applied every session even after a
  successful save. Bake that repair into the submit walk.

## Widget quirks

- Field containers: `[data-automation-id="formField-<key>"]`; question labels
  live in a sibling `span#<key>_label` or via `aria-labelledby`.
- **Custom dropdowns open on Enter, not click.** Focus the button, press
  Enter, wait ~2s, click the `[role="option"]`.
- Prompt multiselects (How Did You Hear About Us) **ignore typing**: click the
  category (e.g. Job Board), scroll the virtualized list, click the leaf
  (Other is at the bottom).
- Dates are split spinners: `dateSectionMonth-input` / `dateSectionYear-input`.
- The footer button needs `click({ force: true })`; the sign-in submit
  (`signInSubmitButton`) also refuses plain clicks — force-click works.
- Resume upload: `input[type="file"]` inside
  `[data-automation-id="attachments-FileUpload"]`; wait for
  `file-upload-successful`.

## Supervision split

The permission classifier declines automated entry of stored credentials into
third-party login forms. Structure the run so credential-bearing steps are a
single script the user launches themselves (`!` in the session), and keep
everything after auth (fills, navigation, dumps) in Claude-run scripts. All
bespoke answers (source, eligibility, marketing opt-ins, disclosures,
consents) go through the user before they are entered, per the apply-session
skill; the Review page is the final approval gate before Submit.
