import type { RegistryEntry } from "../registry.js";

export type ShellView = "detail" | "harness" | "analytics";

export interface ShellState {
	view: ShellView;
	traceId?: string;
}

export interface PluginOption {
	slug: string;
	name: string;
	entry: string;
}

export interface SlotPickerOptions {
	installed: PluginOption[];
	registry: RegistryEntry[];
}

function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

/** Shown in `#content` for any unknown traceId, both as a full shell-wrapped page (direct
 * navigation) and as a raw fragment body (client-side navigation via /fragments/*). */
export function renderNotFoundPanel(): string {
	return `<p class="empty">Run not found.</p>`;
}

const STYLE = `
	:root {
		--bg: #F7F6F2; --panel: #FFFFFF; --panel-2: #FBFAF7; --line: #E6E3DB; --line-strong: #D6D2C7;
		--ink: #1B1F24; --ink-2: #565C64; --ink-3: #8A8F97;
		--accent: #0FA6B4; --accent-ink: #0B7C87; --accent-wash: rgba(15,166,180,0.10);
		--met: #2FA24A; --partial: #C08810; --failed: #DC4A38; --stuck: #E0761A;
		--met-wash: rgba(47,162,74,0.12); --partial-wash: rgba(192,136,16,0.12); --failed-wash: rgba(220,74,56,0.12);
		--stuck-wash: rgba(224,118,26,0.15);
		--shadow: 0 1px 2px rgba(20,24,28,0.05), 0 8px 24px rgba(20,24,28,0.06);
		--radius: 12px;
		--mono: ui-monospace, "SF Mono", "JetBrains Mono", "Cascadia Code", "Roboto Mono", monospace;
		--sans: -apple-system, "SF Pro Text", system-ui, "Segoe UI", Roboto, sans-serif;
	}
	@media (prefers-color-scheme: dark) {
		:root {
			--bg: #0E1116; --panel: #161B22; --panel-2: #1A2029; --line: #262D38; --line-strong: #333C49;
			--ink: #E8ECF1; --ink-2: #A3ACB8; --ink-3: #6C7683;
			--accent: #19C6D8; --accent-ink: #57DCEA; --accent-wash: rgba(25,198,216,0.12);
			--met: #3FB950; --partial: #D9A21B; --failed: #F0533F; --stuck: #F0871E;
			--met-wash: rgba(63,185,80,0.15); --partial-wash: rgba(217,162,27,0.15); --failed-wash: rgba(240,83,63,0.15);
			--stuck-wash: rgba(240,135,30,0.16);
			--shadow: 0 1px 2px rgba(0,0,0,0.4), 0 12px 32px rgba(0,0,0,0.4);
		}
	}
	:root[data-theme="light"] {
		--bg: #F7F6F2; --panel: #FFFFFF; --panel-2: #FBFAF7; --line: #E6E3DB; --line-strong: #D6D2C7;
		--ink: #1B1F24; --ink-2: #565C64; --ink-3: #8A8F97;
		--accent: #0FA6B4; --accent-ink: #0B7C87; --accent-wash: rgba(15,166,180,0.10);
		--met: #2FA24A; --partial: #C08810; --failed: #DC4A38; --stuck: #E0761A;
		--met-wash: rgba(47,162,74,0.12); --partial-wash: rgba(192,136,16,0.12); --failed-wash: rgba(220,74,56,0.12);
		--stuck-wash: rgba(224,118,26,0.15);
		--shadow: 0 1px 2px rgba(20,24,28,0.05), 0 8px 24px rgba(20,24,28,0.06);
	}
	:root[data-theme="dark"] {
		--bg: #0E1116; --panel: #161B22; --panel-2: #1A2029; --line: #262D38; --line-strong: #333C49;
		--ink: #E8ECF1; --ink-2: #A3ACB8; --ink-3: #6C7683;
		--accent: #19C6D8; --accent-ink: #57DCEA; --accent-wash: rgba(25,198,216,0.12);
		--met: #3FB950; --partial: #D9A21B; --failed: #F0533F; --stuck: #F0871E;
		--met-wash: rgba(63,185,80,0.15); --partial-wash: rgba(217,162,27,0.15); --failed-wash: rgba(240,83,63,0.15);
		--stuck-wash: rgba(240,135,30,0.16);
		--shadow: 0 1px 2px rgba(0,0,0,0.4), 0 12px 32px rgba(0,0,0,0.4);
	}

	* { box-sizing: border-box; }
	body { margin: 0; background: var(--bg); color: var(--ink); font-family: var(--sans); font-size: 14px; line-height: 1.5; -webkit-font-smoothing: antialiased; }

	.shell { display: flex; min-height: 100vh; }
	.rail-wrap { width: 260px; flex: none; border-right: 1px solid var(--line); background: var(--panel); display: flex; flex-direction: column; }
	.rail-brand { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 14px 16px; border-bottom: 1px solid var(--line); }
	.rail-brand .brand-name { font-weight: 640; letter-spacing: -0.01em; font-size: 15px; }
	.rail-home { color: var(--ink-2); text-decoration: none; font-size: 15px; }
	.rail-home:hover { color: var(--ink); }
	#rail { flex: 1; overflow-y: auto; padding: 6px; }
	.rail-row { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; border-radius: 8px; text-decoration: none; color: var(--ink); margin-bottom: 2px; }
	.rail-row:hover { background: var(--panel-2); }
	.rail-row-active { background: var(--accent-wash); }
	.rail-row-active .rail-goal { color: var(--accent-ink); }
	.rail-dot-goal { display: flex; align-items: center; gap: 7px; }
	.rail-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
	.rail-goal { font-size: 13px; font-weight: 560; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.rail-time { font-family: var(--mono); font-size: 10.5px; color: var(--ink-3); padding-left: 14px; }
	.rail-empty { color: var(--ink-3); font-size: 13px; padding: 10px; }
	.rail-row-composition .rail-goal { color: var(--ink-3); font-style: italic; }
	.rail-badge-composition { display: inline-flex; align-items: center; flex: none; font-family: var(--mono); font-size: 9px; font-weight: 700; letter-spacing: 0.02em; text-transform: uppercase; color: var(--ink-3); background: var(--panel-2); border: 1px solid var(--line); border-radius: 4px; padding: 1px 5px; }

	.main-wrap { flex: 1; min-width: 0; display: flex; flex-direction: column; }
	.tabbar { display: flex; align-items: center; gap: 10px; padding: 12px 20px; border-bottom: 1px solid var(--line); }
	.tab { font-size: 12.5px; color: var(--ink-2); text-decoration: none; padding: 6px 12px; border-radius: 999px; border: 1px solid var(--line); background: var(--panel); }
	.tab:hover { color: var(--ink); border-color: var(--line-strong); }
	.tab-active { color: var(--accent-ink); border-color: var(--accent); background: var(--accent-wash); }
	.tab-disabled { color: var(--ink-3); opacity: 0.5; }
	.iconbtn { margin-left: auto; width: 34px; height: 34px; border-radius: 9px; border: 1px solid var(--line); background: var(--panel); color: var(--ink-2); cursor: pointer; display: grid; place-items: center; transition: background .15s, color .15s; }
	.iconbtn:hover { color: var(--ink); background: var(--panel-2); }
	#content { flex: 1; max-width: 1280px; width: 100%; margin: 0 auto; padding: 20px clamp(14px, 3vw, 28px) 64px; overflow-y: auto; }

	.empty { color: var(--ink-3); font-size: 13px; }
	.note { color: var(--ink-3); font-size: 12.5px; margin: 0 0 20px; }
	.as-of { color: var(--ink-2); font-size: 13px; margin: 0 0 10px; }
	.card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 16px 18px; margin-bottom: 16px; }
	.widget-dashboard { margin-top: 16px; }
	.widget-dashboard-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
	.widget-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
	.widget-card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; }
	.widget-card-head { display: flex; align-items: center; justify-content: space-between; padding: 8px 10px; font-size: 12.5px; font-weight: 600; border-bottom: 1px solid var(--line); }
	.widget-remove { font: inherit; color: var(--ink-3); background: transparent; border: 0; cursor: pointer; font-size: 15px; line-height: 1; }
	.widget-frame { width: 100%; height: 240px; border: 0; display: block; }
	.widget-cell-small.widget-card { grid-column: span 1; }
	.widget-cell-medium.widget-card { grid-column: span 2; }
	.widget-cell-large.widget-card { grid-column: span 4; }
	#addWidgetPicker { font: inherit; font-size: 12px; color: var(--ink-2); background: var(--panel); border: 1px solid var(--line); border-radius: 999px; padding: 5px 10px; }
	.card-head h2 { font-size: 14px; margin: 0 0 10px; display: flex; align-items: center; gap: 8px; }
	.card-head .count { font-family: var(--mono); font-size: 11px; color: var(--ink-3); font-weight: 400; }
	.entries { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
	.entry { border-top: 1px solid var(--line); padding-top: 10px; }
	.entry:first-child { border-top: none; padding-top: 0; }
	.entry-name { font-weight: 600; font-size: 13.5px; }
	.entry-name .tag { font-weight: 400; font-size: 10.5px; color: var(--ink-3); text-transform: uppercase; letter-spacing: 0.04em; border: 1px solid var(--line); border-radius: 999px; padding: 1px 7px; margin-left: 6px; }
	.tag-dead { color: var(--failed); border: 1px solid var(--failed); }
	.entry-desc { color: var(--ink-2); font-size: 13px; margin-top: 2px; }
	.entry-tools { color: var(--ink-3); font-family: var(--mono); font-size: 11.5px; margin-top: 4px; }

	.mission { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow); padding: 18px 20px; display: grid; grid-template-columns: 1fr auto; gap: 24px; align-items: start; margin-bottom: 14px; }
	.goal-eyebrow { font-family: var(--mono); font-size: 11px; letter-spacing: 0.09em; text-transform: uppercase; color: var(--ink-3); display: flex; align-items: center; gap: 8px; margin-bottom: 7px; }
	.goal-eyebrow .agent-pill { color: var(--accent-ink); }
	.goal-title { font-size: clamp(18px, 2.4vw, 23px); font-weight: 620; letter-spacing: -0.015em; margin: 0; text-wrap: balance; line-height: 1.25; }
	.goal-meta { display: flex; gap: 16px; flex-wrap: wrap; margin-top: 12px; }
	.gm { display: flex; flex-direction: column; gap: 1px; }
	.gm .k { font-family: var(--mono); font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-3); }
	.gm .v { font-family: var(--mono); font-size: 14px; font-weight: 600; color: var(--ink); font-variant-numeric: tabular-nums; }

	.verdict { min-width: 210px; display: flex; flex-direction: column; gap: 12px; }
	.verdict-badge { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-radius: 11px; border: 1px solid var(--vc-line); background: var(--vc-wash); }
	.verdict-badge .glyph { width: 30px; height: 30px; flex: none; color: var(--vc); }
	.verdict-badge .vt { display: flex; flex-direction: column; line-height: 1.15; }
	.verdict-badge .vt .lab { font-family: var(--mono); font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-3); }
	.verdict-badge .vt .val { font-size: 18px; font-weight: 680; color: var(--vc); letter-spacing: -0.01em; }

	.pcredit { display: flex; align-items: center; gap: 12px; }
	.pcredit svg { transform: rotate(-90deg); flex: none; }
	.pc-num { font-family: var(--mono); font-size: 16px; font-weight: 680; fill: var(--vc); }
	.pcredit .pc-side { display: flex; flex-direction: column; gap: 6px; flex: 1; }
	.conf-row { display: flex; justify-content: space-between; font-family: var(--mono); font-size: 10px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--ink-3); }

	.trail-card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow); padding: 14px 16px 12px; margin-bottom: 14px; }
	.transport { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
	.play-btn { width: 40px; height: 40px; border-radius: 50%; border: 0; cursor: pointer; flex: none; background: var(--accent); color: #05171A; display: grid; place-items: center; box-shadow: 0 4px 14px var(--accent-wash); transition: transform .12s; }
	:root[data-theme="light"] .play-btn { color: #fff; }
	.play-btn:hover { transform: scale(1.05); } .play-btn:active { transform: scale(0.96); }
	.clock { font-family: var(--mono); font-size: 13px; font-variant-numeric: tabular-nums; color: var(--ink); min-width: 92px; letter-spacing: 0.02em; }
	.clock .sep { color: var(--ink-3); }
	.live-accrue { display: flex; gap: 14px; margin-left: auto; flex-wrap: wrap; }
	.accrue { display: flex; flex-direction: column; align-items: flex-end; }
	.accrue .k { font-family: var(--mono); font-size: 9.5px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-3); }
	.accrue .v { font-family: var(--mono); font-size: 14px; font-weight: 620; color: var(--ink); font-variant-numeric: tabular-nums; }
	.speeds { display: flex; gap: 3px; background: var(--panel-2); border: 1px solid var(--line); border-radius: 8px; padding: 3px; }
	.speeds button { font: inherit; font-family: var(--mono); font-size: 11px; border: 0; background: transparent; color: var(--ink-3); padding: 3px 8px; border-radius: 6px; cursor: pointer; }
	.speeds button[aria-pressed="true"] { background: var(--accent-wash); color: var(--accent-ink); }

	.strip-shell { position: relative; }
	.strip { position: relative; height: 44px; border-radius: 8px; background: var(--panel-2); border: 1px solid var(--line); overflow: hidden; cursor: pointer; }
	.seg { position: absolute; top: 0; bottom: 0; border-right: 1px solid var(--panel); opacity: 0.55; transition: opacity .2s; }
	.seg.played { opacity: 1; }
	.seg.err { background-image: repeating-linear-gradient(45deg, transparent, transparent 4px, rgba(0,0,0,0.10) 4px, rgba(0,0,0,0.10) 8px); }
	.seg.current { box-shadow: inset 0 0 0 2px var(--accent); opacity: 1; }
	.cost-area { position: absolute; left: 0; right: 0; bottom: 0; height: 100%; pointer-events: none; }
	.playhead { position: absolute; top: -3px; bottom: -3px; width: 2px; background: var(--accent); box-shadow: 0 0 10px var(--accent); pointer-events: none; z-index: 3; }
	.playhead::before { content:""; position: absolute; top: -1px; left: -4px; width: 10px; height: 10px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 8px var(--accent); }

	.signals { position: relative; height: 26px; margin-top: 5px; border-radius: 7px; background: var(--panel-2); border: 1px solid var(--line); }
	.sig-cap { position: absolute; left: 8px; top: 50%; transform: translateY(-50%); font-family: var(--mono); font-size: 9px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-3); pointer-events: none; z-index: 2; }
	.sig-m { position: absolute; top: 50%; transform: translate(-50%,-50%); width: 15px; height: 15px; border-radius: 5px; display: grid; place-items: center; cursor: pointer; border: 1px solid var(--panel); transition: transform .1s; z-index: 3; }
	.sig-m:hover { transform: translate(-50%,-50%) scale(1.3); }
	.sig-m svg { width: 9px; height: 9px; }
	.axis { display: flex; justify-content: space-between; font-family: var(--mono); font-size: 10px; color: var(--ink-3); margin-top: 6px; font-variant-numeric: tabular-nums; }

	.split { display: grid; grid-template-columns: 1.15fr 0.85fr; gap: 14px; align-items: start; }
	.panel { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow); }
	.panel-head { display: flex; align-items: center; gap: 10px; padding: 13px 16px; border-bottom: 1px solid var(--line); }
	.panel-head h2 { margin: 0; font-size: 13px; font-weight: 600; letter-spacing: -0.005em; }
	.panel-head .count { font-family: var(--mono); font-size: 11px; color: var(--ink-3); margin-left: auto; font-variant-numeric: tabular-nums; }

	.steps { padding: 6px 8px 10px; max-height: 640px; overflow-y: auto; }
	.step { display: grid; grid-template-columns: 30px 1fr auto; gap: 10px; align-items: start; padding: 10px 10px; border-radius: 10px; cursor: pointer; position: relative; transition: background .13s; }
	.step:hover { background: var(--panel-2); }
	.step[aria-selected="true"] { background: var(--accent-wash); }
	.step[data-current="true"]::before { content:""; position: absolute; left: 2px; top: 12px; bottom: 12px; width: 3px; border-radius: 2px; background: var(--accent); }
	.step .rail { display: grid; place-items: center; }
	.step .tick { width: 30px; height: 30px; border-radius: 9px; display: grid; place-items: center; background: var(--tc-wash); color: var(--tc); border: 1px solid transparent; }
	.step .tick svg { width: 16px; height: 16px; }
	.step .body .st-title { font-size: 13.5px; font-weight: 560; letter-spacing: -0.005em; display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
	.step .body .st-title code { font-family: var(--mono); font-size: 11.5px; background: var(--panel-2); border: 1px solid var(--line); border-radius: 5px; padding: 0.5px 5px; color: var(--ink); }
	.step .meta { text-align: right; font-family: var(--mono); font-size: 11px; color: var(--ink-3); font-variant-numeric: tabular-nums; white-space: nowrap; line-height: 1.5; }
	.stat-chip { font-family: var(--mono); font-size: 10px; letter-spacing: 0.04em; text-transform: uppercase; padding: 1px 6px; border-radius: 5px; font-weight: 600; }
	.stat-ok { color: var(--met); background: var(--met-wash); }
	.stat-err { color: var(--failed); background: var(--failed-wash); }

	.sbadge { display: inline-flex; align-items: center; gap: 4px; font-family: var(--mono); font-size: 10px; font-weight: 600; padding: 1px 6px 1px 4px; border-radius: 5px; letter-spacing: 0.02em; }
	.sbadge svg { width: 11px; height: 11px; }
	.sbadge.retry { color: var(--stuck); background: var(--stuck-wash); }

	.insp { padding: 14px 16px; }
	.insp-section + .insp-section { margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--line); }
	.insp h3 { font-family: var(--mono); font-size: 11px; letter-spacing: 0.07em; text-transform: uppercase; color: var(--ink-3); margin: 0 0 9px; }
	.judge-quote { font-size: 14px; line-height: 1.55; color: var(--ink); }
	.judge-quote b { color: var(--vc); font-weight: 640; }

	.io-kind { font-family: var(--mono); font-size: 10px; letter-spacing: 0.05em; text-transform: uppercase; color: var(--ink-3); margin-bottom: 4px; }
	.io-block { background: var(--panel-2); border: 1px solid var(--line); border-radius: 9px; padding: 10px 12px; font-family: var(--mono); font-size: 12px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; overflow-x: auto; }
	.io-block + .io-kind { margin-top: 12px; }
	.io-sig { display: flex; align-items: flex-start; gap: 9px; border-radius: 9px; padding: 10px 12px; font-size: 12.5px; margin-bottom: 12px; background: var(--panel-2); border: 1px solid var(--line); }
	.io-sig svg { width: 17px; height: 17px; flex: none; margin-top: 1px; }
	.io-sig .st { font-weight: 600; }
	.io-json { background: var(--panel-2); border: 1px solid var(--line); border-radius: 9px; padding: 10px 12px; font-family: var(--mono); font-size: 12px; line-height: 1.6; overflow-x: auto; }
	.io-diff { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; line-height: 1.5; border: 1px solid var(--line); border-radius: 6px; overflow-x: auto; margin: 4px 0 10px; }
	.io-diff > div { padding: 0 8px; white-space: pre; }
	.diff-add { background: var(--met-wash); color: var(--met); }
	.diff-del { background: var(--failed-wash); color: var(--failed); }
	.diff-hunk { background: var(--panel-2); color: var(--ink-3); }
	.diff-ctx { color: var(--ink-2); }
	.diff-banner { font-size: 11px; color: var(--partial); background: var(--partial-wash); border-radius: 5px; padding: 4px 8px; margin: 4px 0; }
	.jv-node > summary { cursor: pointer; color: var(--ink-3); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
	.jv-children { margin: 4px 0 0 14px; border-left: 1px solid var(--line); padding-left: 10px; }
	.jv-row { margin: 2px 0; }
	.jv-key { color: var(--ink-3); margin-right: 6px; }
	.jv-str { color: var(--ink); }
	.jv-scalar { color: var(--ink-2); }
	.jv-null { color: var(--ink-3); font-style: italic; }
	.jv-punct { color: var(--ink-3); }
	.msg-row { border: 1px solid var(--line); border-radius: 9px; margin-bottom: 8px; overflow: hidden; }
	.msg-row > summary { cursor: pointer; padding: 6px 12px; background: var(--panel-2); font-family: var(--mono); font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--ink-3); }
	.msg-row .io-block { border: none; border-radius: 0; border-top: 1px solid var(--line); }
	.insp-empty { color: var(--ink-3); font-size: 13px; }
	.cov-row { display: flex; justify-content: space-between; align-items: center; padding: 4px 0; font-size: 13px; }
	.cov-status { color: var(--ink-3); font-family: var(--mono); font-size: 11.5px; }
	.cov-status.cov-used { color: var(--met); }
	.pin-note { display: flex; align-items: center; gap: 6px; font-family: var(--mono); font-size: 10.5px; color: var(--accent-ink); margin-bottom: 10px; }
	.pin-note button { font: inherit; color: var(--ink-3); background: transparent; border: 0; cursor: pointer; text-decoration: underline; margin-left: auto; }

	@media (max-width: 880px) {
		.mission { grid-template-columns: 1fr; }
		.verdict { min-width: 0; }
		.split { grid-template-columns: 1fr; }
		.steps { max-height: none; }
	}
	@media (prefers-reduced-motion: reduce) { * { transition: none !important; } .play-btn { display: none; } }
`;

const PLUGIN_PICKER_IDS: Record<ShellView, string> = {
	detail: "pluginPickerDetail",
	harness: "pluginPickerHarness",
	analytics: "pluginPickerAnalytics",
};

function pluginPicker(slot: ShellView, state: ShellState, data: SlotPickerOptions): string {
	if (data.installed.length === 0 && data.registry.length === 0) return "";
	const visible = state.view === slot;
	const opts = data.installed
		.map((o) => `<option value="${escapeHtml(o.slug)}" data-entry="${escapeHtml(o.entry)}">${escapeHtml(o.name)}</option>`)
		.join("");
	const registryOpts = data.registry.length
		? `<optgroup label="Browse marketplace (listed, not reviewed)">${data.registry
				.map(
					(o) =>
						`<option value="registry:${escapeHtml(o.slug)}" data-registry-slug="${escapeHtml(o.slug)}" title="${escapeHtml(o.description)} — ${escapeHtml(o.repo)}">${escapeHtml(o.name)} (install)</option>`
				)
				.join("")}</optgroup>`
		: "";
	return `<select id="${PLUGIN_PICKER_IDS[slot]}" class="plugin-picker" data-plugin-slot="${slot}"${visible ? "" : ' style="display:none"'}><option value="">Native</option>${opts}${registryOpts}</select>`;
}

// Invariant that must hold on both this server-rendered version and app.ts's client-updated
// updateHarnessTab(): no `href` attribute on the Harness tab iff aria-disabled="true".
// onRailOrTabClick's disabled check and any code doing `new URL(anchor.href)` on this tab depend
// on that equivalence holding in both places.
function topbar(state: ShellState, pluginsBySlot: Record<ShellView, SlotPickerOptions>): string {
	const disabled = !state.traceId;
	const hrefAttr = state.traceId ? ` href="/runs/${escapeHtml(state.traceId)}/harness"` : "";
	const disabledAttr = disabled ? ' aria-disabled="true"' : "";
	const classes = ["tab", state.view === "harness" ? "tab-active" : "", disabled ? "tab-disabled" : ""].filter(Boolean).join(" ");
	const harnessTab = `<a class="${classes}"${hrefAttr} data-nav="harness"${disabledAttr}>Harness</a>`;
	const analyticsTab = `<a class="tab${state.view === "analytics" ? " tab-active" : ""}" href="/analytics" data-nav="analytics">Analytics</a>`;
	return `<div class="tabbar">
		${harnessTab}
		${analyticsTab}
		${pluginPicker("detail", state, pluginsBySlot.detail)}
		${pluginPicker("harness", state, pluginsBySlot.harness)}
		${pluginPicker("analytics", state, pluginsBySlot.analytics)}
		<button class="iconbtn" id="themeBtn" type="button" title="Toggle theme" aria-label="Toggle light/dark theme">
			<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/></svg>
		</button>
	</div>`;
}

const NO_PLUGINS: Record<ShellView, SlotPickerOptions> = {
	detail: { installed: [], registry: [] },
	harness: { installed: [], registry: [] },
	analytics: { installed: [], registry: [] },
};

const PLUGIN_STYLES = `
	.plugin-picker { font: inherit; font-size: 12px; color: var(--ink-2); background: var(--panel); border: 1px solid var(--line); border-radius: 999px; padding: 5px 10px; }
	.plugin-frame { width: 100%; height: 70vh; min-height: 480px; border: 0; border-radius: var(--radius); background: var(--panel); }
`;

/** The one document every route now returns. `railHtml` and `panelHtml` are pre-rendered by the
 * caller (server.ts) so this module never needs to import runs.ts/harness.ts/analytics.ts's data
 * functions -- it only assembles markup already produced elsewhere. */
export function renderShell(
	state: ShellState,
	title: string,
	railHtml: string,
	panelHtml: string,
	pluginsBySlot: Record<ShellView, SlotPickerOptions> = NO_PLUGINS
): string {
	const bootstrap = JSON.stringify({ view: state.view, traceId: state.traceId ?? null }).replace(/</g, "\\u003c");
	const hasPlugins = Object.values(pluginsBySlot).some((p) => p.installed.length > 0 || p.registry.length > 0);
	const styles = STYLE + (hasPlugins ? PLUGIN_STYLES : "");
	return `<!doctype html>
<title>${escapeHtml(title)}</title>
<style>${styles}</style>
<div class="shell">
	<nav class="rail-wrap">
		<div class="rail-brand"><span class="brand-name">Tether</span><a href="/" class="rail-home" aria-label="Latest run" title="Latest run">&larr;</a></div>
		<div id="rail">${railHtml}</div>
	</nav>
	<div class="main-wrap">
		${topbar(state, pluginsBySlot)}
		<main id="content">${panelHtml}</main>
	</div>
</div>
<script>window.__TETHER_INITIAL__ = ${bootstrap};</script>
<script src="/app.js" defer></script>`;
}
