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

Each mode comes with and without the syrup pour; the syrup variants also have an
animated pour (see Motion below).

| Mode | File | Use |
|------|------|-----|
| Hero (depth + syrup pour) | [`wafflestack-hero.svg`](wafflestack-hero.svg) · [`wafflestack-hero-1024.png`](wafflestack-hero-1024.png) · animated [`wafflestack-hero-animated.svg`](wafflestack-hero-animated.svg) | ≥ 48px: README headers, social cards, stickers, print |
| Hero, no syrup | [`wafflestack-hero-nosyrup.svg`](wafflestack-hero-nosyrup.svg) · [`wafflestack-hero-nosyrup-1024.png`](wafflestack-hero-nosyrup-1024.png) | Hero contexts where the pour competes with nearby accents or motion |
| Flat (solid color) | [`wafflestack-flat.svg`](wafflestack-flat.svg) · [`wafflestack-flat-512.png`](wafflestack-flat-512.png) | ≤ 48px and UI chrome: favicons, nav bars, list rows |
| Flat + syrup | [`wafflestack-flat-syrup.svg`](wafflestack-flat-syrup.svg) · [`wafflestack-flat-syrup-512.png`](wafflestack-flat-syrup-512.png) · animated [`wafflestack-flat-syrup-animated.svg`](wafflestack-flat-syrup-animated.svg) | Flat contexts that can afford the accent — the animated one is the repo README header |
| Mono (single ink, closed paths) | [`wafflestack-mono.svg`](wafflestack-mono.svg) | Engraving, embossing, laser cutting, 3D-printed badges |
| Mono + syrup | [`wafflestack-mono-syrup.svg`](wafflestack-mono-syrup.svg) · animated [`wafflestack-mono-syrup-animated.svg`](wafflestack-mono-syrup-animated.svg) | Single-ink contexts that keep the pour (screen use; the animated one for dark-mode splash) |

Ready-made crops:

- [`wafflestack-avatar-512.png`](wafflestack-avatar-512.png) / [`wafflestack-avatar-syrup-512.png`](wafflestack-avatar-syrup-512.png) — flat mark (plain / with pour) on cocoa `#241204`, for circular avatar crops (GitHub org/app)
- [`wafflestack-favicon-32.png`](wafflestack-favicon-32.png) / [`wafflestack-favicon-16.png`](wafflestack-favicon-16.png) — favicon sizes (at 16px the grid drops to 2×2); syrup variants [`wafflestack-favicon-syrup-32.png`](wafflestack-favicon-syrup-32.png) / [`wafflestack-favicon-syrup-16.png`](wafflestack-favicon-syrup-16.png)
- [`wafflestack-social.png`](wafflestack-social.png) — 2:1 social/OG card for the GitHub repo (source: [`social-preview.html`](social-preview.html)); animated sibling [`wafflestack-social-animated.svg`](wafflestack-social-animated.svg) for embed contexts that accept SVG (GitHub's OG preview itself is raster-only)

## Motion

The `*-animated.svg` files animate the syrup pour with inline SMIL — fully
self-contained (no scripts, no external refs), so they render animated anywhere
plain SVG embeds do, including GitHub READMEs. Splash moments only: one animated
mark per view, never in UI chrome or docs an agent has to parse.

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
