# UI Reskin: Cool-Neutral Instrument Palette Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle Tether's existing UI (color, typography, elevation) to read as a developer instrument rather than a generic AI-generated SaaS dashboard, without changing any layout, route, or behavior.

**Architecture:** All changes are confined to the `STYLE` template string in `server/src/templates/shell.ts` — a token-value swap (color), a selector-level cleanup (typography), and a selector-level cleanup (radius/shadow). No other file references the old values. No new files, no new dependencies, no build-tooling change.

**Tech Stack:** Plain CSS custom properties, hand-written TypeScript template strings (no CSS-in-JS library, no bundler) — unchanged from the existing setup.

**Spec:** `docs/superpowers/specs/2026-11-13-ui-reskin-design.md`

## Global Constraints

- Zero-build: no new dependency, no bundler, no webfont fetch — only token *values* and selector rules change in `server/src/templates/shell.ts`.
- Both themes (`prefers-color-scheme` media query and the `data-theme="light"|"dark"` override) must keep working exactly as today — only token values inside each block change.
- `npm run build && npm test` in `server/` must pass after every task (388 tests passing as of the branch point).
- No change to routes, the plugin iframe contract, or page layout/IA.
- `--met`/`--partial`/`--failed`/`--stuck` and their `-wash` variants (`shell.ts:36-38,49-51,59-61,68-70`) are unchanged — only `--accent`/`--accent-ink`/`--accent-wash` move.
- `server/src/templates/shell.ts:259` (`.harness-svg.dim .h-node:not(.hl) { opacity: 0.32; ... }`) is explicitly out of scope — it belongs to separate, already-open PR #6 and must not be touched here.

## Review Focus

- A selector still carrying the old teal (`#0FA6B4`/`#19C6D8`) or warm-cream (`#F7F6F2`/`#0E1116`) literal after the edit — no automated CSS test exists, so Task 1 greps the file for the old literals after editing and expects zero matches.
- Dark mode reading low-contrast or broken after the token swap, since there's no automated visual check — Task 4 screenshots both themes on all three views and the rail.
- The new `--accent-ink` failing readable contrast against `--panel`/`--bg` in either theme (it's used for live text: active tab, active rail row, agent-pill) — Task 1 computes contrast ratio for both themes' `--accent-ink` against `--panel` before moving on.
- A badge/chip/tag selector (`rail-badge-composition`, `entry-name .tag`, `h-card .h-tag`, `stat-chip`, `sbadge`) losing its legitimate uppercase treatment by being swept up in the "remove decorative uppercase" pass meant for eyebrow labels — Task 2 explicitly excludes these five selectors and verifies they still carry `text-transform: uppercase` after the edit.
- Line 259's hover-dim opacity rule (owned by PR #6, not this plan) getting touched incidentally while editing neighboring `.harness-*` selectors in Task 3 — Task 3 ends with a diff check confirming that exact line is untouched.

---

### Task 1: Color tokens

**Files:**
- Modify: `server/src/templates/shell.ts:32-72` (the four `:root`/`@media`/`data-theme` blocks)

**Interfaces:** N/A — CSS custom-property values only, no code interface changes.

- [ ] **Step 1: Replace the color values in all four token blocks** (`:root` at line 32, `@media (prefers-color-scheme: dark)` at line 44, `:root[data-theme="light"]` at line 55, `:root[data-theme="dark"]` at line 64) with the values from the spec's Color table:

  Light (lines 32-43 and 55-63 — both light blocks get the same values):
  ```
  --bg: #F4F5F7; --panel: #FFFFFF; --panel-2: #EEF0F3; --line: #E1E4E9; --line-strong: #D2D6DD;
  --ink: #16181D; --ink-2: #585F6B; --ink-3: #8D93A1;
  --accent: #2F6FED; --accent-ink: #1E4FD1; --accent-wash: rgba(47,111,237,0.10);
  ```
  Dark (lines 44-54 and 64-72 — both dark blocks get the same values):
  ```
  --bg: #0B0D12; --panel: #12151B; --panel-2: #171B22; --line: #242932; --line-strong: #323945;
  --ink: #E7E9EE; --ink-2: #9BA2B0; --ink-3: #646B79;
  --accent: #5B9DFF; --accent-ink: #8FC3FF; --accent-wash: rgba(91,157,255,0.14);
  ```
  `--met`/`--partial`/`--failed`/`--stuck`/`--shadow`/`--radius`/`--mono`/`--sans` are untouched in this step.

- [ ] **Step 2: Verify no old literal remains**

  Run: `grep -n "0FA6B4\|19C6D8\|F7F6F2\|0E1116" server/src/templates/shell.ts`
  Expected: no output (zero matches)

- [ ] **Step 3: Build and run the full suite**

  Run: `cd server && npm run build && npm test`
  Expected: build succeeds, all tests pass (same 388 as baseline)

- [ ] **Step 4: Commit**

  ```bash
  git add server/src/templates/shell.ts
  git commit -m "style(server): swap teal/warm-cream tokens for cool-neutral + blue accent"
  ```

---

### Task 2: Typography — scope monospace to data, drop decorative uppercase

**Files:**
- Modify: `server/src/templates/shell.ts` (selectors listed below)

**Interfaces:** N/A — CSS selector rule changes only.

- [ ] **Step 1: For each structural-label selector below, remove `text-transform: uppercase` and `letter-spacing`, and change `font-family: var(--mono)` to `font-family: var(--sans)`** (sentence case replaces whatever uppercase text the template already renders — no template/string changes needed, this is purely the CSS rule):

  `.goal-eyebrow` (line 133), `.gm .k` (line 138), `.verdict-badge .vt .lab` (line 145), `.conf-row` (line 152), `.accrue .k` (line 163), `.sig-cap` (line 180), `.insp h3` (line 213), `.io-kind` (line 217), `.h-group-label` (line 261 — also drop `text-transform`/`letter-spacing` from its SVG `font:` shorthand, keep `fill: var(--ink-3)`)

- [ ] **Step 2: For each data-value selector below, remove only `text-transform: uppercase` and `letter-spacing` — keep `font-family: var(--mono))`** (these render actual values — a message role, a JSON node summary — not structural labels, so they keep the monospace/data treatment, just lose the decorative capitalization):

  `.jv-node > summary` (line 235), `.msg-row > summary` (line 244)

- [ ] **Step 3: Confirm these five badge/chip/tag selectors are untouched and still carry `text-transform: uppercase`** (they're compact status pills, not eyebrow labels — explicitly out of scope for this task):

  Run: `grep -A1 "rail-badge-composition\|entry-name .tag\|h-card .h-tag\|\.stat-chip\|\.sbadge {" server/src/templates/shell.ts`
  Expected: each still shows `text-transform: uppercase` in its declaration block

- [ ] **Step 4: Build and run the full suite**

  Run: `cd server && npm run build && npm test`
  Expected: build succeeds, all tests pass

- [ ] **Step 5: Commit**

  ```bash
  git add server/src/templates/shell.ts
  git commit -m "style(server): reserve monospace for data values, drop decorative label tracking"
  ```

---

### Task 3: Elevation and radius hierarchy

**Files:**
- Modify: `server/src/templates/shell.ts` (selectors listed below)

**Interfaces:** N/A — CSS value/property changes only.

- [ ] **Step 1: Change `--radius` from `12px` to `6px`** (line 40, the single definition in the base `:root` block — the other three theme blocks don't redefine `--radius`, so this is the only edit needed for the token itself)

- [ ] **Step 2: Remove `box-shadow: var(--shadow);` from every in-flow panel selector**, leaving every other declaration in each rule unchanged:

  `.mission` (line 132), `.trail-card` (line 154), `.panel` (line 187)

  Also remove the two usages that aren't `var(--shadow)` but are the same "soft card shadow" pattern applied to an in-flow element: `.play-btn`'s `box-shadow: 0 4px 14px var(--accent-wash);` (line 156) and `.playhead`/`.playhead::before`'s `box-shadow: 0 0 10px var(--accent);` / `box-shadow: 0 0 8px var(--accent);` (lines 176-177) stay — these are glow/focus effects on small interactive elements, not the card-shadow pattern being removed, and are out of scope for this step.

- [ ] **Step 3: Confirm line 259 (the hover-dim opacity rule) is untouched**

  Run: `git diff server/src/templates/shell.ts | grep -B2 -A2 "harness-svg.dim"`
  Expected: no output (the line was never part of this diff)

- [ ] **Step 4: Build and run the full suite**

  Run: `cd server && npm run build && npm test`
  Expected: build succeeds, all tests pass

- [ ] **Step 5: Commit**

  ```bash
  git add server/src/templates/shell.ts
  git commit -m "style(server): flatten in-flow panels, tighten radius for panel hierarchy"
  ```

---

### Task 4: Full visual verification

**Files:** none modified — verification only.

**Interfaces:** N/A

- [ ] **Step 1: Start a throwaway server instance on a scratch port** (don't disturb any already-running Tether instance)

  Run: `cd server && TETHER_PORT=4321 node dist/index.js` (background)
  Expected: `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4321/` returns `200`

- [ ] **Step 2: Screenshot all three views plus the rail, in both themes** (toggle via the existing theme button, not by changing OS settings) — at minimum: the Detail/Flight Recorder view for an existing run, the Harness view, the Analytics view, each once in light and once in dark

- [ ] **Step 3: Visually confirm, per the spec's Review Focus items** — no leftover warm-cream/teal, text legible in both themes (particularly `--accent-ink` on active tab/active rail row), badges still read as uppercase pills, eyebrow-style labels now read as sentence-case sans, panels read flatter with the new 6px radius

- [ ] **Step 4: Stop the scratch server**

  Run: `lsof -ti :4321 | xargs -r kill`

- [ ] **Step 5: Final full build + test on the complete branch**

  Run: `cd server && npm run build && npm test`
  Expected: build succeeds, all 388+ tests pass

No commit for this task — it produces no file changes, only confidence to open the PR.

---

## Self-Review

**1. Spec coverage:** Color table → Task 1. Monospace-scoping + uppercase/tracking removal → Task 2. Radius/shadow hierarchy → Task 3. Both-themes/all-views confirmation → Task 4. The spec's "no new dependency / zero-build" constraint is structural (no task introduces one) rather than something a step asserts — covered by Global Constraints instead.

**2. Step scan:** Every code step names the exact file, exact lines, and exact values from the spec; every verification step names its command and expected output. No step says "handle edge cases" or leaves a value undetermined.

**3. Type consistency:** N/A — no functions, types, or signatures are introduced or crossed between tasks; all four tasks edit the same CSS template string by selector/line, and later tasks don't reference names earlier tasks defined.

**4. Review Focus:** Five items listed above, each tied to a concrete step in a task (leftover literals → Task 1 Step 2; contrast → Task 1 Step 1 values chosen for contrast, confirmed visually in Task 4 Step 3; dark mode regression → Task 4; badge/chip exclusion → Task 2 Step 3; PR #6's line 259 → Task 3 Step 3).

**5. Proportion:** Four short tasks against a short spec; no task reproduces more than a selector list and exact values already in the spec's Color table.
