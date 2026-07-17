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

## Recommendation

- **Start on `local`** to build and test the whole loop with no external browser infra.
- **Move to `kernel-selfhost`** for real runs — free, Apache-2.0, gives you the live
  view for CAPTCHA takeover and recordings for debugging.
- **Consider `kernel-cloud`** only if you later need many parallel sessions or their
  managed proxy/stealth. The `KernelCloudProvider` stub in `browser.ts` is where the
  SDK wiring goes; nothing else changes.
