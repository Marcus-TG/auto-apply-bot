/**
 * Deterministic renderer: RenderedResume → single-column, ATS-parseable HTML → PDF.
 *
 * Content (LLM) and formatting (this file) are deliberately separate so the layout
 * is always consistent and machine-readable. We render via Playwright's Chromium
 * (already a dependency for the apply layer) so there's no extra PDF toolchain.
 * The HTML uses standard headings, real text (no images/columns), which is what
 * ATS parsers want.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "../config/index.js";
import type { RenderedResume } from "./model.js";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function resumeToHtml(r: RenderedResume, name: string): string {
  const exp = r.experiences
    .map(
      (e) => `
    <section class="exp">
      <div class="row"><strong>${esc(e.title)}</strong><span>${esc(e.company)}${e.location ? " · " + esc(e.location) : ""}</span></div>
      <div class="dates">${esc(e.start)} – ${e.end ? esc(e.end) : "Present"}</div>
      <ul>${e.bullets.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>
    </section>`,
    )
    .join("");
  const edu = r.education
    .map((e) => `<li>${esc(e.credential)}, ${esc(e.school)}${e.year ? " (" + esc(e.year) + ")" : ""}</li>`)
    .join("");

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font-family:Georgia,'Times New Roman',serif;font-size:11pt;color:#111;margin:0.6in;line-height:1.35}
    h1{font-size:18pt;margin:0 0 2px}
    h2{font-size:12pt;border-bottom:1px solid #999;margin:16px 0 6px;text-transform:uppercase;letter-spacing:.5px}
    .row{display:flex;justify-content:space-between}
    .dates{color:#555;font-size:10pt;margin-bottom:2px}
    ul{margin:4px 0 0 18px;padding:0}
    li{margin:2px 0}
    .skills{font-size:10.5pt}
    .exp{margin-bottom:10px}
  </style></head><body>
    <h1>${esc(name)}</h1>
    <p class="summary">${esc(r.summary)}</p>
    <h2>Skills</h2>
    <p class="skills">${r.skills.map(esc).join(" · ")}</p>
    <h2>Experience</h2>
    ${exp}
    <h2>Education</h2>
    <ul>${edu}</ul>
  </body></html>`;
}

// One-page hard limit: US Letter is 8.5x11in = 816x1056 CSS px at 96dpi.
// Height must be measured at PRINT width — a wider screen viewport wraps less
// text and under-counts. Small slack absorbs screen/print rounding drift.
const LETTER_WIDTH_PX = 816;
const ONE_PAGE_PX = 1046;
/** Never trim below this many total bullets — better slightly long than empty. */
const MIN_BULLETS = 6;

/** Drop the last bullet of the experience that currently shows the most.
 *  The tailor orders bullets most-relevant-first, so tails are the cheapest cut. */
function dropOneBullet(r: RenderedResume): boolean {
  const candidates = r.experiences.filter((e) => e.bullets.length > 1);
  if (!candidates.length) return false;
  const longest = candidates.reduce((a, b) => (b.bullets.length > a.bullets.length ? b : a));
  longest.bullets.pop();
  return true;
}

/** Write the HTML and render a PDF next to it, trimming bullets until the
 *  resume fits ONE page. Returns the PDF path. */
export async function renderResumePdf(
  r: RenderedResume,
  name: string,
  jobId: string,
): Promise<{ pdfPath: string; jsonPath: string; trimmedBullets: number }> {
  const dir = resolve(process.cwd(), config.env.artifactsDir, jobId);
  mkdirSync(dir, { recursive: true });
  const jsonPath = resolve(dir, "resume.json");
  const htmlPath = resolve(dir, "resume.html");
  const pdfPath = resolve(dir, "resume.pdf");

  const fitted: RenderedResume = structuredClone(r);
  let trimmedBullets = 0;

  // Lazy import so environments without browsers installed can still build/typecheck.
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: LETTER_WIDTH_PX, height: 1056 });
    let html = resumeToHtml(fitted, name);
    await page.setContent(html, { waitUntil: "load" });

    // String-form evaluate: `document` only exists in the browser context, and
    // the project tsconfig deliberately excludes the DOM lib.
    const pageHeight = async () => Number(await page.evaluate("document.documentElement.scrollHeight"));
    while ((await pageHeight()) > ONE_PAGE_PX) {
      const total = fitted.experiences.reduce((a, e) => a + e.bullets.length, 0);
      if (total <= MIN_BULLETS || !dropOneBullet(fitted)) break;
      trimmedBullets++;
      html = resumeToHtml(fitted, name);
      await page.setContent(html, { waitUntil: "load" });
    }

    writeFileSync(jsonPath, JSON.stringify(fitted, null, 2));
    writeFileSync(htmlPath, html);
    await page.pdf({ path: pdfPath, format: "Letter", printBackground: true });
  } finally {
    await browser.close();
  }
  return { pdfPath, jsonPath, trimmedBullets };
}
