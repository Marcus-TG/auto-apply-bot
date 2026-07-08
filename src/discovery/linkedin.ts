/**
 * ⚠️  ToS-RESTRICTED SOURCE — LinkedIn.
 *
 * LinkedIn's User Agreement prohibits scraping and automated access. Using this
 * adapter risks account restriction/ban and is legally gray. It is DISABLED unless
 * BOTH `ENABLE_LINKEDIN=true` (env) AND the source's `enabled: true` (config) are set
 * — see config.sourceAllowed(). We do not ship a working scraper here.
 *
 * If you accept the risk, implement discover() using the shared BrowserProvider
 * (src/apply/browser.ts) so it reuses the same session/pacing/live-view plumbing.
 * Keep pacing human-like and volume low. This stub throws so nothing runs by accident.
 */
import type { SourceAdapter } from "./types.js";
import type { SourceEntryConfig } from "./index.js";
import type { JobPosting } from "../types/index.js";

export const linkedinAdapter: SourceAdapter = {
  kind: "linkedin",
  async discover(_cfg: SourceEntryConfig): Promise<JobPosting[]> {
    throw new Error(
      "LinkedIn adapter is a deliberate stub. Automating LinkedIn violates its ToS " +
        "(ban risk). Implement via BrowserProvider only if you accept that risk; see " +
        "docs/TOS-AND-SAFETY.md.",
    );
  },
};
