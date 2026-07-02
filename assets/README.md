# WaffleStack brand

WaffleStack is part of the **WaffleWorks** family (3D printing · electronics · software).
The family system is one shared waffle-iron glyph; each product adds a small geometric
modifier — Wafflenet links the pockets into a network, Wafflebot gets an antenna and eyes,
and **WaffleStack layers the irons into a stack**. Playful but contained: the mark carries
the personality, everything around it stays calm.

Source: Claude Design project *"WaffleWorks brand extension"* (system v1, locked 2026-07).

## The mark

Three modes, one glyph. Icons only — **no lockups**; the product name is set nearby in
Baloo 2 (see Type below).

| Mode | File | Use |
|------|------|-----|
| Hero (depth + syrup pour) | [`wafflestack-hero.svg`](wafflestack-hero.svg) · [`wafflestack-hero-1024.png`](wafflestack-hero-1024.png) | ≥ 48px: README headers, social cards, stickers, print |
| Flat (solid color) | [`wafflestack-flat.svg`](wafflestack-flat.svg) · [`wafflestack-flat-512.png`](wafflestack-flat-512.png) | ≤ 48px and UI chrome: favicons, nav bars, list rows |
| Mono (single ink, closed paths) | [`wafflestack-mono.svg`](wafflestack-mono.svg) | Engraving, embossing, laser cutting, 3D-printed badges |

Ready-made crops:

- [`wafflestack-avatar-512.png`](wafflestack-avatar-512.png) — flat mark on cocoa `#241204`, for circular avatar crops (GitHub org/app)
- [`wafflestack-favicon-32.png`](wafflestack-favicon-32.png) / [`wafflestack-favicon-16.png`](wafflestack-favicon-16.png) — favicon sizes (at 16px the grid drops to 2×2)
- [`wafflestack-social.png`](wafflestack-social.png) — 2:1 social/OG card for the GitHub repo (source: [`social-preview.html`](social-preview.html))

## Palette

| Hex | Name | Role |
|-----|------|------|
| `#5B2B0E` | Ink | Outlines, display text on light |
| `#F5C752` | Golden | Waffle top; accent text on dark |
| `#DE8127` | Pocket | Waffle pockets, warm mid-accent |
| `#F08A1D` | Syrup | The accent: CTAs, active states, the pour |
| `#FFF3DC` | Cream | Text on dark; light surfaces |
| `#241204` | Cocoa | Dark surfaces, terminal blocks |

Supporting tones: `#FFF7E8` warm paper (light panels) · `#1A0D03` deep cocoa (dark page bg) ·
`#E4A93D` / `#D0902B` under-waffle shading (in the SVGs) · `#E8891C` / `#B06A1A` gold accents ·
`#5C4630` / `#3A2410` body text on light · `#A88B67` / `#C9A87C` muted captions.

## Type

- **Display — Baloo 2**: headlines and product names. Product names are always Baloo 2 **800**.
- **UI & body — Outfit**: everything that isn't a headline or code.
- **Code — JetBrains Mono**: CLI, config, terminal blocks (golden `#F5C752` on cocoa `#241204`, prompt `$` in `#E8891C`).

All three are on Google Fonts.

## Voice

Controlled fun. Waffle metaphors live in taglines, headers, and splash moments — never in
error messages, reference docs, or anything an agent has to parse.

- Tagline: **"One batter, every repo."** (one canonical source, rendered into each project)
- Family line: *"agentic dev harness — irons all the way down"*
- Orchestration story: *"plans in, PRs out"*

## CLI waffle

Box-drawing glyph for terminal splash moments (golden on cocoa), name and version alongside:

```
┏━┳━┳━┓
┣━╋━╋━┫   wafflestack v0.x.y
┣━╋━╋━┫   one batter, every repo
┗━┻━┻━┛
```
