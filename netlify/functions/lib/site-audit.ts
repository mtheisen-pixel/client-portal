// Automated website audit: crawl a small, capped set of pages on one site,
// pull page copy + a rough visual summary (colors/fonts) via Browserless's
// hosted headless Chrome, and assemble the result into the same
// markdown-Research-document + screenshot-Research-document shape the rest
// of the pipeline already understands (see research-documents.ts in the
// audit repo — .md is read as plain text, .png as an image content block).
//
// NOTE ON BROWSERLESS INTEGRATION: this session has no working
// BROWSERLESS_API_KEY to test against, so the request/response shapes below
// are built from Browserless's documented REST conventions (a POST /function
// endpoint that runs an arbitrary Puppeteer script server-side and returns
// its result, and a POST /screenshot endpoint), not verified against a live
// account. Sanity-check both endpoint paths and payload shapes against
// Browserless's current docs the first time this runs for real, and adjust
// BROWSERLESS_BASE_URL / the request bodies below if they've drifted.
//
// Host: Browserless Cloud has no per-account assigned region — any regional
// endpoint works with any account's token (confirmed directly with
// Browserless support). Defaults to production-sfo.browserless.io (their
// "default / US West"); override BROWSERLESS_BASE_URL to
// production-lon.browserless.io or production-ams.browserless.io for lower
// latency from those regions if it matters. The old chrome.browserless.io
// host is Browserless's legacy domain, not this one.
//
// Rate limiting: deliberately conservative rather than configurable — each
// audit crawls at most MAX_PAGES pages (sitemap or homepage-link discovery,
// same-origin only, robots.txt-filtered) with at most CONCURRENCY requests
// in flight at once. That caps a single audit at a small, bounded number of
// requests to the target site, which is both kind to the target and what
// keeps this whole run inside one Netlify function's request budget instead
// of needing the step-loop pattern the audit app's report generation uses.
//
// Netlify's synchronous function limit is ~30s on this plan (confirmed
// empirically elsewhere in this codebase — see the audit app's opportunity-
// count cap, added after the same class of failure). A real site's audit
// (several renders + screenshots, each a full Browserless page load, plus
// per-file storage uploads) can comfortably exceed that, which is exactly
// what happened on kidsquest.com early on — 20-30s, then the connection
// was dropped (a browser-side "Failed to fetch", not a clean error
// response, because Netlify kills the function outright rather than
// returning one). MAX_PAGES/MAX_SCREENSHOTS and the per-call timeouts below
// are kept tight for that reason; this is a mitigation, not a guarantee — a
// large or slow-loading site can still exceed the budget. The durable fix
// is converting this to the same one-step-per-request, polling-driven
// pattern the audit app's report generation already uses; this file stays
// a single-request design until/unless that's worth building.
//
// Separately: CONCURRENCY defaults to 1, not because of Netlify's timeout,
// but because of Browserless's own account-level concurrency cap — see the
// note on CONCURRENCY below. Running fewer pages sequentially rather than a
// few in parallel eats into the same ~30s budget from a different
// direction, which is why MAX_PAGES/MAX_SCREENSHOTS were trimmed further
// alongside that change.

import { analyzeTone, toneMarkdownSection } from "./tone-analysis";

const MAX_PAGES = 3;
const MAX_SCREENSHOTS = 1;
// Live testing surfaced a 429 from Browserless's own gateway (not the
// target site — confirmed by the identical, instant "429 ... openresty"
// response happening across several unrelated domains, including
// brandaify.com itself, which has no reason to be rate-limiting or
// blocking us). That's Browserless's own request/concurrency cap for this
// account's plan being hit before any real page-load even starts — most
// Browserless plans (especially trial/free tiers) cap concurrent sessions
// at a small number, often 1. Defaults to 1 for that reason; override
// BROWSERLESS_CONCURRENCY once the account's plan is confirmed to allow
// more, to speed the crawl back up.
const CONCURRENCY = Number(process.env.BROWSERLESS_CONCURRENCY) || 1;
const PAGE_RENDER_TIMEOUT_MS = 12000;
const PRIORITY_PATH_HINTS = ["about", "contact", "product", "products", "service", "services", "shop", "blog", "pricing"];

function browserlessBaseUrl(): string {
  return (process.env.BROWSERLESS_BASE_URL || "https://production-sfo.browserless.io").replace(/\/$/, "");
}

function browserlessToken(): string {
  const token = process.env.BROWSERLESS_API_KEY;
  if (!token) throw new Error("BROWSERLESS_API_KEY is not set.");
  return token;
}

/** Runs up to `concurrency` promises from `items` at a time, preserving order. */
async function pooled<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

// --- robots.txt -------------------------------------------------------

type RobotsRules = { disallow: string[] };

async function fetchRobotsRules(origin: string): Promise<RobotsRules> {
  try {
    const res = await fetch(`${origin}/robots.txt`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { disallow: [] };
    const text = await res.text();
    return parseRobotsTxt(text);
  } catch {
    // Unreachable or malformed robots.txt: treat as "no restrictions" rather
    // than failing the whole audit over a file that's often just missing.
    return { disallow: [] };
  }
}

/** Minimal robots.txt parser: collects Disallow rules under `User-agent: *`. */
function parseRobotsTxt(text: string): RobotsRules {
  const lines = text.split(/\r?\n/);
  const disallow: string[] = [];
  let inWildcardBlock = false;
  let sawAnyUserAgent = false;

  for (const rawLine of lines) {
    const line = rawLine.split("#")[0].trim();
    if (!line) continue;
    const [rawKey, ...rest] = line.split(":");
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(":").trim();

    if (key === "user-agent") {
      sawAnyUserAgent = true;
      inWildcardBlock = value === "*";
    } else if (key === "disallow" && inWildcardBlock && value) {
      disallow.push(value);
    }
  }

  // A robots.txt with no User-agent lines at all is malformed/empty — treat
  // as unrestricted rather than blocking everything on a parse edge case.
  return { disallow: sawAnyUserAgent ? disallow : [] };
}

function isAllowedByRobots(pathname: string, rules: RobotsRules): boolean {
  return !rules.disallow.some((rule) => pathname.startsWith(rule));
}

// --- page discovery -----------------------------------------------------

function sameOrigin(url: URL, origin: string): boolean {
  return url.origin === origin;
}

// Excludes obvious non-page resources from ever being treated as a
// crawlable "page" — most importantly .xml, since a sitemap.xml is very
// often a *sitemap index* (a list of OTHER sitemap files, e.g. Yoast/
// RankMath's post-sitemap.xml, page-sitemap.xml) rather than a list of
// actual pages, and naively rendering one of those in a browser wastes a
// request and produces garbage "page copy".
const NON_PAGE_EXTENSION_RE = /\.(xml|pdf|jpg|jpeg|png|gif|svg|webp|zip|css|js|json|ico|txt|xsl)$/i;

async function fetchSitemapLocs(url: string, origin: string): Promise<string[]> {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return [];
  const xml = await res.text();
  const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
  return locs.filter((href) => {
    try {
      return sameOrigin(new URL(href), origin);
    } catch {
      return false;
    }
  });
}

async function discoverFromSitemap(origin: string): Promise<string[]> {
  try {
    const topLevel = await fetchSitemapLocs(`${origin}/sitemap.xml`, origin);
    if (topLevel.length === 0) return [];

    // A sitemap *index* points entirely at other .xml sitemap files rather
    // than real pages (this is the common case for WordPress + an SEO
    // plugin) — follow a small, capped number of those sub-sitemaps and use
    // their <loc> entries as the actual page candidates instead.
    const looksLikeIndex = topLevel.every((href) => NON_PAGE_EXTENSION_RE.test(new URL(href).pathname));
    if (!looksLikeIndex) {
      return topLevel.filter((href) => !NON_PAGE_EXTENSION_RE.test(new URL(href).pathname));
    }

    const subSitemaps = topLevel.slice(0, 3);
    const nested = await Promise.all(subSitemaps.map((href) => fetchSitemapLocs(href, origin).catch(() => [])));
    return nested.flat().filter((href) => !NON_PAGE_EXTENSION_RE.test(new URL(href).pathname));
  } catch {
    return [];
  }
}

async function discoverFromHomepageLinks(origin: string): Promise<string[]> {
  try {
    const res = await fetch(origin, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const html = await res.text();
    const hrefs = [...html.matchAll(/<a\s[^>]*href=["']([^"'#]+)["']/gi)].map((m) => m[1]);
    const urls = new Set<string>();
    for (const href of hrefs) {
      try {
        const resolved = new URL(href, origin);
        if (sameOrigin(resolved, origin) && !NON_PAGE_EXTENSION_RE.test(resolved.pathname)) {
          urls.add(resolved.toString());
        }
      } catch {
        // ignore unparseable hrefs (mailto:, javascript:, etc.)
      }
    }
    return [...urls];
  } catch {
    return [];
  }
}

/**
 * Picks up to MAX_PAGES same-origin, robots-allowed page URLs: the homepage
 * always first, then sitemap.xml entries (or homepage links as a fallback)
 * ranked so pages matching PRIORITY_PATH_HINTS (about, contact, products,
 * blog, ...) are preferred over an arbitrary subset.
 */
export async function discoverPages(siteUrl: string): Promise<string[]> {
  const homepage = new URL(siteUrl);
  const origin = homepage.origin;

  const [robotsRules, sitemapUrls] = await Promise.all([fetchRobotsRules(origin), discoverFromSitemap(origin)]);
  const candidates = sitemapUrls.length > 0 ? sitemapUrls : await discoverFromHomepageLinks(origin);

  const allowed = candidates.filter((href) => {
    try {
      const url = new URL(href);
      return !NON_PAGE_EXTENSION_RE.test(url.pathname) && isAllowedByRobots(url.pathname, robotsRules);
    } catch {
      return false;
    }
  });

  const ranked = allowed.sort((a, b) => {
    const aPriority = PRIORITY_PATH_HINTS.some((hint) => a.toLowerCase().includes(hint)) ? 0 : 1;
    const bPriority = PRIORITY_PATH_HINTS.some((hint) => b.toLowerCase().includes(hint)) ? 0 : 1;
    return aPriority - bPriority;
  });

  const homepageAllowed = isAllowedByRobots(homepage.pathname || "/", robotsRules);
  const pages = homepageAllowed ? [homepage.toString()] : [];
  for (const url of ranked) {
    if (pages.length >= MAX_PAGES) break;
    if (!pages.includes(url)) pages.push(url);
  }
  return pages;
}

// --- Browserless calls ---------------------------------------------------

export interface RenderedPage {
  url: string;
  title: string;
  metaDescription: string;
  text: string;
  colors: string[];
  fonts: string[];
}

/**
 * The script Browserless runs server-side against its hosted browser. Kept
 * as a plain in-page `evaluate` — no page navigation logic here, that's
 * handled by the wrapping function below — so it stays easy to paste into
 * Browserless's own debugger to verify independently of this codebase.
 *
 * `export default`, not `module.exports` — confirmed against Browserless's
 * actual source (src/shared/utils/function/client.ts: the runner does
 * `import('./' + functionCodeJS)` and destructures the module's `default`
 * export, so `module`/`exports` aren't defined in that scope at all).
 * Verified live: `module.exports` produced a "module is not defined" 400
 * from Browserless.
 *
 * waitUntil: 'domcontentloaded' rather than 'networkidle2' deliberately —
 * a page with any persistent background activity (chat widgets, analytics,
 * ad trackers) never truly goes network-idle, so networkidle2 tends to sit
 * out its full timeout on real-world sites. domcontentloaded is what the
 * text/color/font extraction below actually needs (the initial HTML +
 * inline styles) and is far more predictable time-wise, which matters a lot
 * more than it used to now that this whole request has a tight budget.
 */
const EXTRACTION_SCRIPT = `
export default async ({ page, context }) => {
  await page.goto(context.url, { waitUntil: 'domcontentloaded', timeout: 8000 });

  const data = await page.evaluate(() => {
    const title = document.title || '';
    const metaDescription = document.querySelector('meta[name="description"]')?.getAttribute('content') || '';

    const clone = document.body.cloneNode(true);
    clone.querySelectorAll('script, style, noscript, nav, footer, svg, iframe').forEach((el) => el.remove());
    const text = (clone.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, 20000);

    const colors = new Set();
    const fonts = new Set();
    for (const sel of ['body', 'h1', 'h2', 'a', 'button', 'p']) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const cs = getComputedStyle(el);
      if (cs.color) colors.add(cs.color);
      if (cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)') colors.add(cs.backgroundColor);
      if (cs.fontFamily) fonts.add(cs.fontFamily.split(',')[0].replace(/["']/g, '').trim());
    }

    return { title, metaDescription, text, colors: Array.from(colors), fonts: Array.from(fonts) };
  });

  // Return the object directly — Browserless inspects the return value's
  // type itself and serializes an object as the JSON response body
  // (src/shared/utils/function/client.ts). No wrapper envelope needed or
  // expected; the earlier { data, type: 'application/json' } shape here was
  // an unverified guess that Browserless's response inspection doesn't
  // actually use.
  return data;
};
`;

export async function renderPage(url: string): Promise<RenderedPage> {
  const res = await fetch(`${browserlessBaseUrl()}/function?token=${browserlessToken()}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: EXTRACTION_SCRIPT, context: { url } }),
    signal: AbortSignal.timeout(PAGE_RENDER_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Browserless render failed for ${url}: ${res.status} ${await res.text()}`);
  }
  const payload = (await res.json()) as Partial<RenderedPage>;
  return {
    url,
    title: payload.title ?? "",
    metaDescription: payload.metaDescription ?? "",
    text: payload.text ?? "",
    colors: payload.colors ?? [],
    fonts: payload.fonts ?? [],
  };
}

export async function screenshotPage(url: string): Promise<Buffer> {
  const res = await fetch(`${browserlessBaseUrl()}/screenshot?token=${browserlessToken()}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, options: { type: "png", fullPage: false } }),
    signal: AbortSignal.timeout(PAGE_RENDER_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Browserless screenshot failed for ${url}: ${res.status} ${await res.text()}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

// --- document assembly ---------------------------------------------------

export interface WebsiteAuditResult {
  hostname: string;
  markdown: string;
  screenshots: { pageTitle: string; pageUrl: string; png: Buffer }[];
  pagesCrawled: number;
}

function pageHeading(page: RenderedPage): string {
  return page.title.trim() || page.url;
}

/**
 * `auditLabel` is the full heading text the caller wants shown ("Website
 * Audit — hostname" or "Competitor Audit — Name — hostname") — this module
 * doesn't know or care which kind of audit it's building, that's
 * website-audit.ts's call. `toneSection` is pre-rendered markdown (or an
 * explanatory string when tone analysis failed/was skipped) — built
 * upstream in runWebsiteAudit so this function stays pure string assembly.
 */
function buildMarkdown(auditLabel: string, pages: RenderedPage[], toneSection: string): string {
  const sections = pages.map((page) => {
    const heading = pageHeading(page);
    const body = page.text || "(no extractable text content)";
    return `## ${heading}\n${page.url}\n${page.metaDescription ? `\n*Meta description: ${page.metaDescription}*\n` : ""}\n${body}`;
  });

  const allColors = [...new Set(pages.flatMap((p) => p.colors))];
  const allFonts = [...new Set(pages.flatMap((p) => p.fonts))];
  const visualSummary = [
    "## Visual Summary",
    "",
    `Colors observed across ${pages.length} crawled page(s): ${allColors.length > 0 ? allColors.join(", ") : "none detected"}.`,
    "",
    `Fonts observed: ${allFonts.length > 0 ? allFonts.join(", ") : "none detected"}.`,
  ].join("\n");

  return [`# ${auditLabel}`, "", `${pages.length} page(s) crawled.`, "", visualSummary, "", toneSection, "", ...sections].join("\n\n");
}

/**
 * Runs the full audit for one site: discovers pages, renders each
 * (concurrency-capped), captures screenshots for a handful of representative
 * pages, and assembles the markdown Research document text plus the raw
 * screenshot bytes. Does not touch Supabase — the caller (website-audit.ts)
 * owns saving these as portal_documents rows, so this module stays testable
 * independent of storage. `auditLabel` becomes the markdown's H1 heading
 * verbatim — see buildMarkdown's doc comment.
 */
export async function runWebsiteAudit(siteUrl: string, auditLabel: string): Promise<WebsiteAuditResult> {
  const pageUrls = await discoverPages(siteUrl);
  if (pageUrls.length === 0) {
    throw new Error(`No crawlable pages found for ${siteUrl} (check the URL and robots.txt).`);
  }

  const pages = await pooled(pageUrls, CONCURRENCY, renderPage);

  const screenshotTargets = pageUrls.slice(0, MAX_SCREENSHOTS);
  const screenshotBuffers = await pooled(screenshotTargets, CONCURRENCY, screenshotPage);
  const screenshots = screenshotTargets.map((url, i) => {
    const page = pages.find((p) => p.url === url);
    return { pageTitle: page ? pageHeading(page) : url, pageUrl: url, png: screenshotBuffers[i] };
  });

  const toneSection = await buildToneSection(auditLabel, pages);

  const hostname = new URL(siteUrl).hostname;
  return {
    hostname,
    markdown: buildMarkdown(auditLabel, pages, toneSection),
    screenshots,
    pagesCrawled: pages.length,
  };
}

/**
 * Graceful — the rest of a Creative Audit doesn't depend on an Anthropic
 * key, so a missing one degrades this one section rather than failing the
 * whole audit (same reasoning as checkGeoReadability in technical-audit.ts).
 */
async function buildToneSection(auditLabel: string, pages: RenderedPage[]): Promise<string> {
  const combinedText = pages.map((p) => p.text).filter(Boolean).join("\n\n");
  if (!combinedText) return "## Perceived Tone\n\nSkipped — no extractable page text.";
  try {
    const descriptors = await analyzeTone(auditLabel, combinedText);
    return toneMarkdownSection(descriptors);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return `## Perceived Tone\n\nSkipped — ${message}`;
  }
}
