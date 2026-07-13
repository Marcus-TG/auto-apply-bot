# Rachel Long — Editorial Portfolio

Corporate and conference event photography portfolio. Built with Astro v6 + Tailwind CSS v4. Warm, editorial, photography-led — deliberately not the cold blue-grey grid look of competing sites.

## Stack

| Layer | Choice |
| :-- | :-- |
| Framework | Astro v6 (static output, prerendered pages) |
| Styles | Tailwind CSS v4 (CSS-first config in `global.css`, no `tailwind.config.js`) |
| Animation | GSAP (scroll-driven proximity scale, overlay fades) + Lenis (smooth scroll) |
| Fonts | Astro Fonts API — Newsreader (display) + Source Sans 3 (body), self-hosted at build time |
| Images | `astro:assets` + `sharp` for optimisation; source images committed at ≤ 2400 px |

## Commands

| Command | Action |
| :-- | :-- |
| `npm install` | Install dependencies |
| `npm run dev` | Dev server at `localhost:4321` |
| `npm run build` | Production build to `./dist/` |
| `npm run preview` | Preview production build locally |
| `npx astro check` | TypeScript / template diagnostics (strict) |
| `node scripts/downsize-images.mjs` | Resize new source images to ≤ 2400 px before committing |

> **Verification:** `npm run build` passing + `npx astro check` clean (0 errors) + manual visual QA. There is no test suite. `astro build` does not run `astro check` — run it separately.

## Project structure

```
src/
├── assets/projects/<Date _ Event Name>/
│   ├── thumb.jpg          # browse lead image
│   └── *.jpg              # detail gallery shots
├── components/
│   ├── Home.astro          # shared page body (masthead, topbar, browse + overlay)
│   ├── PortfolioSequence.astro  # scroll-driven photo slider
│   ├── ProjectMoment.astro      # one work item (browse list)
│   ├── DetailOverlay.astro      # full-viewport detail takeover
│   ├── ProjectDetail.astro      # editorial gallery (stage + film strip + aside)
│   ├── AboutSection.astro
│   ├── ContactSection.astro
│   ├── TestimonialsSection.astro
│   └── Img.astro           # thin wrapper over astro:assets Image
├── data/
│   ├── projects.ts         # event list — add a row here to add a project
│   ├── about.ts
│   └── testimonials.ts
├── pages/
│   ├── index.astro         # homepage
│   ├── work/[slug].astro   # prerendered per-project deep-link
│   └── foundation.astro    # dev/QA token specimen (delete before launch)
├── scripts/
│   ├── portfolio-scrub.ts  # browse layer: active tracking + proximity scale gradient
│   ├── proximity-scale.ts  # shared raised-cosine scale engine (browse + detail strip)
│   ├── portfolio-detail.ts # detail overlay: open/close, gallery, scroll-driven strip
│   ├── section-nav.ts      # veil-fade in-page section navigation
│   ├── smooth-scroll.ts    # Lenis init with reduced-motion guard
│   ├── mailing-list.ts     # EmailOctopus form progressive enhancement
│   ├── tweak-panel.ts      # dev-only Tweakpane browse tuning panel
│   └── detail-crop-panel.ts # dev-only Tweakpane focal-point panel
└── styles/
    └── global.css          # single source of truth: @theme tokens, @layer components
scripts/
└── downsize-images.mjs     # resize source images to ≤ 2400 px (run before committing)
```

## Design system

All tokens live in the Tailwind v4 `@theme` block inside `src/styles/global.css`. There is no separate config file. Token changes go there — never hardcode hex values in components.

**Palette rules:**
- No pure black anywhere (`#000`, `black`). Text is espresso (`#2D211B`). Scrims use espresso via `color-mix`.
- `clay` is decoration only (marks, rules, focus rings). Use `clay-strong` for readable text that must hit WCAG AA 4.5:1.

**Layout primitives** (component classes in `@layer components`): `.shell`, `.band`, `.measure`, `.section`, `.rule`, `.accent-mark`. Compose these; don't re-derive spacing.

**Images:** wrap in `<Img>` from `src/components/Img.astro`. For fixed crop boxes, put `aspect-ratio` on a wrapper div (not the `<img>`), and target the inner image with `:global(img)` from scoped CSS.

**Fonts:** components reference `font-display` / `font-body` only — never a raw family name. Swap fonts in `astro.config.mjs`; everything else follows automatically.

## Adding an event

1. Create `src/assets/projects/<YYYY-MM-DD _ Event Name>/` and drop in `thumb.jpg` + shot images.
2. Run `node scripts/downsize-images.mjs` to resize them (idempotent; safe to re-run).
3. Add a row to the `events` array in `src/data/projects.ts`. Folder names and shot filenames are mapped by hand — do not rely on parsing or sorting.

## Key behaviours

**Browse layer** — sticky index of project names on the left; photo column on the right. A proximity scale gradient (raised cosine) enlarges whichever photo is nearest the viewport centre, with a translateY correction to keep gaps constant. Desktop-only; degrades to a plain static list on mobile and for reduced-motion users.

**Detail view** — clicking a project opens it in-place into a full-viewport overlay (no page swap). URL becomes `/work/<slug>` via `pushState`. All projects are prerendered as `/work/[slug].astro` so deep-links and refreshes work on a static host. The gallery has a scroll-driven film strip using the same proximity-scale engine.

**Section navigation** — in-page links to `#about`, `#contact`, and `#browse` fade a warm bone veil over the current view, scroll/restore behind it, then reveal the destination. Reduced-motion users get native anchor behaviour.

**Smooth scroll** — Lenis, initialised only when `prefers-reduced-motion` is not `reduce`. Torn down live if the preference changes. `section-nav.ts` routes jumps through `lenis.scrollTo(..., { immediate: true, force: true })` to avoid a native scroll being overwritten by Lenis mid-glide.

## Contact / mailing list

Contact section uses `Info@saroscreative.ca` with a `mailto:` CTA. The mailing-list form posts to an EmailOctopus endpoint. **EmailOctopus reCAPTCHA must stay disabled** — when enabled the endpoint rejects submissions from custom forms (`INVALID_PARAMETERS`). The honeypot field (`field_1` by default) and EmailOctopus's server-side filtering remain active.

## Before launch

- [ ] Delete `src/pages/foundation.astro`
- [ ] Confirm `Info@saroscreative.ca` is the final public address
- [ ] Replace lead-image `alt` placeholder text on each project in `src/data/projects.ts`
- [ ] If EmailOctopus double opt-in is ever turned on, update the success copy in `src/scripts/mailing-list.ts`
- [ ] Remove `src/scripts/tweak-panel.ts`, `src/scripts/detail-crop-panel.ts`, and the `tweakpane` devDependency once look + crops are locked
- [ ] Collapse baked Tweakpane values (`--photo-w`, `--photo-gap`, `scalePeak`, `spread`) back to responsive `clamp()` defaults
