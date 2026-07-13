# Marcus Strauss — Portfolio

Personal portfolio for Marcus Strauss. A single-page site with a persistent
animated WebGL background and foreground sections that crossfade in place.

Live sections: **Home · Work · Projects · About · Contact**

## Tech stack

| Layer | Choice |
| :-- | :-- |
| Framework | [Astro](https://astro.build) 6 (static output) |
| Styling | Tailwind CSS v4 (CSS-first config in `src/styles/global.css`, no `tailwind.config.js`) |
| Animation | GSAP 3 + the `SplitText` plugin |
| Background | Custom raw-WebGL renderer (no Three.js) — fragment shader + GLSL noise |

Requires Node `>=22.12.0`.

## Commands

| Command | Action |
| :-- | :-- |
| `npm install` | Install dependencies |
| `npm run dev` | Dev server at `localhost:4321` |
| `npm run build` | Production build to `./dist/` |
| `npm run preview` | Preview the production build locally |
| `npx astro check` | TypeScript / template diagnostics |

There is no test suite. Verification = `npm run build` passing + manual visual QA.
`astro build` does not run `astro check` — run it separately.

## How it works

One page (`src/pages/index.astro`) holds every section stacked in a fixed content
area; only one is visible at a time. Navigation is hash-based (`#home`, `#work`,
`#projects`, `#about`, `#contact`) — clicking a sidebar link (or a hash change)
crossfades sections with GSAP. No page reloads, no router.

A preloader covers the page on first load; once ready it lifts and the **reveal
animation** plays (sidebar + the initial section's text/items animate in via
SplitText). The reveal runs **once, on initial load only** — section switches and
slider changes are plain opacity crossfades.

**Background** — a full-screen WebGL canvas (`src/background/BackgroundScene.js`)
renders a shader-driven gradient/noise field that reacts to the pointer. It
degrades gracefully: if WebGL is unavailable the scene is skipped and a solid
background color remains. The render loop starts at reveal time so its first-frame
warm-up happens hidden behind the preloader.

## Structure

```
src/
├── pages/
│   └── index.astro          # the page: preloader, layout, routing, reveal orchestration
├── components/
│   ├── Nav.astro            # sidebar: identity + nav links (source of truth for sections)
│   ├── Work.astro           # client-site slider (screenshot + details, one at a time)
│   ├── Projects.astro       # personal-project slider (title + description + tags)
│   ├── About.astro
│   └── Contact.astro
├── scripts/
│   ├── revealMotion.ts      # SplitText reveal engine — load-only; exposes show/reveal/reset
│   └── titleCycler.ts       # cycles the rotating job title under the name
├── background/
│   ├── BackgroundScene.js   # raw-WebGL renderer + pointer interaction + lifecycle
│   ├── noise.glsl
│   └── shaders/             # background.vert / background.frag
└── styles/
    └── global.css           # Tailwind v4 @theme tokens + reveal base styles
public/
└── images/                  # Work screenshots (saros-creative.png, luke-chin.png)
```

## The two sliders (Work & Projects)

Both cycle one entry at a time with the same controls: bottom-left arrows,
left/right keyboard keys (only while their section is active), scroll wheel, and
touch swipe. Entries are plain data arrays in each component's frontmatter — add
or edit a row there. The counter (`NN / NN`) derives from the array length.

`Work` entries reference a screenshot in `public/images/`. To swap a screenshot,
drop a new file at the same path. Capture the page content (not the whole browser
window) to avoid a black chrome bar at the top.

## Adding / changing a section

Sections are wired in three places — keep them in sync:

1. `src/components/Nav.astro` — the `links` array (label + id, in display order).
2. `src/pages/index.astro` — import + place the component, and add the id to the
   `valid` list in `getTargetSection()`.
3. The component itself — give the root `<section>` `id`, `class="section absolute
   inset-0 opacity-0 pointer-events-none"`, and `data-reveal` on the elements that
   should animate in on load.
