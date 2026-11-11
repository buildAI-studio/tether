/**
 * Tether's local HTTP server: accepts the same OTLP/JSON payload
 * mcp/src/otlp.ts sends, stores every span, and serves the unified shell
 * (run rail + a Detail/Harness/Analytics panel) plus the /fragments/* routes
 * its client router fetches for in-app navigation.
 */

import { createServer, IncomingMessage, ServerResponse, Server, request as httpRequest } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { insertSpan } from "./db.js";
import { getRun, listRuns, listLinkedSessionIds } from "./runs.js";
import { getHarnessView } from "./harness.js";
import { getCompositionView, listCompositionOnlySessions, getCompositionViewForSessionId } from "./composition.js";
import { getCoverage } from "./coverage.js";
import { getUsage } from "./analytics.js";
import { renderDetailFragment, renderEmptyDetailPanel } from "./templates/flight-recorder.js";
import { renderCompositionFragment } from "./templates/composition-detail.js";
import { renderRailBody } from "./templates/rail.js";
import type { RailEntry } from "./templates/rail.js";
import { renderHarnessBody } from "./templates/harness.js";
import { renderAnalyticsBody } from "./templates/analytics.js";
import type { WidgetOption } from "./templates/analytics.js";
import { renderShell, renderNotFoundPanel } from "./templates/shell.js";
import type { ShellState, ShellView, PluginOption, SlotPickerOptions } from "./templates/shell.js";
import { resolvePluginAssetPath, contentTypeFor, readDevOverrides, listInstalledPlugins, readDashboardSlugs, writeDashboardSlugs, installPluginFromGitUrl } from "./plugins.js";
import { currentRegistry, refreshRegistryIfStale } from "./registry.js";
import type { RegistryEntry } from "./registry.js";

const APP_JS = readFileSync(fileURLToPath(new URL("./static/app.js", import.meta.url)), "utf-8");
// Vendored, not an npm dependency (see server/src/static/vendor/elkjs-LICENSE.md) -- the Harness
// graph's client-side layout engine, same approach haydenschmitty/floorplan uses to stay
// zero-runtime-dependency while still getting a real layered graph layout in the browser.
const ELK_JS = readFileSync(fileURLToPath(new URL("./static/vendor/elk.bundled.js", import.meta.url)), "utf-8");

interface OtlpSpan {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	name: string;
	startTimeUnixNano: string;
	endTimeUnixNano: string;
	[key: string]: unknown;
}

function extractSpans(body: unknown): OtlpSpan[] {
	const spans: OtlpSpan[] = [];
	const resourceSpans = (body as { resourceSpans?: unknown[] })?.resourceSpans ?? [];
	for (const rs of resourceSpans) {
		const scopeSpans = (rs as { scopeSpans?: unknown[] })?.scopeSpans ?? [];
		for (const ss of scopeSpans) {
			const spanList = (ss as { spans?: OtlpSpan[] })?.spans ?? [];
			for (const span of spanList) spans.push(span);
		}
	}
	return spans;
}

async function readBody(req: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf-8");
}

/** Writes a JSON error response. Guarded against being called after headers were already sent
 * (e.g. a render function threw AFTER a route's success-path writeHead already ran) -- a second
 * writeHead in that situation throws ERR_HTTP_HEADERS_SENT, which (being thrown from inside a
 * catch block in an async handler) becomes an unhandled rejection and crashes the whole process.
 * Every route below is written to compute its body into a local variable before its one and only
 * writeHead call specifically so this guard is never needed in practice -- it's a second line of
 * defense in case a future route reintroduces that bug. */
function sendError(res: ServerResponse, status: number, error: string): void {
	if (res.headersSent) {
		res.end();
		return;
	}
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ ok: false, error }));
}

/** Decodes a traceId path segment for a /fragments/* route, writing a bare-JSON 400 (matching
 * every other error response a fragment endpoint gives) and returning null on a malformed one. */
function decodeTraceIdOr400(raw: string, res: ServerResponse): string | null {
	try {
		return decodeURIComponent(raw);
	} catch {
		sendError(res, 400, "malformed traceId");
		return null;
	}
}

/** Decodes a traceId path segment for a full-page route, rendering a shell-wrapped error page on
 * a malformed one -- consistent with how these routes already give a well-formed-but-unknown
 * traceId a shell-wrapped 404, rather than decodeTraceIdOr400's bare JSON (which is correct only
 * for the /fragments/* routes, since those already return raw fragment bodies, not full pages). */
function decodeTraceIdOrShellError(
	raw: string,
	res: ServerResponse,
	db: Database.Database,
	view: ShellView,
	pluginsRoot: string
): string | null {
	try {
		return decodeURIComponent(raw);
	} catch {
		const body = renderShell({ view }, "Tether — Run not found", buildRail(db, undefined), renderNotFoundPanel(), pluginsBySlot(pluginsRoot));
		res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
		res.end(body);
		return null;
	}
}

/** Renders the Detail fragment body for a traceId that has a completed run, falling back to
 * the composition-only fragment when there's no run but there IS real attachment data for that
 * traceId (a crashed or still-running `trail_attach` session -- see composition.ts). An empty
 * `{ entries: [] }` composition view (no root span and no attachment attributes either -- e.g. a
 * crashed self-reported run) is treated the same as "nothing to show" and still 404s, matching
 * today's behavior exactly for that case. */
function renderDetailOrComposition(db: Database.Database, traceId: string): { status: 200 | 404; body: string } {
	const run = getRun(db, traceId);
	if (run) return { status: 200, body: renderDetailFragment(run, getCoverage(db, traceId), run.sessionId ? getCompositionViewForSessionId(db, run.sessionId) : null) };
	const composition = getCompositionView(db, traceId);
	if (composition && composition.entries.length > 0) return { status: 200, body: renderCompositionFragment(traceId, composition) };
	return { status: 404, body: renderNotFoundPanel() };
}

/** The rail's inner HTML for the 50 most recent runs merged with the 50 most recent
 * composition-only sessions (crashed/background sessions with no completed run -- see
 * composition.ts's listCompositionOnlySessions), sorted by recency with `active` highlighted.
 * ISO 8601 strings sort correctly with plain string comparison; a degraded empty timestamp from
 * either summary type sorts to the end of this descending sort rather than crashing. */
function buildRail(db: Database.Database, active: string | undefined): string {
	const runEntries: RailEntry[] = listRuns(db, 50).map((run) => ({ kind: "run", run }));
	const linkedSessionIds = listLinkedSessionIds(db);
	const compositionEntries: RailEntry[] = listCompositionOnlySessions(db, 50, linkedSessionIds).map((session) => ({ kind: "composition", session }));
	const merged = [...runEntries, ...compositionEntries]
		.sort((a, b) => {
			const aTime = a.kind === "run" ? a.run.startedAt : a.session.lastActivityAt;
			const bTime = b.kind === "run" ? b.run.startedAt : b.session.lastActivityAt;
			return bTime.localeCompare(aTime);
		})
		.slice(0, 50);
	return renderRailBody(merged, active, Date.now());
}

/** Every compatible installed plugin under `pluginsRoot`, grouped by the shell slot it replaces,
 * alongside every not-yet-installed compatible registry entry for that slot -- the shape
 * renderShell's picker expects. Also the one place a full-page render opportunistically kicks off
 * a background registry refresh (fire-and-forget; never awaited here). */
function pluginsBySlot(pluginsRoot: string): Record<"detail" | "harness" | "analytics", SlotPickerOptions> {
	void refreshRegistryIfStale(pluginsRoot);
	const installedPlugins = listInstalledPlugins(pluginsRoot);
	const compatible = installedPlugins.filter((p) => p.compatible && p.kind !== "widget");
	const installedSlugs = new Set(installedPlugins.map((p) => p.slug));
	const toOption = (p: (typeof compatible)[number]): PluginOption => ({ slug: p.slug, name: p.name, entry: p.entry });
	const registryPanels = currentRegistry(pluginsRoot).entries.filter((e) => e.kind === "panel" && !installedSlugs.has(e.slug));
	return {
		detail: { installed: compatible.filter((p) => p.replaces === "detail").map(toOption), registry: registryPanels.filter((e) => e.slot === "detail") },
		harness: { installed: compatible.filter((p) => p.replaces === "harness").map(toOption), registry: registryPanels.filter((e) => e.slot === "harness") },
		analytics: { installed: compatible.filter((p) => p.replaces === "analytics").map(toOption), registry: registryPanels.filter((e) => e.slot === "analytics") },
	};
}

/** GET's response shape, and what PUT returns after a successful write: the persisted slug list,
 * filtered to widgets that are still installed and version-compatible -- a slug for a plugin
 * that's since been removed or gone incompatible is silently dropped, never surfaced as an error,
 * matching plugins.ts's existing "missing manifest = skip" convention. */
function dashboardSlugsView(pluginsRoot: string): { slugs: string[] } {
	const bySlug = new Map(listInstalledPlugins(pluginsRoot).map((p) => [p.slug, p]));
	const slugs = readDashboardSlugs(pluginsRoot).filter((slug) => {
		const p = bySlug.get(slug);
		return !!p && p.compatible && p.kind === "widget";
	});
	return { slugs };
}

/** Every installed, version-compatible kind:"widget" plugin, in the shape renderAnalyticsBody's
 * picker needs -- the analytics-view analog of pluginsBySlot for panel plugins. */
function widgetOptions(pluginsRoot: string): WidgetOption[] {
	return listInstalledPlugins(pluginsRoot)
		.filter((p) => p.compatible && p.kind === "widget")
		.map((p) => ({ slug: p.slug, name: p.name, entry: p.entry, size: p.size as WidgetOption["size"] }));
}

/** Every not-yet-installed kind:"widget" registry entry -- the marketplace analog of
 * widgetOptions for the Add-widget picker's optgroup. Also opportunistically triggers a
 * background registry refresh, same as pluginsBySlot -- this covers the Analytics routes, which
 * don't call pluginsBySlot. */
function registryWidgetOptions(pluginsRoot: string): RegistryEntry[] {
	void refreshRegistryIfStale(pluginsRoot);
	const installedSlugs = new Set(listInstalledPlugins(pluginsRoot).map((p) => p.slug));
	return currentRegistry(pluginsRoot).entries.filter((e) => e.kind === "widget" && !installedSlugs.has(e.slug));
}

/** Response headers the dev-server proxy is allowed to pass back to the browser. An allowlist
 * rather than forwarding `proxyRes.headers` wholesale: a dev server's response must not be able to
 * set cookies (or any other header class with ambient authority) on Tether's own origin, and
 * hop-by-hop headers like `transfer-encoding` must not be copied onto a response node is
 * re-framing itself. */
const PROXY_SAFE_RESPONSE_HEADERS = new Set([
	"content-type",
	"content-length",
	"content-encoding",
	"cache-control",
	"etag",
	"last-modified",
	"vary",
]);

/** True for a `Location` value safe to forward from a dev-server response: a same-path-relative
 * reference, never anything that names a different authority. A dev server's own redirects (e.g.
 * a directory route redirecting to its `index.html`) are common enough in local dev tooling that
 * dropping `Location` outright (the original, simpler fix) leaves `plugin dev` rendering blank on
 * a redirecting dev server -- but forwarding it unconditionally would let a compromised or
 * malicious dev server redirect the browser to an attacker-chosen origin while still under
 * Tether's own page. Rejects a scheme (`http:`, `javascript:`, ...), a protocol-relative
 * `//host/...` authority, and a backslash (which some browsers normalize to `/`, the same class
 * of trick `proxyGet`'s asset-path check already guards against). */
function isSafeRelativeRedirect(value: string): boolean {
	if (value.includes("\\")) return false;
	if (value.startsWith("//")) return false;
	if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return false;
	return true;
}

/** Proxies a GET for `assetPath` under `targetBase` and pipes the response straight through to
 * `res`. Used only for plugin dev-mode overrides (§3.2/§3.4 of the plugin spec) -- keeps the
 * iframe's fetches to /api/v1/* same-origin even while the plugin's own assets are served by a
 * separate dev server, since the proxy itself is same-origin from the browser's perspective.
 *
 * The target is built by explicit pathname concatenation, never by relative-URL resolution
 * (`new URL(path, targetBase)`): under WHATWG resolution a path beginning `//` is an authority,
 * so `/plugins/<slug>//evil.com/x` would have resolved the target to `http://evil.com/x` and piped
 * attacker-controlled content back under Tether's own origin. The URL `pathname` setter cannot
 * change the host, so composing this way pins the target to the configured dev server. The caller
 * additionally rejects any `assetPath` containing `//` or a backslash before it reaches here. */
function proxyGet(targetBase: string, assetPath: string, res: ServerResponse): void {
	let target: URL;
	try {
		target = new URL(targetBase);
	} catch {
		sendError(res, 502, "dev server override is not a valid URL");
		return;
	}
	if (target.protocol !== "http:") {
		sendError(res, 502, "dev server override must be an http:// URL");
		return;
	}
	target.pathname = target.pathname.replace(/\/+$/, "") + "/" + assetPath.replace(/^\/+/, "");
	const proxyReq = httpRequest(
		{ protocol: target.protocol, hostname: target.hostname, port: target.port, path: target.pathname + target.search, method: "GET" },
		(proxyRes) => {
			// A socket error after the response has started arriving (the dev server dropping the
			// connection mid-stream, e.g. during its own hot-reload restart) is a separate event from
			// proxyReq's -- with no listener here it would be an unhandled 'error' event, which Node
			// throws synchronously. index.ts's uncaughtException handler keeps the process alive
			// either way, but this leaves the response cleanly ended instead of hanging.
			proxyRes.on("error", () => {
				if (!res.headersSent) sendError(res, 502, "dev server connection error");
				else res.destroy();
			});
			const headers: Record<string, string> = {};
			for (const [name, value] of Object.entries(proxyRes.headers)) {
				if (value === undefined) continue;
				const lower = name.toLowerCase();
				if (PROXY_SAFE_RESPONSE_HEADERS.has(lower)) {
					headers[name] = Array.isArray(value) ? value.join(", ") : value;
				} else if (lower === "location" && typeof value === "string" && isSafeRelativeRedirect(value)) {
					headers[name] = value;
				}
			}
			res.writeHead(proxyRes.statusCode ?? 502, headers);
			proxyRes.pipe(res);
		}
	);
	// A dev server that never responds (hung, or mid-restart) would otherwise leave the request
	// pending indefinitely; destroying it here routes through the same "dev server unreachable"
	// error handler below rather than adding a second error path.
	proxyReq.setTimeout(10_000, () => proxyReq.destroy());
	proxyReq.on("error", () => sendError(res, 502, "dev server unreachable"));
	proxyReq.end();
}

export function createTetherServer(db: Database.Database, options: { pluginsRoot: string }): Server {
	const { pluginsRoot } = options;
	return createServer(async (req, res) => {
		const pathname = (req.url ?? "").split("?")[0];

		if (req.method === "POST" && pathname === "/traces") {
			try {
				const bodyText = await readBody(req);
				const parsed = JSON.parse(bodyText);
				const spans = extractSpans(parsed);
				for (const span of spans) {
					insertSpan(db, {
						traceId: span.traceId,
						spanId: span.spanId,
						parentSpanId: span.parentSpanId ?? null,
						name: span.name,
						startTimeUnixNano: span.startTimeUnixNano,
						endTimeUnixNano: span.endTimeUnixNano,
						raw: JSON.stringify(span),
					});
				}
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true, spansIngested: spans.length }));
			} catch (err) {
				sendError(res, 400, (err as Error).message);
			}
			return;
		}

		if (req.method === "GET" && pathname === "/app.js") {
			try {
				res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
				res.end(APP_JS);
			} catch (err) {
				sendError(res, 500, (err as Error).message);
			}
			return;
		}

		if (req.method === "GET" && pathname === "/vendor/elk.bundled.js") {
			try {
				res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
				res.end(ELK_JS);
			} catch (err) {
				sendError(res, 500, (err as Error).message);
			}
			return;
		}

		if (req.method === "GET" && pathname === "/fragments/rail") {
			try {
				const query = new URLSearchParams((req.url ?? "").split("?")[1] ?? "");
				const active = query.get("active") ?? undefined;
				const body = buildRail(db, active);
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				res.end(body);
			} catch (err) {
				sendError(res, 500, (err as Error).message);
			}
			return;
		}

		if (req.method === "GET" && pathname === "/fragments/analytics") {
			try {
				const body = renderAnalyticsBody(getUsage(db), widgetOptions(pluginsRoot), registryWidgetOptions(pluginsRoot));
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				res.end(body);
			} catch (err) {
				sendError(res, 500, (err as Error).message);
			}
			return;
		}

		if (req.method === "GET" && pathname.startsWith("/fragments/harness/")) {
			const traceId = decodeTraceIdOr400(pathname.slice("/fragments/harness/".length), res);
			if (traceId === null) return;
			try {
				const view = getHarnessView(db, traceId);
				if (!view) {
					res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
					res.end(renderNotFoundPanel());
					return;
				}
				const body = renderHarnessBody(view, getCoverage(db, traceId));
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				res.end(body);
			} catch (err) {
				sendError(res, 500, (err as Error).message);
			}
			return;
		}

		// No traceId -- resolves to the most recently started run, same as `/` itself does
		// server-side. Exists so the client router can fetch `/` client-side (see app.ts's
		// parsePathname("/")) instead of falling through to a full page reload on a Back
		// navigation to the landing page.
		if (req.method === "GET" && pathname === "/fragments/detail") {
			try {
				const traceId = listRuns(db, 50)[0]?.traceId ?? null;
				if (traceId === null) {
					const body = renderEmptyDetailPanel();
					res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
					res.end(body);
					return;
				}
				const result = renderDetailOrComposition(db, traceId);
				res.writeHead(result.status, { "Content-Type": "text/html; charset=utf-8" });
				res.end(result.body);
			} catch (err) {
				sendError(res, 500, (err as Error).message);
			}
			return;
		}

		if (req.method === "GET" && pathname.startsWith("/fragments/detail/")) {
			const traceId = decodeTraceIdOr400(pathname.slice("/fragments/detail/".length), res);
			if (traceId === null) return;
			try {
				const result = renderDetailOrComposition(db, traceId);
				res.writeHead(result.status, { "Content-Type": "text/html; charset=utf-8" });
				res.end(result.body);
			} catch (err) {
				sendError(res, 500, (err as Error).message);
			}
			return;
		}

		if (req.method === "GET" && pathname.startsWith("/api/v1/runs/")) {
			const traceId = decodeTraceIdOr400(pathname.slice("/api/v1/runs/".length), res);
			if (traceId === null) return;
			try {
				const run = getRun(db, traceId);
				if (!run) {
					sendError(res, 404, "run not found");
					return;
				}
				const composition = run.sessionId ? getCompositionViewForSessionId(db, run.sessionId) : null;
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ...run, coverage: getCoverage(db, traceId), composition }));
			} catch (err) {
				sendError(res, 500, (err as Error).message);
			}
			return;
		}

		if (req.method === "GET" && pathname.startsWith("/api/v1/harness/")) {
			const traceId = decodeTraceIdOr400(pathname.slice("/api/v1/harness/".length), res);
			if (traceId === null) return;
			try {
				const view = getHarnessView(db, traceId);
				if (!view) {
					sendError(res, 404, "run not found");
					return;
				}
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify(view));
			} catch (err) {
				sendError(res, 500, (err as Error).message);
			}
			return;
		}

		if (req.method === "GET" && pathname.startsWith("/api/v1/composition/")) {
			const traceId = decodeTraceIdOr400(pathname.slice("/api/v1/composition/".length), res);
			if (traceId === null) return;
			try {
				const view = getCompositionView(db, traceId);
				if (!view) {
					sendError(res, 404, "run not found");
					return;
				}
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify(view));
			} catch (err) {
				sendError(res, 500, (err as Error).message);
			}
			return;
		}

		if (req.method === "GET" && pathname === "/api/v1/analytics") {
			try {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify(getUsage(db)));
			} catch (err) {
				sendError(res, 500, (err as Error).message);
			}
			return;
		}

		if (req.method === "GET" && pathname === "/api/v1/dashboard/analytics") {
			try {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify(dashboardSlugsView(pluginsRoot)));
			} catch (err) {
				sendError(res, 500, (err as Error).message);
			}
			return;
		}

		if (req.method === "PUT" && pathname === "/api/v1/dashboard/analytics") {
			let parsed: unknown;
			try {
				const bodyText = await readBody(req);
				parsed = JSON.parse(bodyText);
			} catch (err) {
				sendError(res, 400, `invalid JSON body: ${(err as Error).message}`);
				return;
			}
			try {
				const slugs = (parsed as { slugs?: unknown })?.slugs;
				if (!Array.isArray(slugs) || !slugs.every((s) => typeof s === "string")) {
					sendError(res, 400, "body must be { slugs: string[] }");
					return;
				}
				if (!writeDashboardSlugs(pluginsRoot, slugs)) {
					sendError(res, 400, "one or more slugs are invalid");
					return;
				}
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify(dashboardSlugsView(pluginsRoot)));
			} catch (err) {
				sendError(res, 500, (err as Error).message);
			}
			return;
		}

		if (req.method === "POST" && pathname === "/api/v1/plugins/install") {
			// A POST with no Content-Type (or a non-JSON one, e.g. text/plain) is a CORS "simple
			// request" -- any web page the browser has open could fire one at this local server
			// without a preflight, triggering a real git clone + filesystem write. Requiring
			// application/json forces a real cross-origin caller through a preflight this server
			// doesn't handle, so the browser blocks it before it ever reaches here. Checked before the
			// body is even read.
			const contentType = req.headers["content-type"] ?? "";
			if (!contentType.toLowerCase().startsWith("application/json")) {
				sendError(res, 400, "Content-Type must be application/json");
				return;
			}
			let parsed: unknown;
			try {
				const bodyText = await readBody(req);
				parsed = JSON.parse(bodyText);
			} catch (err) {
				sendError(res, 400, `invalid JSON body: ${(err as Error).message}`);
				return;
			}
			try {
				const slug = (parsed as { slug?: unknown })?.slug;
				if (typeof slug !== "string" || slug === "") {
					sendError(res, 400, "body must be { slug: string }");
					return;
				}
				const entry = currentRegistry(pluginsRoot).entries.find((e) => e.slug === slug);
				if (!entry) {
					sendError(res, 404, "unknown registry slug");
					return;
				}
				const result = installPluginFromGitUrl(entry.repo, pluginsRoot);
				if (!result.ok) {
					sendError(res, 502, result.error);
					return;
				}
				// The registry entry's own slug (used for the "not yet installed" filters elsewhere in
				// this file) must match the slug the installed manifest actually landed at
				// (join(pluginsRoot, result.manifest.slug), per installPluginFromGitUrl) -- otherwise a
				// bad listing could silently overwrite an unrelated already-installed plugin. By this
				// point the clone has already happened and installPluginFromGitUrl's
				// rmSync(dest)+renameSync(cloneTarget, dest) may already have overwritten whatever was
				// at that destination, so there is no data-preserving way to "clean up" here -- removing
				// the mismatched directory now wouldn't restore anything that was lost, it would just
				// destroy the mismatched content too (which might be all that's left of a real,
				// unrelated plugin). So this deliberately does NOT touch disk any further: it only
				// reports the mismatch so the registry listing can be fixed.
				if (result.manifest.slug !== entry.slug) {
					sendError(
						res,
						502,
						`registry entry "${entry.slug}" points to a manifest with a different slug ("${result.manifest.slug}") -- refusing to install`
					);
					return;
				}
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true, plugin: result.manifest, compatible: !result.versionMismatch }));
			} catch (err) {
				sendError(res, 500, (err as Error).message);
			}
			return;
		}

		const pluginAssetMatch = pathname.match(/^\/plugins\/([^/]+)\/(.+)$/);
		if (req.method === "GET" && pluginAssetMatch) {
			try {
				const slug = decodeURIComponent(pluginAssetMatch[1]);
				const assetPath = decodeURIComponent(pluginAssetMatch[2]);
				// The route's `(.+)` capture can start with `/` (or contain `//`, or a backslash the
				// URL parser treats as `/`), which is how an authority-looking path smuggles a
				// different host into a URL. proxyGet composes its target so that can't reach the
				// host, but nothing legitimate asks for such a path -- so reject it outright here as
				// well, before either the proxy or the static branch sees it.
				if (assetPath.includes("//") || assetPath.startsWith("/") || assetPath.includes("\\")) {
					sendError(res, 400, "malformed plugin asset path");
					return;
				}
				// `slug` comes off the URL, so the lookup is guarded: only an own, string-valued
				// override counts (readDevOverrides enforces both, this re-checks at the use site).
				const override = readDevOverrides(pluginsRoot)[slug];
				if (typeof override === "string" && override !== "") {
					proxyGet(override, assetPath, res);
					return;
				}
				const resolved = resolvePluginAssetPath(pluginsRoot, slug, assetPath);
				if (!resolved) {
					sendError(res, 404, "plugin asset not found");
					return;
				}
				res.writeHead(200, { "Content-Type": contentTypeFor(resolved) });
				res.end(readFileSync(resolved));
			} catch (err) {
				sendError(res, 500, (err as Error).message);
			}
			return;
		}

		const harnessPathMatch = pathname.match(/^\/runs\/([^/]+)\/harness$/);
		if (req.method === "GET" && harnessPathMatch) {
			try {
				const traceId = decodeTraceIdOrShellError(harnessPathMatch[1], res, db, "harness", pluginsRoot);
				if (traceId === null) return;
				const rail = buildRail(db, traceId);
				const view = getHarnessView(db, traceId);
				const state: ShellState = { view: "harness", traceId };
				if (!view) {
					const body = renderShell(state, "Tether — Run not found", rail, renderNotFoundPanel(), pluginsBySlot(pluginsRoot));
					res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
					res.end(body);
					return;
				}
				const body = renderShell(state, "Tether — Harness", rail, renderHarnessBody(view, getCoverage(db, traceId)), pluginsBySlot(pluginsRoot));
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				res.end(body);
			} catch (err) {
				sendError(res, 500, (err as Error).message);
			}
			return;
		}

		const detailPathMatch = pathname.match(/^\/runs\/([^/]+)$/);
		if (req.method === "GET" && (pathname === "/" || detailPathMatch)) {
			try {
				const runs = listRuns(db, 50);
				let traceId: string | null;
				if (pathname === "/") {
					traceId = runs[0]?.traceId ?? null;
				} else {
					const decoded = decodeTraceIdOrShellError(detailPathMatch![1], res, db, "detail", pluginsRoot);
					if (decoded === null) return;
					traceId = decoded;
				}

				const rail = buildRail(db, traceId ?? undefined);
				if (traceId === null) {
					const body = renderShell({ view: "detail" }, "Tether", rail, renderEmptyDetailPanel(), pluginsBySlot(pluginsRoot));
					res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
					res.end(body);
					return;
				}

				const run = getRun(db, traceId);
				const state: ShellState = { view: "detail", traceId };
				if (run) {
					const body = renderShell(
						state,
						`Tether — ${run.goal}`,
						rail,
						renderDetailFragment(run, getCoverage(db, traceId), run.sessionId ? getCompositionViewForSessionId(db, run.sessionId) : null),
						pluginsBySlot(pluginsRoot)
					);
					res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
					res.end(body);
					return;
				}
				const result = renderDetailOrComposition(db, traceId);
				const title = result.status === 404 ? "Tether — Run not found" : "Tether — Composition";
				const body = renderShell(state, title, rail, result.body, pluginsBySlot(pluginsRoot));
				res.writeHead(result.status, { "Content-Type": "text/html; charset=utf-8" });
				res.end(body);
			} catch (err) {
				sendError(res, 500, (err as Error).message);
			}
			return;
		}

		if (req.method === "GET" && pathname === "/analytics") {
			try {
				const rail = buildRail(db, undefined);
				const body = renderShell(
					{ view: "analytics" },
					"Tether — Analytics",
					rail,
					renderAnalyticsBody(getUsage(db), widgetOptions(pluginsRoot), registryWidgetOptions(pluginsRoot)),
					pluginsBySlot(pluginsRoot)
				);
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				res.end(body);
			} catch (err) {
				sendError(res, 500, (err as Error).message);
			}
			return;
		}

		sendError(res, 404, "not found");
	});
}
