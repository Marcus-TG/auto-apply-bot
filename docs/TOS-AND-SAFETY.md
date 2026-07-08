# Terms of service & safe operation

Automating job applications is legitimate — it's your own job search — but *how* and
*where* you automate matters. This system is built to keep you on the safe side.

## Source posture

- **ATS-direct sources (Greenhouse, Lever, Ashby, Workday)** expose public JSON APIs
  meant to be read programmatically. Using them for discovery is fine. This is the
  default and where the value is.
- **LinkedIn and Indeed** explicitly **prohibit scraping and automated access** in
  their terms. Automating them risks account restriction/permanent ban and is legally
  gray. Their adapters ship as **deliberate stubs that throw**, gated behind *two*
  switches (`ENABLE_LINKEDIN`/`ENABLE_INDEED` env **and** `enabled` in config). You
  enabled this source category — the guardrails are still on until you implement the
  adapters and flip both flags. If you do, keep volume low and pacing human.
  - Indeed offers a **legitimate partner API** for some use cases — prefer it over
    scraping if you qualify.

## "Not getting flagged" = polite, not adversarial

The goal is sustainable automation, not defeating detection:

- **CAPTCHAs are handed off to you**, never solved (`apply/captcha.ts`). It's the
  honest and the reliable choice.
- **Human-like pacing**: randomized delays between fields; a realistic, stable
  browser fingerprint — not rapid-fire, rotating-identity evasion.
- **Rate limiting**: `MAX_SUBMISSIONS_PER_DAY` caps volume. Low and steady beats
  high and blocked — and protects your reputation with employers, which mass
  auto-apply tends to burn.
- **Human gate on high-fit roles** keeps quality up and keeps a person in the loop
  for anything that matters.

## Safety switches (all default to the safe setting)

| Switch | Default | Effect |
|---|---|---|
| `DRY_RUN` | `true` | Fills forms, screenshots, but **never clicks submit**. |
| `ENABLE_LINKEDIN` | `false` | Must be true (plus config) to even construct the adapter. |
| `ENABLE_INDEED` | `false` | Same. |
| `autoApplyEnabled` | `false` | Nothing submits without your approval. |
| `MAX_SUBMISSIONS_PER_DAY` | `15` | Hard daily cap. |

Turn these up deliberately, one at a time, as you build trust in the system.
