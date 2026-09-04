// Technical Audit: SEO/technical-health checks via plain HTTP fetch + raw
// HTML parsing — deliberately NOT Browserless. Everything here (meta tags,
// headings, alt text, schema, robots.txt, link status) is readable from raw
// HTML/HTTP responses, so there's no reason to pay for a browser render
// (slower, and subject to Browserless's own concurrency cap) when a plain
// fetch answers the same question. This keeps Technical Audit's "fast"
// checks fast — the Core Web Vitals/PageSpeed Insights piece is genuinely
// slow (see pagespeed.ts) and is deliberately kept as a separate document/
// separate request rather than folded in here, for exactly that reason.
//
// This is diagnostic only — it reports what it finds, it never tries to
// fix anything (no schema injection, no meta-tag generation, no redirect
// changes).
//
// Not covered here (flagged, not built): deeper accessibility checks
// (contrast ratios beyond a basic CSS scan, form-label association, ARIA
// correctness) would need a dedicated engine like axe-core running against
// a rendered DOM — out of scope for a plain-HTTP pass, and PageSpeed
// Insights' Lighthouse accessibility category (see pagespeed.ts) already
// covers a real axe-core run for free. Backlink/domain-authority data needs
// a paid third-party API (Ahrefs, Moz, ...) and isn't attempted here.

import { analyzeGeoReadability, describeAnthropicFailure } from "./tone-analysis";

const TECH_MAX_PAGES = 4;
const LINK_CHECK_SAMPLE = 8;
const SITEMAP_URL_CHECK_SAMPLE = 10;
// Kept tight — this is one of several checks racing inside the same ~30s
// Netlify request budget (see runTechnicalAuditFast), and a redirect chain
// is sequential per-variant (each hop waits on the last). A real chain
// resolves in well under a second per hop; this timeout only matters for a
// hop that's genuinely hanging, so 4 hops @ 5s is a ~20s worst case for one
// pathological variant, not the typical path.
const REDIRECT_CHECK_TIMEOUT_MS = 5000;
const MAX_REDIRECT_HOPS = 4;
const THIN_CONTENT_WORD_THRESHOLD = 150;
const FETCH_TIMEOUT_MS = 8000;
const USER_AGENT = "Mozilla/5.0 (compatible; BrandaifyAuditBot/1.0; +https://brandaify.com)";

const AI_CRAWLER_AGENTS = ["GPTBot", "ClaudeBot", "anthropic-ai", "Google-Extended", "CCBot", "PerplexityBot"];

async function fetchText(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<{ status: number; text: string; headers: Headers } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { "User-Agent": USER_AGENT } });
    return { status: res.status, text: await res.text(), headers: res.headers };
  } catch {
    return null;
  }
}

function extractFirst(html: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const m = html.match(pattern);
    if (m) return m[1].trim();
  }
  return null;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/** Body text with script/style/noscript stripped out — no length cap, unlike extractBodyText (used for word counts and the free-text phone fallback, where truncating would silently under-count). */
function bodyTextOf(html: string): string {
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  const body = bodyMatch ? bodyMatch[1] : html;
  const withoutScripts = body.replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, "");
  return stripTags(withoutScripts);
}

function extractBodyText(html: string): string {
  return bodyTextOf(html).slice(0, 15000);
}

function wordCountOf(html: string): number {
  const text = bodyTextOf(html);
  return text.length === 0 ? 0 : text.split(/\s+/).filter(Boolean).length;
}

/** Graceful — the rest of Technical Audit doesn't depend on an Anthropic key, so a missing/invalid one degrades this one note rather than failing the whole report. */
async function checkGeoReadability(homepageHtml: string): Promise<string> {
  try {
    return await analyzeGeoReadability(extractBodyText(homepageHtml));
  } catch (err) {
    return describeAnthropicFailure(err, "AI-summarizability check");
  }
}

interface NapInfo {
  name: string | null;
  phones: string[];
  address: string | null;
}

/**
 * Descends into `@graph` — the wrapper Yoast SEO and many other WordPress
 * schema plugins use to bundle several typed nodes (WebSite, Organization,
 * LocalBusiness, ...) into one JSON-LD block — so a real node nested inside
 * isn't invisible to callers that only look at the top level. Without this,
 * a perfectly valid, type-rich `@graph` document reads as "no @type found"
 * everywhere the parsed object's own top-level `@type` is checked, even
 * though real schema is right there one level down. Handles a single
 * object, an array of objects, and any nesting depth of `@graph`. Shared by
 * extractJsonLdTypes (Structured Data) and extractNap (Local SEO) so both
 * sections read the same underlying nodes and can't disagree with each
 * other about what schema is actually present.
 */
function flattenJsonLdNodes(parsed: unknown): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    const obj = value as Record<string, unknown>;
    nodes.push(obj);
    if (obj["@graph"] !== undefined) visit(obj["@graph"]);
  };
  visit(parsed);
  return nodes;
}

/** All `@type` values found across a parsed JSON-LD document (including inside @graph), deduped. `@type` can be a single string or an array of strings on any one node — schema.org allows multi-type nodes (e.g. a LocalBusiness that's also a Store). */
function extractJsonLdTypes(parsed: unknown): string[] {
  const types = flattenJsonLdNodes(parsed).flatMap((node) => {
    const t = node["@type"];
    if (typeof t === "string") return [t];
    if (Array.isArray(t)) return t.filter((x): x is string => typeof x === "string");
    return [];
  });
  return [...new Set(types)];
}

/** Prefers structured data (JSON-LD `name`/`address`, `tel:` links) over free-text scanning — much more reliable, and free-text address extraction from arbitrary page copy isn't reliable enough to be worth attempting. Free-text phone matching is kept as a fallback since not every site marks up its phone number as a tel: link. */
function extractNap(html: string): NapInfo {
  let name: string | null = null;
  let address: string | null = null;
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(m[1].trim());
      for (const node of flattenJsonLdNodes(parsed)) {
        if (!name && typeof node.name === "string") name = node.name;
        if (!address && node.address && typeof node.address === "object") {
          const a = node.address as Record<string, unknown>;
          const parts = [a.streetAddress, a.addressLocality, a.addressRegion, a.postalCode].filter(
            (p): p is string => typeof p === "string" && p.trim().length > 0
          );
          if (parts.length > 0) address = parts.join(", ");
        }
      }
    } catch {
      // ignore invalid JSON-LD — already flagged in the Structured Data section
    }
  }
  if (!name) {
    name = extractFirst(html, [/<meta\s+property=["']og:site_name["']\s+content=["']([^"']*)["']/i]);
  }

  const telHrefs = [...html.matchAll(/href=["']tel:([^"']+)["']/gi)].map((m) => m[1].trim());
  const textPhones = [...bodyTextOf(html).matchAll(/\(?\b\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g)].map((m) => m[0]);
  const phones = [...new Set([...telHrefs, ...textPhones])];

  return { name, phones, address };
}

const LOCAL_BUSINESS_SCHEMA_TYPES = new Set([
  "LocalBusiness",
  "Dentist",
  "MedicalBusiness",
  "Physician",
  "MedicalClinic",
  "Restaurant",
  "FoodEstablishment",
  "Store",
  "ProfessionalService",
  "LegalService",
  "Attorney",
  "RealEstateAgent",
  "HomeAndConstructionBusiness",
  "AutomotiveBusiness",
  "AutoRepair",
  "HealthAndBeautyBusiness",
  "VeterinaryCare",
  "InsuranceAgency",
  "AccountingService",
  "Plumber",
  "Electrician",
  "HVACBusiness",
]);

/** Lightweight keyword hints (checked against crawled page copy) for suggesting a specific LocalBusiness subtype — not a claim of certainty, just a directional flag when generic/no local schema is present. */
const VERTICAL_SCHEMA_HINTS: { keywords: string[]; type: string; label: string }[] = [
  { keywords: ["orthodont"], type: "Dentist", label: "orthodontic practice" },
  { keywords: ["dentist", "dental"], type: "Dentist", label: "dental practice" },
  { keywords: ["veterinar"], type: "VeterinaryCare", label: "veterinary practice" },
  { keywords: ["physician", "medical clinic", "family medicine", "urgent care", "clinic"], type: "MedicalBusiness", label: "medical practice" },
  { keywords: ["attorney", "law firm", "lawyer"], type: "LegalService", label: "law firm" },
  { keywords: ["restaurant", "reservations", "our menu"], type: "Restaurant", label: "restaurant" },
  { keywords: ["realtor", "real estate agent", "property listings"], type: "RealEstateAgent", label: "real estate business" },
  { keywords: ["plumbing", "hvac", "general contractor", "remodeling"], type: "HomeAndConstructionBusiness", label: "home services business" },
  { keywords: ["hair salon", "day spa", "esthetician"], type: "HealthAndBeautyBusiness", label: "salon/spa" },
];

function analyzeLocalBusinessSchema(pages: PageReport[], lowerHomepageText: string): string[] {
  const allTypes = [...new Set(pages.flatMap((p) => p.jsonLd.filter((b) => b.valid).flatMap((b) => b.types)))];
  const notes: string[] = [];
  notes.push(allTypes.length > 0 ? `Schema type(s) found: ${allTypes.join(", ")}.` : "No structured data (JSON-LD) types found on the pages checked.");

  const hasLocalBusinessType = allTypes.some((t) => LOCAL_BUSINESS_SCHEMA_TYPES.has(t));
  if (!hasLocalBusinessType) {
    const hint = VERTICAL_SCHEMA_HINTS.find((h) => h.keywords.some((k) => lowerHomepageText.includes(k)));
    if (hint) {
      notes.push(
        `Page content suggests this may be a ${hint.label} — schema.org's "${hint.type}" (a LocalBusiness subtype) would likely be more appropriate than ${
          allTypes.length > 0 ? `the generic type(s) currently used (${allTypes.join(", ")})` : "having no local-business schema at all"
        }, and would typically help local search/AI visibility more.`
      );
    } else if (allTypes.length > 0) {
      notes.push("None of the schema type(s) found is a LocalBusiness subtype — if this is a local service business, a more specific type (e.g. LocalBusiness or an appropriate subtype) would likely help local search visibility.");
    }
  }
  return notes;
}

function checkGoogleMapsEmbed(html: string): boolean {
  return /google\.com\/maps|maps\.google\.com|goo\.gl\/maps/i.test(html);
}

const LOCATION_PAGE_PATTERN = /\/(locations?|service-areas?|areas?-we-serve|near-me)\b/i;

/** Runs against the FULL discovered URL list, not just the (smaller) sample of pages actually fetched — a real signal available without extra requests. */
function detectLocationPages(discoveredPages: string[]): string[] {
  return discoveredPages.filter((u) => {
    try {
      return LOCATION_PAGE_PATTERN.test(new URL(u).pathname);
    } catch {
      return false;
    }
  });
}

function buildLocalSeoNotes(pages: PageReport[], discoveredPages: string[], homepageHtml: string): string[] {
  const notes: string[] = [];

  const namesFound = [...new Set(pages.map((p) => p.nap.name).filter((n): n is string => !!n))];
  const phonesFound = [...new Set(pages.flatMap((p) => p.nap.phones))];
  const addressesFound = [...new Set(pages.map((p) => p.nap.address).filter((a): a is string => !!a))];

  if (phonesFound.length === 0 && addressesFound.length === 0) {
    notes.push(`No phone number or structured (schema) address found on the ${pages.length} page(s) checked — NAP consistency could not be evaluated.`);
  } else {
    notes.push(
      phonesFound.length === 0
        ? "No phone number found on the pages checked."
        : phonesFound.length === 1
          ? `Phone number ${phonesFound[0]} is consistent across the pages checked.`
          : `Phone numbers found are NOT consistent across pages checked: ${phonesFound.join(", ")}.`
    );
    notes.push(
      addressesFound.length === 0
        ? "No structured (schema) address found on the pages checked — NAP address consistency could not be verified from markup."
        : addressesFound.length === 1
          ? `Address "${addressesFound[0]}" is consistent across the pages checked that included structured address data.`
          : `Addresses found are NOT consistent across pages checked: ${addressesFound.map((a) => `"${a}"`).join(" vs. ")}.`
    );
    if (namesFound.length > 1) {
      notes.push(`Business name is NOT consistent across pages checked: ${namesFound.map((n) => `"${n}"`).join(" vs. ")}.`);
    }
  }

  notes.push(...analyzeLocalBusinessSchema(pages, bodyTextOf(homepageHtml).toLowerCase()));

  notes.push(checkGoogleMapsEmbed(homepageHtml) ? "Google Maps/Business Profile embed found on the homepage." : "No Google Maps/Business Profile embed found on the homepage.");

  const locationPages = detectLocationPages(discoveredPages);
  notes.push(
    locationPages.length > 0
      ? `${locationPages.length} location/service-area-style URL(s) found across the full site crawl (${discoveredPages.length} URLs discovered): ${locationPages.slice(0, 10).join(", ")}${locationPages.length > 10 ? ", …" : ""}.`
      : `No location- or service-area-specific URLs detected among the ${discoveredPages.length} URLs discovered in the crawl.`
  );

  return notes;
}

interface PageReport {
  url: string;
  title: string | null;
  metaDescription: string | null;
  canonical: string | null;
  robotsMeta: string | null;
  h1s: string[];
  headingSequence: string[];
  imgTotal: number;
  imgWithAlt: number;
  ogTags: Record<string, string>;
  twitterTags: Record<string, string>;
  jsonLd: { types: string[]; valid: boolean }[];
  internalLinks: string[];
  wordCount: number;
  nap: NapInfo;
}

function analyzePage(url: string, html: string): PageReport {
  const title = extractFirst(html, [/<title[^>]*>([^<]*)<\/title>/i]);
  const metaDescription = extractFirst(html, [
    /<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i,
    /<meta\s+content=["']([^"']*)["']\s+name=["']description["']/i,
  ]);
  const canonical = extractFirst(html, [/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']*)["']/i]);
  const robotsMeta = extractFirst(html, [/<meta\s+name=["']robots["']\s+content=["']([^"']*)["']/i]);

  const h1s = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) => stripTags(m[1]));
  const headingSequence = [...html.matchAll(/<h([1-6])[^>]*>/gi)].map((m) => `h${m[1]}`);

  const imgTags = [...html.matchAll(/<img\b[^>]*>/gi)];
  const imgWithAlt = imgTags.filter((m) => /\balt=["'][^"']+["']/i.test(m[0])).length;

  const ogTags: Record<string, string> = {};
  for (const m of html.matchAll(/<meta\s+property=["']og:([a-z:]+)["']\s+content=["']([^"']*)["']/gi)) {
    ogTags[m[1]] = m[2];
  }
  const twitterTags: Record<string, string> = {};
  for (const m of html.matchAll(/<meta\s+name=["']twitter:([a-z:]+)["']\s+content=["']([^"']*)["']/gi)) {
    twitterTags[m[1]] = m[2];
  }

  const jsonLd = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map((m) => {
    try {
      const parsed = JSON.parse(m[1].trim());
      return { types: extractJsonLdTypes(parsed), valid: true };
    } catch {
      return { types: [], valid: false };
    }
  });

  const internalLinks = [...new Set([...html.matchAll(/<a\s[^>]*href=["']([^"'#]+)["']/gi)].map((m) => m[1]))];

  return {
    url,
    title,
    metaDescription,
    canonical,
    robotsMeta,
    h1s,
    headingSequence,
    imgTotal: imgTags.length,
    imgWithAlt,
    ogTags,
    twitterTags,
    jsonLd,
    internalLinks,
    wordCount: wordCountOf(html),
    nap: extractNap(html),
  };
}

function findDuplicates(pages: PageReport[], field: "title" | "metaDescription"): string[] {
  const seen = new Map<string, string[]>();
  for (const p of pages) {
    const val = p[field];
    if (!val) continue;
    seen.set(val, [...(seen.get(val) ?? []), p.url]);
  }
  return [...seen.entries()]
    .filter(([, urls]) => urls.length > 1)
    .map(([val, urls]) => `"${val}" is used on ${urls.length} pages: ${urls.join(", ")}`);
}

function headingOrderIssues(page: PageReport): string[] {
  const issues: string[] = [];
  const h1Count = page.headingSequence.filter((h) => h === "h1").length;
  if (h1Count === 0) issues.push(`${page.url}: no H1 found`);
  if (h1Count > 1) issues.push(`${page.url}: ${h1Count} H1s found (should be exactly one)`);

  let lastLevel = 0;
  for (const h of page.headingSequence) {
    const level = Number(h[1]);
    if (lastLevel > 0 && level > lastLevel + 1) {
      issues.push(`${page.url}: heading level skips from H${lastLevel} to H${level} (${h.toUpperCase()} appears before an H${lastLevel + 1})`);
      break;
    }
    lastLevel = level;
  }
  return issues;
}

function thinContentIssues(pages: PageReport[]): string[] {
  return pages.filter((p) => p.wordCount < THIN_CONTENT_WORD_THRESHOLD).map((p) => `${p.url}: ~${p.wordCount} words (under the ${THIN_CONTENT_WORD_THRESHOLD}-word guideline for a substantive page)`);
}

async function checkInternalLinks(origin: string, pages: PageReport[]): Promise<string[]> {
  const candidates = [...new Set(pages.flatMap((p) => p.internalLinks))]
    .map((href) => {
      try {
        return new URL(href, origin).toString();
      } catch {
        return null;
      }
    })
    .filter((url): url is string => url !== null && url.startsWith(origin))
    .slice(0, LINK_CHECK_SAMPLE);

  const results = await Promise.all(
    candidates.map(async (url) => {
      try {
        const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { "User-Agent": USER_AGENT } });
        return res.ok ? null : `${url}: HTTP ${res.status}`;
      } catch {
        return `${url}: request failed`;
      }
    })
  );
  return results.filter((r): r is string => r !== null);
}

async function checkCustom404(origin: string): Promise<string> {
  const probeUrl = `${origin}/brandaify-audit-404-check-${Date.now()}`;
  const res = await fetchText(probeUrl);
  if (!res) return "Could not check — request failed.";
  if (res.status === 404) return "Returns a proper 404 status for a nonexistent page.";
  return `Returns HTTP ${res.status} for a nonexistent page instead of 404 — worth checking whether missing pages are handled correctly.`;
}

async function checkRobotsAndAI(origin: string): Promise<{ raw: string | null; aiCrawlerNotes: string[]; sitemapNoted: boolean; sitemapUrls: string[] }> {
  const res = await fetchText(`${origin}/robots.txt`);
  if (!res || res.status !== 200) {
    return {
      raw: null,
      aiCrawlerNotes: AI_CRAWLER_AGENTS.map((a) => `${a}: robots.txt not found — no explicit rule, so ${a} is allowed by default.`),
      sitemapNoted: false,
      sitemapUrls: [],
    };
  }
  const raw = res.text;
  const sitemapUrls = [...raw.matchAll(/^sitemap:\s*(\S+)/gim)].map((m) => m[1]);

  const blocks = raw.split(/(?=^user-agent:)/im);
  const notes: string[] = [];
  for (const agent of AI_CRAWLER_AGENTS) {
    const block = blocks.find((b) => new RegExp(`^user-agent:\\s*${agent}\\b`, "im").test(b));
    if (!block) {
      notes.push(`${agent}: no specific rule in robots.txt — allowed by default (unless a wildcard "*" block disallows everything).`);
      continue;
    }
    const disallowAll = /^disallow:\s*\/\s*$/im.test(block);
    notes.push(disallowAll ? `${agent}: explicitly disallowed (Disallow: /).` : `${agent}: has a specific rule and is not fully disallowed.`);
  }
  return { raw, aiCrawlerNotes: notes, sitemapNoted: sitemapUrls.length > 0, sitemapUrls };
}

async function checkLlmsTxt(origin: string): Promise<boolean> {
  const res = await fetchText(`${origin}/llms.txt`, 5000);
  return res !== null && res.status === 200;
}

function checkSemanticHtml(homepageHtml: string): string[] {
  const found: string[] = [];
  const missing: string[] = [];
  for (const tag of ["header", "nav", "main", "footer"]) {
    if (new RegExp(`<${tag}\\b`, "i").test(homepageHtml)) found.push(tag);
    else missing.push(tag);
  }
  const notes: string[] = [];
  if (found.length > 0) notes.push(`Uses semantic HTML5 landmarks: ${found.join(", ")}.`);
  if (missing.length > 0) notes.push(`Missing semantic landmarks: ${missing.join(", ")} — these help both accessibility tools and AI crawlers understand page structure.`);
  return notes;
}

/** Absence/presence only, pulled straight from the response headers already fetched for every other check — no extra requests. */
function securityHeaderNotes(headers: Headers | undefined): string[] {
  const check = (headerName: string, label: string) => {
    const value = headers?.get(headerName);
    if (!value) return `${label}: not present.`;
    const shown = value.length > 100 ? `${value.slice(0, 100)}…` : value;
    return `${label}: present ("${shown}").`;
  };
  return [
    check("content-security-policy", "Content-Security-Policy"),
    check("x-frame-options", "X-Frame-Options"),
    check("x-content-type-options", "X-Content-Type-Options"),
    check("referrer-policy", "Referrer-Policy"),
  ];
}

/** HTTP resources loading on an HTTPS page — a common WordPress/legacy-content issue, checkable from the already-fetched HTML with no extra requests. Broad on purpose (script/img/link/iframe src or href) rather than narrowly scoped to obviously-render-affecting tags — flagged as "resource references," not a claim every hit blocks rendering. */
function findMixedContent(pageUrl: string, html: string): string[] {
  if (!pageUrl.startsWith("https://")) return [];
  const matches = [...html.matchAll(/<(?:script|img|link|iframe)\b[^>]*\b(?:src|href)=["']http:\/\/([^"']+)["']/gi)];
  return [...new Set(matches.map((m) => `http://${m[1]}`))];
}

const ANALYTICS_SIGNATURES: { pattern: RegExp; label: string }[] = [
  { pattern: /googletagmanager\.com\/gtm\.js|\bdataLayer\s*=/i, label: "Google Tag Manager" },
  { pattern: /gtag\(|googletagmanager\.com\/gtag\/js|www\.google-analytics\.com|\bga\(['"]create['"]/i, label: "Google Analytics (gtag.js/GA4/Universal Analytics)" },
  { pattern: /connect\.facebook\.net\/[^"'\s]*\/fbevents\.js|fbq\(/i, label: "Meta Pixel" },
];

function detectAnalytics(html: string): string[] {
  return ANALYTICS_SIGNATURES.filter((s) => s.pattern.test(html)).map((s) => s.label);
}

function detectConversionSignals(html: string): string[] {
  const signals: string[] = [];
  if (/href=["']tel:/i.test(html)) signals.push("click-to-call phone link");
  if (/<form\b/i.test(html)) signals.push("on-page form");
  return signals;
}

interface RedirectHopResult {
  hops: number;
  finalUrl: string;
  chain: string[];
}

/** Follows redirects manually (HEAD, redirect: "manual") instead of letting fetch auto-follow, so the hop count and intermediate URLs are actually observable — that's the whole point of this check. Returns null only when the very first request fails outright (a mid-chain failure still reports what was found up to that point). */
async function countRedirectHops(url: string, maxHops = MAX_REDIRECT_HOPS): Promise<RedirectHopResult | null> {
  let current = url;
  const chain: string[] = [];
  for (let i = 0; i < maxHops; i++) {
    let res: Response;
    try {
      res = await fetch(current, {
        method: "HEAD",
        redirect: "manual",
        signal: AbortSignal.timeout(REDIRECT_CHECK_TIMEOUT_MS),
        headers: { "User-Agent": USER_AGENT },
      });
    } catch {
      return chain.length > 0 ? { hops: chain.length, finalUrl: current, chain } : null;
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return { hops: chain.length, finalUrl: current, chain };
      chain.push(current);
      try {
        current = new URL(location, current).toString();
      } catch {
        return { hops: chain.length, finalUrl: current, chain };
      }
      continue;
    }
    return { hops: chain.length, finalUrl: current, chain };
  }
  return { hops: chain.length, finalUrl: current, chain };
}

/** Checks www/non-www and http/https variants of the domain all resolve cleanly (single hop) to the canonical URL, plus samples the crawled pages for multi-hop chains found elsewhere. Labeled as a sample in its own output line per the crawled-page half. */
async function checkRedirectConsistency(origin: string, sampledPageUrls: string[]): Promise<string[]> {
  const parsedOrigin = new URL(origin);
  const bareHost = parsedOrigin.hostname.replace(/^www\./, "");
  const wwwHost = `www.${bareHost}`;
  const canonicalNoSlash = origin.replace(/\/$/, "");

  const variants = [`http://${bareHost}/`, `https://${bareHost}/`, `http://${wwwHost}/`, `https://${wwwHost}/`].filter(
    (v) => v.replace(/\/$/, "") !== canonicalNoSlash
  );

  const [domainResults, pageResults] = await Promise.all([
    Promise.all(variants.map((v) => countRedirectHops(v))),
    Promise.all(sampledPageUrls.map((u) => countRedirectHops(u))),
  ]);

  const notes: string[] = [];
  variants.forEach((variant, i) => {
    const result = domainResults[i];
    if (!result) {
      notes.push(`${variant}: request failed — could not check redirect behavior.`);
      return;
    }
    const finalNoSlash = result.finalUrl.replace(/\/$/, "");
    if (finalNoSlash !== canonicalNoSlash) {
      notes.push(
        result.hops === 0
          ? `${variant} loads directly rather than redirecting to the canonical ${origin}/ — two independently-reachable versions can split SEO signal.`
          : `${variant} redirects to ${result.finalUrl}, not the canonical ${origin}/ — worth checking this variant's redirect target.`
      );
    } else if (result.hops > 1) {
      notes.push(`${variant} reaches the canonical URL via a ${result.hops}-hop redirect chain (${[...result.chain, result.finalUrl].join(" → ")}) — should be a single clean redirect.`);
    } else if (result.hops === 1) {
      notes.push(`${variant} redirects cleanly to the canonical URL in one hop.`);
    }
  });

  const chainIssues = sampledPageUrls
    .map((url, i) => ({ url, result: pageResults[i] }))
    .filter((r): r is { url: string; result: RedirectHopResult } => r.result !== null && r.result.hops > 1)
    .map((r) => `${r.url}: ${r.result.hops}-hop chain to ${r.result.finalUrl}`);

  notes.push(
    chainIssues.length > 0
      ? `Redirect chains found elsewhere in the crawl (${sampledPageUrls.length}-page sample): ${chainIssues.join("; ")}.`
      : `No multi-hop redirect chains found among the ${sampledPageUrls.length} page(s) checked (sample, not the full site).`
  );

  return notes;
}

/** Fetches the sitemap URL(s) discovered in robots.txt (falling back to the default /sitemap.xml location if none were listed), confirms it parses as XML, counts URLs, and status-checks a bounded SAMPLE of them — clearly labeled as such, not a full-site check. */
async function validateSitemap(origin: string, sitemapUrls: string[], crawledUrls: string[]): Promise<string[]> {
  const candidateUrl = sitemapUrls[0] ?? `${origin}/sitemap.xml`;
  const res = await fetchText(candidateUrl, 8000);
  if (!res || res.status !== 200) {
    return [`Sitemap (${candidateUrl}): could not fetch (${res ? `HTTP ${res.status}` : "request failed"}).`];
  }
  const xml = res.text;
  if (!/<\?xml|<urlset|<sitemapindex/i.test(xml)) {
    return [`Sitemap (${candidateUrl}): fetched successfully but doesn't look like valid XML.`];
  }

  const isIndex = /<sitemapindex/i.test(xml);
  const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
  const notes: string[] = [
    `Sitemap (${candidateUrl}): valid XML${isIndex ? ", a sitemap INDEX" : ""}, ${isIndex ? "referencing" : "listing"} ${locs.length} URL${locs.length === 1 ? "" : "s"}${isIndex ? " (sub-sitemaps, not individually checked here)" : ""}.`,
  ];

  if (!isIndex && locs.length > 0) {
    const sample = locs.slice(0, SITEMAP_URL_CHECK_SAMPLE);
    const statusResults = await Promise.all(
      sample.map(async (loc) => {
        try {
          const r = await fetch(loc, { method: "HEAD", signal: AbortSignal.timeout(6000), headers: { "User-Agent": USER_AGENT } });
          return r.ok ? null : `${loc}: HTTP ${r.status}`;
        } catch {
          return `${loc}: request failed`;
        }
      })
    );
    const badUrls = statusResults.filter((r): r is string => r !== null);
    notes.push(
      badUrls.length > 0
        ? `Sitemap URL status check (${sample.length}-URL sample of ${locs.length} listed): ${badUrls.length} issue(s) — ${badUrls.join("; ")}.`
        : `Sitemap URL status check (${sample.length}-URL sample of ${locs.length} listed): all returned OK.`
    );

    const normalizedLocs = new Set(locs.map((l) => l.replace(/\/$/, "")));
    const crawledNotInSitemap = crawledUrls.filter((u) => !normalizedLocs.has(u.replace(/\/$/, "")));
    notes.push(
      crawledNotInSitemap.length > 0
        ? `${crawledNotInSitemap.length} of the ${crawledUrls.length} page(s) checked in this audit are not listed in the sitemap: ${crawledNotInSitemap.join(", ")}.`
        : `All ${crawledUrls.length} page(s) checked in this audit are listed in the sitemap.`
    );
  }

  return notes;
}

export interface TechnicalAuditResult {
  hostname: string;
  markdown: string;
  pagesCrawled: number;
}

/**
 * Runs the fast (plain-HTTP, no Browserless) half of a Technical Audit:
 * meta/indexability, structure/hierarchy, structured data, local SEO,
 * technical hygiene (incl. security headers, mixed content, redirect
 * consistency), analytics/conversion-tracking presence, and AI-visibility
 * checks. The Core Web Vitals / PageSpeed Insights piece is a separate
 * function (pagespeed.ts) invoked as its own request — see that file's doc
 * comment for why.
 */
export async function runTechnicalAuditFast(siteUrl: string, discoveredPages: string[]): Promise<TechnicalAuditResult> {
  const origin = new URL(siteUrl).origin;
  const pageUrls = discoveredPages.slice(0, TECH_MAX_PAGES);

  const [fetched, robotsInfo] = await Promise.all([Promise.all(pageUrls.map((url) => fetchText(url))), checkRobotsAndAI(origin)]);

  const pages: PageReport[] = [];
  const fetchedUrls: string[] = [];
  const mixedContentNotes: string[] = [];
  const analyticsFound = new Set<string>();
  const conversionSignals = new Set<string>();
  pageUrls.forEach((url, i) => {
    const f = fetched[i];
    if (!f) return;
    pages.push(analyzePage(url, f.text));
    fetchedUrls.push(url);
    for (const a of detectAnalytics(f.text)) analyticsFound.add(a);
    for (const c of detectConversionSignals(f.text)) conversionSignals.add(c);
    const mixed = findMixedContent(url, f.text);
    if (mixed.length > 0) mixedContentNotes.push(`${url}: ${mixed.length} HTTP resource(s) referenced — ${mixed.slice(0, 5).join(", ")}${mixed.length > 5 ? ", …" : ""}.`);
  });

  if (pages.length === 0) {
    throw new Error(`Could not fetch any pages for ${siteUrl}.`);
  }

  const httpsRes = fetched.find((f) => f !== null) ?? null;
  const hasHsts = httpsRes?.headers.get("strict-transport-security") != null;

  const [linkIssues, custom404, llmsTxtExists, geoReadability, sitemapNotes, redirectNotes] = await Promise.all([
    checkInternalLinks(origin, pages),
    checkCustom404(origin),
    checkLlmsTxt(origin),
    checkGeoReadability(httpsRes?.text ?? ""),
    validateSitemap(origin, robotsInfo.sitemapUrls, fetchedUrls),
    checkRedirectConsistency(origin, fetchedUrls),
  ]);

  const duplicateTitles = findDuplicates(pages, "title");
  const duplicateDescriptions = findDuplicates(pages, "metaDescription");
  const headingIssues = pages.flatMap(headingOrderIssues);
  const thinContent = thinContentIssues(pages);
  const totalImgs = pages.reduce((sum, p) => sum + p.imgTotal, 0);
  const imgsWithAlt = pages.reduce((sum, p) => sum + p.imgWithAlt, 0);
  const altCoveragePct = totalImgs > 0 ? Math.round((imgsWithAlt / totalImgs) * 100) : null;

  const jsonLdSummary = pages.flatMap((p) =>
    p.jsonLd.map((block) =>
      block.valid
        ? `${p.url}: ${block.types.length > 0 ? block.types.join(", ") : "unknown type"} schema found.`
        : `${p.url}: JSON-LD block present but failed to parse as valid JSON.`
    )
  );

  const semanticNotes = checkSemanticHtml(httpsRes?.text ?? "");
  const localSeoNotes = buildLocalSeoNotes(pages, discoveredPages, httpsRes?.text ?? "");

  const sections = [
    `# Website Audit (Technical) — ${origin.replace(/^https?:\/\//, "")}`,
    "",
    `${pages.length} page(s) checked.`,
    "",
    "## Meta & Indexability",
    "",
    ...pages.map(
      (p) =>
        `- ${p.url}\n  - Title: ${p.title ?? "(missing)"} (${p.title?.length ?? 0} chars)\n  - Meta description: ${p.metaDescription ?? "(missing)"} (${p.metaDescription?.length ?? 0} chars)\n  - Canonical: ${p.canonical ?? "(missing)"}\n  - Robots meta: ${p.robotsMeta ?? "(none — indexable by default)"}\n  - Open Graph tags: ${Object.keys(p.ogTags).length > 0 ? Object.entries(p.ogTags).map(([k, v]) => `${k}="${v}"`).join(", ") : "(none found)"}\n  - Twitter Card tags: ${Object.keys(p.twitterTags).length > 0 ? Object.entries(p.twitterTags).map(([k, v]) => `${k}="${v}"`).join(", ") : "(none found)"}`
    ),
    duplicateTitles.length > 0 ? `- Duplicate titles: ${duplicateTitles.join("; ")}` : "- No duplicate titles found across the pages checked.",
    duplicateDescriptions.length > 0 ? `- Duplicate meta descriptions: ${duplicateDescriptions.join("; ")}` : "- No duplicate meta descriptions found across the pages checked.",
    `- robots.txt: ${robotsInfo.raw ? "found" : "not found"}.${robotsInfo.raw ? `\n\`\`\`\n${robotsInfo.raw.slice(0, 2000)}\n\`\`\`` : ""}`,
    `- XML sitemap: ${robotsInfo.sitemapNoted ? "referenced in robots.txt" : "not referenced in robots.txt (falling back to the default /sitemap.xml location for the check below)."}`,
    ...sitemapNotes.map((n) => `- ${n}`),
    "",
    "## Structure & Content Hierarchy",
    "",
    headingIssues.length > 0 ? headingIssues.map((i) => `- Heading issue — ${i}`).join("\n") : "- No H1/heading-order issues found on the pages checked.",
    altCoveragePct !== null ? `- Image alt text coverage: ${altCoveragePct}% (${imgsWithAlt} of ${totalImgs} images have alt text).` : "- No images found on the pages checked.",
    linkIssues.length > 0
      ? `- Internal link check (${LINK_CHECK_SAMPLE}-link sample): ${linkIssues.length} issue(s) found — ${linkIssues.join("; ")}`
      : `- Internal link check (${LINK_CHECK_SAMPLE}-link sample): no broken links found in this sample.`,
    `- Custom 404 page: ${custom404}`,
    `- Word count (pages checked): ${pages.map((p) => `${p.url} — ~${p.wordCount} words`).join("; ")}.`,
    thinContent.length > 0
      ? `- Thin content flagged (under ${THIN_CONTENT_WORD_THRESHOLD} words): ${thinContent.join("; ")}`
      : `- No pages flagged as thin content (all at or above the ${THIN_CONTENT_WORD_THRESHOLD}-word guideline).`,
    "",
    "## Structured Data",
    "",
    jsonLdSummary.length > 0 ? jsonLdSummary.map((s) => `- ${s}`).join("\n") : "- No JSON-LD structured data found on the pages checked.",
    "",
    "## Local SEO",
    "",
    ...localSeoNotes.map((n) => `- ${n}`),
    "",
    "## Technical Hygiene",
    "",
    `- HTTPS: ${siteUrl.startsWith("https://") ? "in use" : "NOT in use — site is served over plain HTTP"}.`,
    `- HSTS header: ${hasHsts ? "present" : "not present"}.`,
    ...securityHeaderNotes(httpsRes?.headers).map((n) => `- ${n}`),
    ...semanticNotes.map((n) => `- ${n}`),
    mixedContentNotes.length > 0
      ? `- Mixed content (HTTP resources on HTTPS pages): ${mixedContentNotes.join(" ")}`
      : "- No mixed content (HTTP resources on HTTPS pages) found on the pages checked.",
    ...redirectNotes.map((n) => `- Redirect/canonicalization: ${n}`),
    "",
    "## Analytics & Conversion Tracking",
    "",
    analyticsFound.size > 0 ? `- Analytics/tag-manager scripts detected: ${[...analyticsFound].join(", ")}.` : "- No common analytics/tag-manager scripts (GA/GA4, GTM, Meta Pixel) detected.",
    conversionSignals.size > 0
      ? `- Conversion-tracking-relevant signals found: ${[...conversionSignals].join(", ")}. (Presence only — this doesn't verify tracking is firing correctly.)`
      : "- No obvious conversion-tracking signals (click-to-call link, on-page form) found on the pages checked.",
    "",
    "## AI Visibility (GEO)",
    "",
    ...robotsInfo.aiCrawlerNotes.map((n) => `- ${n}`),
    `- llms.txt: ${llmsTxtExists ? "found at /llms.txt." : "not found — this is an emerging, optional standard, so its absence is not itself a problem."}`,
    `- AI-summarizability (homepage): ${geoReadability}`,
  ];

  return {
    hostname: origin.replace(/^https?:\/\//, ""),
    markdown: sections.join("\n\n"),
    pagesCrawled: pages.length,
  };
}
