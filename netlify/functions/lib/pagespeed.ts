// Core Web Vitals / performance / accessibility via Google's PageSpeed
// Insights API — deliberately its own module and its own Research document,
// invoked as a separate HTTP request from the rest of Technical Audit's
// checks (see technical-audit.ts). PSI runs a real Lighthouse audit
// server-side and commonly takes 15-30+ seconds to respond, which alone
// can approach or exceed Netlify's ~30s function limit on this plan — so
// it never gets bundled into the same request as anything else. One PSI
// call also covers performance, mobile-friendliness, and accessibility
// (Lighthouse's accessibility category runs axe-core internally), so no
// separate accessibility-scanning dependency is needed.
//
// Only performance + accessibility are requested (not best-practices/seo,
// which PSI can also return) — live testing showed the full 4-category
// request running long enough to hit Netlify's limit on its own; fewer
// categories means less Lighthouse audit work on Google's end. This
// reduces the timeout risk, it doesn't eliminate it — PSI's own response
// time is otherwise outside this app's control and can still occasionally
// run long regardless.
//
// Needs a Google PageSpeed Insights API key (free, Google Cloud Console —
// enable the "PageSpeed Insights API") set as PAGESPEED_API_KEY.

interface LighthouseAudit {
  title?: string;
  description?: string;
  score?: number | null;
  displayValue?: string;
}

interface PageSpeedApiResponse {
  lighthouseResult?: {
    categories?: {
      performance?: { score: number | null };
      accessibility?: { score: number | null };
    };
    audits?: Record<string, LighthouseAudit>;
  };
}

export interface PageSpeedResult {
  url: string;
  performanceScore: number | null;
  accessibilityScore: number | null;
  lcp: string | null;
  inp: string | null;
  cls: string | null;
  totalByteWeight: string | null;
  mobileFriendly: boolean | null;
  topIssues: string[];
}

function toPercent(score: number | null | undefined): number | null {
  return typeof score === "number" ? Math.round(score * 100) : null;
}

/** Audits whose failure most directly explains a poor score — kept short and specific rather than dumping every failed audit. */
const NOTABLE_AUDIT_IDS = [
  "largest-contentful-paint",
  "cumulative-layout-shift",
  "render-blocking-resources",
  "unused-javascript",
  "viewport",
  "tap-targets",
  "color-contrast",
  "image-alt",
  "meta-description",
  "document-title",
];

export async function runPageSpeedInsights(url: string): Promise<PageSpeedResult> {
  const apiKey = process.env.PAGESPEED_API_KEY;
  if (!apiKey) {
    throw new Error("PAGESPEED_API_KEY is not set — the Performance check needs a Google PageSpeed Insights API key.");
  }

  const endpoint = new URL("https://www.googleapis.com/pagespeedonline/v5/runPagespeed");
  endpoint.searchParams.set("url", url);
  endpoint.searchParams.set("key", apiKey);
  endpoint.searchParams.set("strategy", "mobile");
  // Only the two categories the spec actually asked for (Core Web Vitals +
  // accessibility) — live testing showed the full 4-category request
  // (this plus best-practices/seo) can run long enough to hit Netlify's
  // ~30s request limit. Fewer categories means less Lighthouse audit work
  // on Google's end, which is the only lever available here (PSI's own
  // response time isn't otherwise configurable). best-practices/seo scores
  // were a bonus, not something asked for — losing them is the right
  // trade against reliability.
  for (const category of ["performance", "accessibility"]) {
    endpoint.searchParams.append("category", category);
  }

  const res = await fetch(endpoint.toString(), { signal: AbortSignal.timeout(28000) });
  if (!res.ok) {
    throw new Error(`PageSpeed Insights failed for ${url}: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as PageSpeedApiResponse;
  const categories = data.lighthouseResult?.categories ?? {};
  const audits = data.lighthouseResult?.audits ?? {};

  const topIssues = NOTABLE_AUDIT_IDS.map((id) => audits[id])
    .filter((a): a is LighthouseAudit => a != null && typeof a.score === "number" && a.score < 0.9 && !!a.title)
    .map((a) => `${a.title}${a.displayValue ? ` (${a.displayValue})` : ""}`);

  const viewportAudit = audits["viewport"];

  return {
    url,
    performanceScore: toPercent(categories.performance?.score),
    accessibilityScore: toPercent(categories.accessibility?.score),
    lcp: audits["largest-contentful-paint"]?.displayValue ?? null,
    inp: audits["interactive"]?.displayValue ?? audits["max-potential-fid"]?.displayValue ?? null,
    cls: audits["cumulative-layout-shift"]?.displayValue ?? null,
    totalByteWeight: audits["total-byte-weight"]?.displayValue ?? null,
    mobileFriendly: viewportAudit ? viewportAudit.score === 1 : null,
    topIssues,
  };
}

export function buildPageSpeedMarkdown(auditLabel: string, result: PageSpeedResult): string {
  const sections = [
    `# ${auditLabel} — Performance (PageSpeed Insights)`,
    "",
    `Checked: ${result.url}`,
    "",
    "## Scores (mobile, 0-100)",
    "",
    `- Performance: ${result.performanceScore ?? "n/a"}`,
    `- Accessibility: ${result.accessibilityScore ?? "n/a"}`,
    "",
    "## Core Web Vitals",
    "",
    `- Largest Contentful Paint (LCP): ${result.lcp ?? "n/a"}`,
    `- Interactivity (INP proxy): ${result.inp ?? "n/a"}`,
    `- Cumulative Layout Shift (CLS): ${result.cls ?? "n/a"}`,
    `- Total page weight: ${result.totalByteWeight ?? "n/a"}`,
    `- Mobile-friendly (viewport configured correctly): ${result.mobileFriendly === null ? "n/a" : result.mobileFriendly ? "yes" : "no"}`,
    "",
    "## Notable Issues",
    "",
    result.topIssues.length > 0 ? result.topIssues.map((i) => `- ${i}`).join("\n") : "- No notable issues flagged among the audits checked.",
  ];
  return sections.join("\n\n");
}
