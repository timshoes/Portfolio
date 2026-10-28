# Tim Howes portfolio — timhowes.me

Static HTML site: no build step, no framework. Pages are `index.html` (home: the story), `work.html`
(all projects by category), `about.html` and `work/*.html` (one case study each);
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
- Every page repeats the same `<head>` and header/footer markup; when changing one, change all 17
  pages (`work/ruscella-immersive-website.html` is only a redirect).
- The home page tells Tim's story as five "waves" of technology (web, mobile and product, Agile teams,
  immersive, generative AI), one standout project each, then two ways in: hire Tim, or work with him
  through Ruscella Immersive. New projects go on `work.html`; only feature one on the home page if it
  is the best example of its wave. Use facts from the case studies; never invent results.
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
