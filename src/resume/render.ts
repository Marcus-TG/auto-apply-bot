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

/** Write the HTML and render a PDF next to it. Returns the PDF path. */
export async function renderResumePdf(
  r: RenderedResume,
  name: string,
  jobId: string,
): Promise<{ pdfPath: string; jsonPath: string }> {
  const dir = resolve(process.cwd(), config.env.artifactsDir, jobId);
  mkdirSync(dir, { recursive: true });
  const jsonPath = resolve(dir, "resume.json");
  const htmlPath = resolve(dir, "resume.html");
  const pdfPath = resolve(dir, "resume.pdf");
  writeFileSync(jsonPath, JSON.stringify(r, null, 2));
  const html = resumeToHtml(r, name);
  writeFileSync(htmlPath, html);

  // Lazy import so environments without browsers installed can still build/typecheck.
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    await page.pdf({ path: pdfPath, format: "Letter", printBackground: true });
  } finally {
    await browser.close();
  }
  return { pdfPath, jsonPath };
}
