# UI reskin: cool-neutral instrument palette, shadcn-style tokens

## Intent

Tether's UI currently reads as a generic AI-generated SaaS dashboard: warm
cream background, one blanket border-radius + soft shadow on every card
regardless of hierarchy, and tracked-out ALL-CAPS monospace "eyebrow"
labels on nearly every section header. The user wants a better look and
asked to borrow the look of a default shadcn/ui theme. This restyles the
existing UI to read as what it actually is — a solo developer's local
agent-harness "Flight Recorder" instrument — rather than a templated
dashboard.

## Goals

- Replace the color, type, and elevation rules in
  `server/src/templates/shell.ts` with a deliberately-chosen token set
  (cool neutral base + one accent), applied consistently across every
  existing page (rail, Detail/Flight Recorder, Harness, Analytics).
- Adopt shadcn's *token system* (the CSS-variable naming/structure) without
  adopting shadcn/ui itself.
- Reserve monospace for actual measurements and identifiers (durations,
  costs, token counts, trace ids) — never for structural labels. Section
  labels become sans, sentence case, no letter-tracking.
- Replace the single blanket radius/shadow with a hierarchy: flat/sharp for
  dense telemetry strips, a little rounding (6px) only on discrete panels,
  shadows reserved for true overlays (modals), not under every card.

## Non-goals

- No new features, routes, or data. Pure restyle of existing pages.
- No layout/IA changes beyond what the new type/spacing rules require
  (rail + tabbed main panel stays as-is).
- No adoption of React, Tailwind, a bundler, or shadcn's component library.
  Tether stays zero-build: hand-written CSS custom properties and the
  existing vanilla-JS client router.
- No change to the plugin iframe contract (plugins read the same CSS
  custom properties as today; a well-behaved plugin re-themes for free).

## Anti-goals

- Must not regress dark mode, the theme toggle, or any existing test
  (`server/test/*.test.js`, 388 passing as of this doc).
- Must not reintroduce the exact clichés being removed (warm cream bg,
  uniform radius+shadow, decorative uppercase-mono labels) anywhere in the
  new rules.

## Constraints

- Zero-build: everything lives in `server/src/templates/shell.ts` (global
  CSS + tokens) and whatever template/`static/app.ts` selectors reference
  removed classes (e.g. the uppercase-eyebrow styling). No new dependency,
  no font file fetch — keep the system-sans stack; only token *values*
  change, not the font-loading strategy.
- Must keep both light and dark themes, switched the same way as today
  (`prefers-color-scheme` + `data-theme` override).

## Approach

Approved by the user in conversation, no alternatives remaining open:
restyle in place, do not adopt shadcn/ui's React/Tailwind stack.

## Design

**Color** (replaces the current `#F7F6F2` warm-cream / teal-accent set):

| token | light | dark |
|---|---|---|
| `--bg` | `#F4F5F7` | `#0B0D12` |
| `--panel` | `#FFFFFF` | `#12151B` |
| `--panel-2` | `#EEF0F3` | `#171B22` |
| `--line` | `#E1E4E9` | `#242932` |
| `--line-strong` | `#D2D6DD` | `#323945` |
| `--ink` | `#16181D` | `#E7E9EE` |
| `--ink-2` | `#585F6B` | `#9BA2B0` |
| `--ink-3` | `#8D93A1` | `#646B79` |
| `--accent` | `#2F6FED` | `#5B9DFF` |
| `--accent-ink` | `#1E4FD1` | `#8FC3FF` |
| `--accent-wash` | `rgba(47,111,237,0.10)` | `rgba(91,157,255,0.14)` |

Accent is a cool instrument-blue (oscilloscope/radar-HUD cyan-blue),
replacing the current teal. Revised during implementation from an
initially-proposed amber: `shell.ts` already defines a full semantic
verdict palette — `--met` (green), `--partial` (gold/amber,
`#C08810`/`#D9A21B`), `--failed` (red), `--stuck` (orange) — and an
amber accent would have sat almost on top of `--partial`'s hue, making
an active tab or selected row look like a "partially succeeded" verdict
badge. Blue sits outside that entire warm cluster, so the rule is: warm
hues are reserved for verdict/status semantics, the sole UI accent is
cool, and the two are never confused. `--met`/`--partial`/`--failed`/
`--stuck` and their `-wash` variants are unchanged by this doc.

**Type:**

- Keep the existing system-sans stack (`--sans`) for all UI chrome —
  no new font load.
- Keep the existing monospace stack (`--mono`) but narrow its job: only
  for numeric/identifier data (durations, costs, token counts, trace ids,
  timestamps) with `font-variant-numeric: tabular-nums` where it already
  applies.
- Remove `text-transform: uppercase` + `letter-spacing` from structural
  labels (`.goal-eyebrow`, `.h-group-label`, `.gm .k`, `.verdict-badge .lab`,
  `.conf-row`, `.accrue .k`, and any sibling rules of the same shape found
  during implementation) — these become sans, sentence case, no tracking.
  Grep for `text-transform: uppercase` in `shell.ts` to find the full set.

**Layout / elevation:**

- `--radius` drops from `12px` to `6px` for discrete panels/cards.
- Dense telemetry strips (the run metrics row, rail rows, stat tiles) go
  flat: no radius, no shadow, hairline `--line` dividers between cells
  instead of boxed-and-shadowed individual cards.
- `box-shadow` (`--shadow`) is reserved for true overlays only (if/when
  one exists — e.g. a future modal); remove it from `.card`, `.mission`,
  `.trail-card`, `.widget-card` and similar in-flow panels.

## What's left to the builder (this session, implementing directly)

- Full enumeration of every selector in `server/src/templates/shell.ts`
  (and any other template file with inline styles) using the removed
  patterns — the list above is representative, not exhaustive.
- Picking the exact `--shadow` fallback value (or removing the token
  entirely if nothing legitimately uses it after the pass). Confirmed
  during implementation: no modal/overlay exists in the codebase today
  (`grep -rl "modal\|overlay" server/src/` is empty), so every current
  `var(--shadow)` usage is an in-flow panel and gets removed; the token
  stays defined, reserved, unused for now.
- Confirmed during implementation: `--met`/`--partial`/`--failed`/
  `--stuck` already exist as a distinct semantic palette, separate from
  `--accent` (see Color section above) — no new token needed.
- Confirmed during implementation: no hardcoded old color values
  (`#0FA6B4`, `#19C6D8`, `#F7F6F2`, `#0E1116`) exist anywhere in
  `server/src/` outside `shell.ts` — the token swap is fully contained
  to that one file.
- Visual pass across all three existing views (Detail, Harness, Analytics)
  plus the rail, in both themes, via screenshots, before calling this
  done.
- Full `npm run build && npm test` in `server/` must pass unchanged.
