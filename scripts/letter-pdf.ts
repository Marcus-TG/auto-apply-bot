/**
 * Render artifacts/<id>/cover-letter.txt to cover-letter.pdf so ATSes that
 * only accept PDF uploads (Ashby) can carry the letter.
 *
 *   npx tsx scripts/letter-pdf.ts <jobId>
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "../src/config/index.js";

const id = process.argv[2] ?? "";
if (!/^[0-9a-f]{16}$/.test(id)) {
  console.error("Usage: npx tsx scripts/letter-pdf.ts <jobId>");
  process.exit(1);
}
const dir = resolve(process.cwd(), config.env.artifactsDir, id);
const txtPath = resolve(dir, "cover-letter.txt");
if (!existsSync(txtPath)) {
  console.error(`no cover-letter.txt in ${dir}`);
  process.exit(1);
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const paragraphs = readFileSync(txtPath, "utf8")
  .trim()
  .split(/\n{2,}/)
  .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
  .join("\n");

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { font-family: Georgia, "Times New Roman", serif; font-size: 11pt;
         line-height: 1.5; color: #1a1a1a; margin: 1in; }
  p { margin: 0 0 0.9em; }
</style></head><body>${paragraphs}</body></html>`;

const { chromium } = await import("playwright");
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: "load" });
  const pdf = await page.pdf({ format: "Letter", printBackground: true });
  const pdfPath = resolve(dir, "cover-letter.pdf");
  writeFileSync(pdfPath, pdf);
  console.log(`wrote ${pdfPath} (${pdf.length} bytes)`);
} finally {
  await browser.close();
}
