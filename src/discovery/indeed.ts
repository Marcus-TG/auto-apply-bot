/**
 * ⚠️  ToS-RESTRICTED SOURCE — Indeed.
 *
 * Indeed's Terms prohibit scraping/automated access. Same posture as the LinkedIn
 * adapter: disabled unless ENABLE_INDEED=true AND the source is enabled in config,
 * and shipped as a stub that throws. Implement via BrowserProvider only if you
 * accept the ban/ToS risk. See docs/TOS-AND-SAFETY.md.
 *
 * Note: Indeed does offer a legitimate partner API for some use cases — prefer
 * that route over scraping if you qualify.
 */
import type { SourceAdapter } from "./types.js";
import type { SourceEntryConfig } from "./index.js";
import type { JobPosting } from "../types/index.js";

export const indeedAdapter: SourceAdapter = {
  kind: "indeed",
  async discover(_cfg: SourceEntryConfig): Promise<JobPosting[]> {
    throw new Error(
      "Indeed adapter is a deliberate stub. Automating Indeed violates its ToS " +
        "(ban risk). Prefer the official partner API, or implement via BrowserProvider " +
        "only if you accept the risk; see docs/TOS-AND-SAFETY.md.",
    );
  },
};
