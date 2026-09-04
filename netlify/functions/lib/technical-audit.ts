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
// fix anything (no schema injection, no meta-tag generation).

import { analyzeGeoReadability } from "./tone-analysis";

const TECH_MAX_PAGES = 4;
const LINK_CHECK_SAMPLE = 8;
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

function extractBodyText(html: string): string {
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  const body = bodyMatch ? bodyMatch[1] : html;
  const withoutScripts = body.replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, "");
  return stripTags(withoutScripts).slice(0, 15000);
}

/** Graceful — the rest of Technical Audit doesn't depend on an Anthropic key, so a missing one degrades this one note rather than failing the whole report. */
async function checkGeoReadability(homepageHtml: string): Promise<string> {
  try {
    return await analyzeGeoReadability(extractBodyText(homepageHtml));
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return `Skipped — ${message}`;
  }
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
  jsonLd: { type: string | null; valid: boolean }[];
  internalLinks: string[];
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
      const type = Array.isArray(parsed) ? (parsed[0]?.["@type"] ?? null) : (parsed?.["@type"] ?? null);
      return { type, valid: true };
    } catch {
      return { type: null, valid: false };
    }
  });

  const internalLinks = [...new Set([...html.matchAll(/<a\s[^>]*href=["']([^"'#]+)["']/gi)].map((m) => m[1]))];

  return { url, title, metaDescription, canonical, robotsMeta, h1s, headingSequence, imgTotal: imgTags.length, imgWithAlt, ogTags, twitterTags, jsonLd, internalLinks };
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

async function checkRobotsAndAI(origin: string): Promise<{ raw: string | null; aiCrawlerNotes: string[]; sitemapNoted: boolean }> {
  const res = await fetchText(`${origin}/robots.txt`);
  if (!res || res.status !== 200) {
    return { raw: null, aiCrawlerNotes: AI_CRAWLER_AGENTS.map((a) => `${a}: robots.txt not found — no explicit rule, so ${a} is allowed by default.`), sitemapNoted: false };
  }
  const raw = res.text;
  const sitemapNoted = /sitemap:/i.test(raw);

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
  return { raw, aiCrawlerNotes: notes, sitemapNoted };
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

export interface TechnicalAuditResult {
  hostname: string;
  markdown: string;
  pagesCrawled: number;
}

/**
 * Runs the fast (plain-HTTP, no Browserless) half of a Technical Audit:
 * meta/indexability, structure/hierarchy, structured data, technical
 * hygiene, and AI-visibility checks. The Core Web Vitals / PageSpeed
 * Insights piece is a separate function (pagespeed.ts) invoked as its own
 * request — see that file's doc comment for why.
 */
export async function runTechnicalAuditFast(siteUrl: string, discoveredPages: string[]): Promise<TechnicalAuditResult> {
  const origin = new URL(siteUrl).origin;
  const pageUrls = discoveredPages.slice(0, TECH_MAX_PAGES);

  const fetched = await Promise.all(pageUrls.map((url) => fetchText(url)));
  const pages = pageUrls
    .map((url, i) => (fetched[i] ? analyzePage(url, fetched[i]!.text) : null))
    .filter((p): p is PageReport => p !== null);

  if (pages.length === 0) {
    throw new Error(`Could not fetch any pages for ${siteUrl}.`);
  }

  const [linkIssues, custom404, robotsInfo, llmsTxtExists, geoReadability] = await Promise.all([
    checkInternalLinks(origin, pages),
    checkCustom404(origin),
    checkRobotsAndAI(origin),
    checkLlmsTxt(origin),
    checkGeoReadability(fetched[0]?.text ?? ""),
  ]);

  const httpsRes = fetched[0];
  const hasHsts = httpsRes?.headers.get("strict-transport-security") != null;

  const duplicateTitles = findDuplicates(pages, "title");
  const duplicateDescriptions = findDuplicates(pages, "metaDescription");
  const headingIssues = pages.flatMap(headingOrderIssues);
  const totalImgs = pages.reduce((sum, p) => sum + p.imgTotal, 0);
  const imgsWithAlt = pages.reduce((sum, p) => sum + p.imgWithAlt, 0);
  const altCoveragePct = totalImgs > 0 ? Math.round((imgsWithAlt / totalImgs) * 100) : null;

  const jsonLdSummary = pages.flatMap((p) =>
    p.jsonLd.map((block) => (block.valid ? `${p.url}: ${block.type ?? "unknown type"} schema found.` : `${p.url}: JSON-LD block present but failed to parse as valid JSON.`))
  );

  const semanticNotes = checkSemanticHtml(fetched[0]?.text ?? "");

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
    `- XML sitemap: ${robotsInfo.sitemapNoted ? "referenced in robots.txt" : "not referenced in robots.txt (may still exist at a default location)."}`,
    "",
    "## Structure & Content Hierarchy",
    "",
    headingIssues.length > 0 ? headingIssues.map((i) => `- Heading issue — ${i}`).join("\n") : "- No H1/heading-order issues found on the pages checked.",
    altCoveragePct !== null ? `- Image alt text coverage: ${altCoveragePct}% (${imgsWithAlt} of ${totalImgs} images have alt text).` : "- No images found on the pages checked.",
    linkIssues.length > 0
      ? `- Internal link check (${LINK_CHECK_SAMPLE}-link sample): ${linkIssues.length} issue(s) found — ${linkIssues.join("; ")}`
      : `- Internal link check (${LINK_CHECK_SAMPLE}-link sample): no broken links found in this sample.`,
    `- Custom 404 page: ${custom404}`,
    "",
    "## Structured Data",
    "",
    jsonLdSummary.length > 0 ? jsonLdSummary.map((s) => `- ${s}`).join("\n") : "- No JSON-LD structured data found on the pages checked.",
    "",
    "## Technical Hygiene",
    "",
    `- HTTPS: ${siteUrl.startsWith("https://") ? "in use" : "NOT in use — site is served over plain HTTP"}.`,
    `- HSTS header: ${hasHsts ? "present" : "not present"}.`,
    ...semanticNotes.map((n) => `- ${n}`),
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
