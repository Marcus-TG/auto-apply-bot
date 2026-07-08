/**
 * Browser provider abstraction.
 *
 * The fillers (greenhouse/lever/generic) only ever see a Playwright `Page`. WHERE
 * that page runs is decided by config.env.browserProvider:
 *
 *   kernel-cloud     → Kernel-managed browser (their SDK/CDP). Managed proxies,
 *                      stealth, scaling. Needs KERNEL_API_KEY.
 *   kernel-selfhost  → the open-source kernel-images Docker container. We connect
 *                      Playwright to its CDP endpoint (KERNEL_CDP_URL). You run the
 *                      container; you own proxies/anti-detection. Apache-2.0, free.
 *   local            → plain local Chromium for development. No Kernel at all.
 *
 * Because self-host and local both connect Playwright over CDP / launch locally,
 * the filler code is identical across all three — flip one env var to switch.
 */
import type { Browser, Page } from "playwright";
import { config } from "../config/index.js";

export interface BrowserSession {
  page: Page;
  /** URL a human can open to watch / take over (live view). Null for headless local. */
  liveViewUrl: string | null;
  close(): Promise<void>;
}

export interface BrowserProvider {
  readonly kind: string;
  open(): Promise<BrowserSession>;
}

/** Plain local Chromium — for dev. */
class LocalProvider implements BrowserProvider {
  kind = "local";
  async open(): Promise<BrowserSession> {
    const { chromium } = await import("playwright");
    const browser: Browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      // A realistic, stable fingerprint. Politeness, not evasion.
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    return {
      page,
      liveViewUrl: null,
      close: async () => {
        await browser.close();
      },
    };
  }
}

/**
 * Self-hosted kernel-images container. We attach to the Chromium it exposes over
 * CDP (default :9222). The container also serves a live view (noVNC/WebRTC) which
 * we surface for CAPTCHA/human-takeover.
 */
class KernelSelfHostProvider implements BrowserProvider {
  kind = "kernel-selfhost";
  async open(): Promise<BrowserSession> {
    const { chromium } = await import("playwright");
    const browser = await chromium.connectOverCDP(config.env.kernelCdpUrl);
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = context.pages()[0] ?? (await context.newPage());
    return {
      page,
      liveViewUrl: config.env.kernelLiveViewUrl || null,
      close: async () => {
        // Don't kill the shared container; just release the page/context.
        await browser.close();
      },
    };
  }
}

/**
 * Kernel cloud. Kept as a thin adapter: create a managed browser via Kernel, then
 * drive it with Playwright over the CDP URL Kernel returns. Wire the actual SDK
 * calls here when KERNEL_API_KEY is provisioned — the rest of the app is unaffected.
 */
class KernelCloudProvider implements BrowserProvider {
  kind = "kernel-cloud";
  async open(): Promise<BrowserSession> {
    if (!config.env.kernelApiKey) {
      throw new Error(
        "BROWSER_PROVIDER=kernel-cloud but KERNEL_API_KEY is unset. Set it, or use " +
          "kernel-selfhost / local. See docs/KERNEL-SELF-HOST.md.",
      );
    }
    const { default: Kernel } = await import("@onkernel/sdk");
    const { chromium } = await import("playwright");

    const kernel = new Kernel({ apiKey: config.env.kernelApiKey });

    // headless:false is REQUIRED for Kernel to return browser_live_view_url — that's
    // the human/CAPTCHA takeover surface. `stealth` folds in Kernel's anti-bot +
    // CAPTCHA handling; our captcha.ts detection still backstops it and falls through
    // to the live view if a challenge sticks.
    const kb = await kernel.browsers.create({
      headless: false,
      stealth: config.env.kernelStealth,
      timeout_seconds: config.env.kernelTimeoutSeconds,
      ...(config.env.kernelProfileId
        ? { profile: { id: config.env.kernelProfileId } }
        : {}),
    });

    const browser = await chromium.connectOverCDP(kb.cdp_ws_url);
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = context.pages()[0] ?? (await context.newPage());

    return {
      page,
      liveViewUrl: kb.browser_live_view_url ?? null,
      close: async () => {
        // Disconnect Playwright, then release the Kernel session so billing stops.
        await browser.close().catch(() => {});
        await kernel.browsers.deleteByID(kb.session_id).catch(() => {});
      },
    };
  }
}

let _provider: BrowserProvider | null = null;
export function browserProvider(): BrowserProvider {
  if (_provider) return _provider;
  switch (config.env.browserProvider) {
    case "kernel-cloud":
      _provider = new KernelCloudProvider();
      break;
    case "kernel-selfhost":
      _provider = new KernelSelfHostProvider();
      break;
    default:
      _provider = new LocalProvider();
  }
  return _provider;
}
