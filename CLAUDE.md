# Tim Howes portfolio — timhowes.me

Static HTML site: no build step, no framework. Pages are `index.html` (home), `work.html` (all projects,
filterable by category), `about.html` and `work/*.html` (one case study each);
shared styles in `css/site.css`; scripts in `js/`. Brand tokens are the CSS custom properties at the top
of `site.css` (sunset palette, Shrikhand display face, Work Sans body).

## Where the site lives
- **GitHub is the source of truth.** Do not edit the old "Tim Howes Portfolio" claude.ai artifact; changes
  made there never reach the live site.
- **Netlify** deploys from this repo. `main` = production at https://timhowes.me. Every push to `main`
  goes live within about a minute, so only merge finished work into `main`.
- Experiments go on their own branch (e.g. `water`). Netlify branch deploys give each one a preview at
  `<branch>--<netlify-project>.netlify.app`. Tim tests on his phone there before anything is merged.

## Working rules
- Keep changes surgical and match the existing hand-written HTML/CSS style.
- Every page repeats the same `<head>` and header/footer markup; when changing one, change all 19 pages.
- Home page order: 360 hero (card under the video; buttons to Work and About), Leadership, then one image
  per category (Brand, Product & UX, Web, Immersive, AI & Rapid Prototyping) linking to `work.html#<category>`.
- `work.html` lists every project; its filter shows one category at a time from the URL hash. The
  "Next project" chain on case studies follows the same order. Use facts from the case studies; never
  invent results.
- Brand case studies share one simple layout (AccessVR is the template): top, Challenge/Solution, My role,
  page-through Brand guidelines (one image per page), one Highlight image, no Results. The Ri guideline
  pages are rendered from an HTML source in Ri fonts and colours (Bodoni Moda, Inter; black, #330066, #FFC31A).
- Page-through viewers: `<div class="flip" data-flip>` with one `<figure>` per page, plus `js/flip.js`.
- Links between pages are relative (`../` from `work/`).
- Respect `prefers-reduced-motion` in anything animated.
- Commit with clear messages and push; tell Tim the preview or live URL to check.

## Ocean water layer (`js/water.js`)
- WebGL shallow-water simulation fixed to the viewport, under the header (`z-index` 50 vs header 60),
  `pointer-events: none` so the page stays clickable.
- Reacts to cursor (only over the water, stronger with speed), touch, scroll (slosh then settle) and phone
  tilt. Volume is constant: laid flat, the water spreads into a thin clear sheet.
- iPhone motion needs a tap to grant permission (the "Tilt your phone" chip). Motion sensors only work
  over HTTPS on the real site, not inside claude.ai artifact previews.
- Defaults in the object `S` are Tim's tuned settings. `data-lab` on the script tag shows the tuning
  panel; only `work/water-lab.html` (the Water Lab case study) has it. A visitor's own settings are saved
  in their browser (`localStorage` key `water-lab`) and applied on every page.
- The old image-based page-transition wave (`wave.js`, `.wash`) was removed on purpose; don't bring it back.
