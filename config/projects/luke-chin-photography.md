# Luke Chin — Photography Portfolio

A minimal, image-first photography portfolio for photographer **Luke Chin**. A
dark, near-black canvas with sparse typography — the photos do all the talking.

Live: https://luke-chin-website.marcus-strauss.workers.dev

## Stack

| Thing | Detail |
|---|---|
| Framework | [Astro](https://astro.build) (static output + on-demand routes) |
| Styling | Tailwind v4 |
| Animation | GSAP (image crossfade only) |
| Gallery JS | Vanilla, single file — no framework islands |
| CMS | [Keystatic](https://keystatic.com) (cloud storage) |
| Deployment | Cloudflare **Workers** (Workers Builds + Static Assets) |

React is present **only** for the Keystatic admin UI — the gallery stays vanilla.

## How it works

A single-page app driven by one `index.astro`. All project and curated homepage
data is read at build time and serialized into a JSON island the browser parses
once. Vanilla JS (`src/scripts/gallery.ts`) owns all state (active project,
active slide) and is the single source of truth — every change routes through an
internal `render()` that crossfades the image and dispatches a `gallery:change`
event for dependent UI.

The URL syncs to the active section via the History API (`/`, `/<slug>`,
`/info`) with no page reloads. Hard loads of those URLs are served `index.html`
by the Worker's SPA fallback; the client routes from the path. `/keystatic` and
`/api/*` are real SSR routes, exempted from the fallback.

## Content pipeline

Content is owned by **Keystatic** (`keystatic.config.ts`), not hand-edited:

1. A Node prebuild — `scripts/generate-gallery-content.mjs`, run via
   `predev`/`prebuild` — reads Keystatic content into
   `src/data/gallery-content.json` (gitignored). It can't run inside the
   Cloudflare bundle (workerd has no `node:fs`).
2. `src/data/projects.ts` (server-only) imports that JSON, resolves each image
   through Astro's asset pipeline, and exports `projects` + `homepageImages`.
3. `index.astro` serializes the result into the JSON island. **Never** import
   `projects.ts` from client code.

- Content YAML: `src/content/` (`homepageImages.yaml`, `projects/<slug>.yaml`)
- Images: `src/assets/images/<slug>/`, plus `src/assets/images/home/` for the
  curated landing set
- Admin UI: `/keystatic` (SSR via the Worker)

## Develop

```bash
npm install
npm run dev        # runs gen:content first, then astro dev
```

| Script | Does |
|---|---|
| `npm run dev` | Generate content + start the dev server |
| `npm run build` | Generate content + build for production |
| `npm run preview` | Preview the production build |
| `npm run gen:content` | Regenerate `gallery-content.json` from Keystatic |

Requires Node `>=22.12.0`.

## Deploy

Cloudflare **Workers** (not Pages), via Workers Builds connected to GitHub.

- Build: `npm run build`
- Deploy: `npx wrangler deploy` — picks up `.wrangler/deploy/config.json`
  (redirects to the adapter-generated `dist/server/wrangler.json`)
- `wrangler.jsonc` is the user-editable seed the adapter merges from. It sets
  `nodejs_compat`, SPA deep-link fallback (`not_found_handling`), and
  `run_worker_first` for `/keystatic*`, `/api/keystatic*`, and `/api/contact`
  so the Static Assets SPA fallback doesn't shadow those SSR routes.

## Contact form

The INFO overlay's contact form POSTs to `/api/contact` (SSR), which forwards
server-side to an n8n webhook. Going through the Worker sidesteps browser CORS
and keeps the webhook URL out of the page source.

## Layout

```
LUKE CHIN                  WORK ▾    INFO
  [← arrow]   [full-bleed image]   [→ arrow]
  [thumbnail strip — synced to active slide]
```

- **LUKE CHIN** → curated homepage set
- **WORK** → dropdown of project titles → routes to `/<slug>`
- **INFO** → overlay (about + contact form), routed as `/info`

## Conventions

- Tailwind utilities only — no other CSS frameworks
- No Alpine/Vue/Svelte islands; React is Keystatic-only
- No scroll-driven animations, no lightbox libraries (the full-bleed view IS the
  lightbox)
- One feature at a time; see `CLAUDE.md` for the full design brief and the
  load-bearing Keystatic/Astro 7 workarounds before changing the CMS wiring.
