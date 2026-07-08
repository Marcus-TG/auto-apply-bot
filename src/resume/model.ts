/**
 * Structured resume model.
 *
 * A resume is DATA, not a blob. Tailoring = selecting and reordering approved
 * content, never inventing it. Every bullet the tailor can use lives here first,
 * pre-approved by the user. The renderer turns this structure into a PDF
 * deterministically, so formatting is always consistent and ATS-parseable.
 */
import { z } from "zod";

/** A single achievement bullet, tagged so the tailor can pick relevant ones. */
export const Bullet = z.object({
  id: z.string(),
  text: z.string(),
  /** Skills/keywords this bullet demonstrates — used to match against a JD. */
  tags: z.array(z.string()).default([]),
  /** Optional metric for sorting "strongest first". */
  impact: z.number().min(0).max(10).default(5),
});
export type Bullet = z.infer<typeof Bullet>;

export const Experience = z.object({
  company: z.string(),
  title: z.string(),
  location: z.string().nullable(),
  start: z.string(), // "2022-01"
  end: z.string().nullable(), // null = present
  /** The full pool of approved bullets. The tailor SELECTS from these; it may
   *  lightly rephrase for emphasis but must not introduce new claims. */
  bulletPool: z.array(Bullet),
});
export type Experience = z.infer<typeof Experience>;

export const ResumeVariant = z.object({
  id: z.string(), // e.g. "growth-marketing", "product-marketing"
  label: z.string(),
  /** Which role types this variant targets — helps the selector shortlist. */
  targetRoles: z.array(z.string()),
  /** One-line positioning statement; the tailor may adapt this per JD. */
  summary: z.string(),
  skills: z.array(z.string()),
  experiences: z.array(Experience),
  education: z.array(
    z.object({
      school: z.string(),
      credential: z.string(),
      year: z.string().nullable(),
    }),
  ),
});
export type ResumeVariant = z.infer<typeof ResumeVariant>;

/** What the tailor produces: a concrete, ready-to-render resume for one job. */
export const RenderedResume = z.object({
  variantId: z.string(),
  summary: z.string(),
  skills: z.array(z.string()),
  experiences: z.array(
    z.object({
      company: z.string(),
      title: z.string(),
      location: z.string().nullable(),
      start: z.string(),
      end: z.string().nullable(),
      /** The SELECTED bullet texts, in final order. */
      bullets: z.array(z.string()),
    }),
  ),
  education: ResumeVariant.shape.education,
});
export type RenderedResume = z.infer<typeof RenderedResume>;
