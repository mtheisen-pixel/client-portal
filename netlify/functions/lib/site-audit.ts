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
// Rate limiting: deliberately conservative rather than configurable — each
// audit crawls at most MAX_PAGES pages (sitemap or homepage-link discovery,
// same-origin only, robots.txt-filtered) with at most CONCURRENCY requests
// in flight at once. That caps a single audit at a small, bounded number of
// requests to the target site, which is both kind to the target and what
// keeps this whole run inside one Netlify function's request budget instead
// of needing the step-loop pattern the audit app's report generation uses.

const MAX_PAGES = 6;
const MAX_SCREENSHOTS = 3;
const CONCURRENCY = 3;
const PRIORITY_PATH_HINTS = ["about", "contact", "product", "products", "service", "services", "shop", "blog", "pricing"];

function browserlessBaseUrl(): string {
  return (process.env.BROWSERLESS_BASE_URL || "https://chrome.browserless.io").replace(/\/$/, "");
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

async function discoverFromSitemap(origin: string): Promise<string[]> {
  try {
    const res = await fetch(`${origin}/sitemap.xml`, { signal: AbortSignal.timeout(8000) });
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
        if (sameOrigin(resolved, origin)) urls.add(resolved.toString());
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
      return isAllowedByRobots(new URL(href).pathname, robotsRules);
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
 */
const EXTRACTION_SCRIPT = `
module.exports = async ({ page, context }) => {
  await page.goto(context.url, { waitUntil: 'networkidle2', timeout: 20000 });

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

  return { data, type: 'application/json' };
};
`;

export async function renderPage(url: string): Promise<RenderedPage> {
  const res = await fetch(`${browserlessBaseUrl()}/function?token=${browserlessToken()}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: EXTRACTION_SCRIPT, context: { url } }),
    signal: AbortSignal.timeout(25000),
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
    signal: AbortSignal.timeout(25000),
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

function buildMarkdown(siteLabel: string, pages: RenderedPage[]): string {
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

  return [`# Website Audit — ${siteLabel}`, "", `${pages.length} page(s) crawled.`, "", visualSummary, "", ...sections].join("\n\n");
}

/**
 * Runs the full audit for one site: discovers pages, renders each
 * (concurrency-capped), captures screenshots for a handful of representative
 * pages, and assembles the markdown Research document text plus the raw
 * screenshot bytes. Does not touch Supabase — the caller (website-audit.ts)
 * owns saving these as portal_documents rows, so this module stays testable
 * independent of storage.
 */
export async function runWebsiteAudit(siteUrl: string, siteLabel: string): Promise<WebsiteAuditResult> {
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

  const hostname = new URL(siteUrl).hostname;
  return {
    hostname,
    markdown: buildMarkdown(siteLabel, pages),
    screenshots,
    pagesCrawled: pages.length,
  };
}
