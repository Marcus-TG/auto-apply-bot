# Browser backend: Kernel self-host vs. cloud vs. local

The apply layer talks to a `BrowserProvider` interface (`src/apply/browser.ts`). The
fillers only ever see a Playwright `Page`, so switching backends is one env var:

```bash
BROWSER_PROVIDER=local            # dev — plain local Chromium, no Kernel
BROWSER_PROVIDER=kernel-selfhost  # the open-source kernel-images Docker container
BROWSER_PROVIDER=kernel-cloud     # Kernel's managed cloud (needs KERNEL_API_KEY)
```

## Is self-hosting Kernel feasible? Yes.

Kernel open-sources its browser images — [`github.com/kernel/kernel-images`](https://github.com/kernel/kernel-images),
**Apache-2.0**. The container runs headful Chromium and exposes exactly what this
project needs:

| Capability | Port | Used for |
|---|---|---|
| Chrome DevTools Protocol | `9222` | Playwright connects here (`connectOverCDP`) |
| Live view (noVNC / WebRTC) | `443`/`8080` | Watch the run; take over for CAPTCHAs |
| Recording API | `10001` | Session replays for debugging failed submits |

### Run it

```bash
git clone https://github.com/kernel/kernel-images
cd kernel-images/images/chromium-headful
IMAGE=kernel-docker ./build-docker.sh
IMAGE=kernel-docker ENABLE_WEBRTC=true ./run-docker.sh
# then point the bot at it:
#   BROWSER_PROVIDER=kernel-selfhost
#   KERNEL_CDP_URL=http://localhost:9222
#   KERNEL_LIVE_VIEW_URL=http://localhost:8080
```

A `docker-compose.yml` is included at the repo root as a starting point (adjust image
tags to match the kernel-images build output).

## What you give up vs. Kernel cloud

The open-source image is **just the browser**. The cloud adds a managed layer:

- multi-session orchestration + pooling and autoscaling,
- the sessions API,
- managed **proxies** and **stealth / anti-detection**.

**At single-user scale this barely matters** — you run one session at a time and
drive it with Playwright, which the self-host image supports fully. The one real
tradeoff: **anti-detection becomes your responsibility** rather than theirs. Given
this project's posture (ATS-direct sources, CAPTCHA handoff, polite rate limits),
that's an acceptable trade — you're not trying to out-run detection in the first
place.

## How the CAPTCHA handoff actually works

Policy is unchanged: we **detect** challenges and hand them to a human, we never
solve them. What makes the handoff usable is that the session survives it.

1. `detectChallenge` (or an unanswerable required field) → `needs_human`.
2. `submitApplication` **detaches** instead of closing: Playwright disconnects,
   the remote browser and its live view stay up. Closing here would destroy the
   Kernel session and the link would be dead on arrival.
3. A `live_view_handoff` event records the URL, session id and TTL.
4. The **Take over** button on the queue's Approved tab opens that live view, so
   you finish the form in the same browser the bot was using — session, cookies
   and filled fields intact. Finish it, then hit **Mark sent**.

The link hides itself once `KERNEL_TIMEOUT_SECONDS` has elapsed, since the
provider reaps idle sessions by then. That timeout is an *inactivity* timer and
opening the live view counts as activity — but the default **300s is short for a
handoff you might not see for an hour**. Raise `KERNEL_TIMEOUT_SECONDS` (1800+)
if you want time to react; unclaimed sessions still expire on their own, so a
missed handoff can't bill forever.

## Recommendation

- **Start on `local`** to build and test the whole loop with no external browser infra.
- **Move to `kernel-selfhost`** for real runs — free, Apache-2.0, gives you the live
  view for CAPTCHA takeover and recordings for debugging.
- **Consider `kernel-cloud`** only if you later need many parallel sessions or their
  managed proxy/stealth. `KernelCloudProvider` in `browser.ts` is fully wired against
  `@onkernel/sdk` v0.74; it only needs `KERNEL_API_KEY` set.

A note on what stealth buys you: Kernel's `stealth` reduces how often bot checks
*fire*, it does not clear an interactive CAPTCHA once one appears. Sites like
Workable (Turnstile at submit) will still need the human takeover above — treat
that as the design, not a gap to engineer around.
