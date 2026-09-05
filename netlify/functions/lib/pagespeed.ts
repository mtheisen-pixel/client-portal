// Core Web Vitals / performance via Google's PageSpeed Insights API —
// deliberately its own module and its own Research document. PSI runs a
// real Lighthouse audit server-side and commonly takes 15-30+ seconds to
// respond, occasionally longer — three rounds of pure timeout/scope tuning
// (trimming 4 categories to 2, giving the request its full ~27s synchronous
// budget, then trimming to just "performance") all reduced but never
// eliminated live timeouts, because PSI's own response time is outside this
// app's control and has a real right tail. So this call no longer runs
// inside a normal synchronous Netlify Function at all — it's invoked from
// netlify/functions/website-audit-performance-background.ts, a Background
// Function (Netlify's naming convention: filename ends in "-background"),
// which gets up to 15 minutes instead of ~30 seconds. See that file's doc
// comment for how a background function's caller finds out the result
// (there's no synchronous response to return it in).
//
// Only "performance" is requested — not accessibility, best-practices, or
// seo, all of which PSI can also return in the same call. Losing
// accessibility here was a deliberate trade made *before* the move to a
// background function (nothing else in Technical Audit covers
// accessibility today; see technical-audit.ts's top-of-file comment, where
// this gap is flagged as a known follow-up) — now that this call isn't
// racing a ~30s ceiling, re-adding "accessibility" back to the category
// list is a live option again if it's worth the free axe-core coverage.
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
    };
    audits?: Record<string, LighthouseAudit>;
  };
}

export interface PageSpeedResult {
  url: string;
  performanceScore: number | null;
  lcp: string | null;
  /**
   * Total Blocking Time (Lighthouse audit id "total-blocking-time") —
   * Google's own recommended LAB-data proxy for INP, not literal INP
   * itself. Real INP needs Chrome UX Report field data from actual visitors
   * (INTERACTION_TO_NEXT_PAINT in PSI's loadingExperience block), which
   * this app doesn't request/parse — a low-traffic site like most of this
   * tool's targets often has no CrUX field data available at all, and PSI
   * silently omits loadingExperience in that case rather than erroring, so
   * there's nothing to fall back to. TBT is milliseconds, like real INP —
   * unlike the previous, mislabeled field here (Lighthouse's "interactive"
   * audit, i.e. Time to Interactive, which is seconds-range and unrelated).
   */
  tbt: string | null;
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

/** True for PSI's generic "Lighthouse returned error: Something went wrong" failure — Google's own headless Chrome failing to audit the page, distinct from an HTTP/auth/quota error. Often transient, so worth one retry rather than failing the whole step on the first hit. */
function isLighthouseRunError(status: number, bodyText: string): boolean {
  if (status !== 500) return false;
  try {
    const parsed = JSON.parse(bodyText) as { error?: { errors?: { domain?: string }[] } };
    return parsed.error?.errors?.some((e) => e.domain === "lighthouse") ?? false;
  } catch {
    return false;
  }
}

class LighthouseRunError extends Error {}

async function requestPageSpeed(endpoint: URL, timeoutMs: number): Promise<PageSpeedApiResponse> {
  const res = await fetch(endpoint.toString(), { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    const bodyText = await res.text();
    if (isLighthouseRunError(res.status, bodyText)) {
      throw new LighthouseRunError(`${res.status} ${bodyText}`);
    }
    throw new Error(`PageSpeed Insights failed for ${endpoint.searchParams.get("url")}: ${res.status} ${bodyText}`);
  }
  return (await res.json()) as PageSpeedApiResponse;
}

export async function runPageSpeedInsights(url: string): Promise<PageSpeedResult> {
  const apiKey = process.env.PAGESPEED_API_KEY;
  if (!apiKey) {
    throw new Error("PAGESPEED_API_KEY is not set — the Performance check needs a Google PageSpeed Insights API key.");
  }

  const endpoint = new URL("https://www.googleapis.com/pagespeedonline/v5/runPagespeed");
  endpoint.searchParams.set("url", url);
  endpoint.searchParams.set("key", apiKey);
  // Mobile strategy is kept deliberately, even though it's slower than
  // desktop (PSI simulates a throttled CPU/network for mobile) — mobile is
  // the traffic that actually matters for this kind of client, and the
  // accuracy of that number was explicitly chosen over the extra reliability
  // margin desktop would buy. Only "performance" is requested — see this
  // file's top-of-file comment for why accessibility was dropped.
  endpoint.searchParams.set("strategy", "mobile");
  endpoint.searchParams.set("category", "performance");

  // Now running inside a Background Function (up to 15 minutes), not a
  // normal ~30s synchronous request — this budget is a sane upper bound on
  // a single PSI attempt (PSI has never taken anywhere near this long in
  // practice), not a scarce resource to ration between attempts the way it
  // used to be. A Lighthouse-run-error response (see isLighthouseRunError)
  // fails fast — normally within a couple of seconds — so there's
  // effectively always time left over for one retry; that leftover time is
  // computed below rather than assumed.
  const TOTAL_BUDGET_MS = 120000;
  const startedAt = Date.now();

  let data: PageSpeedApiResponse;
  try {
    data = await requestPageSpeed(endpoint, TOTAL_BUDGET_MS);
  } catch (err) {
    if (!(err instanceof LighthouseRunError)) throw err;
    const remainingMs = TOTAL_BUDGET_MS - (Date.now() - startedAt);
    if (remainingMs < 3000) {
      throw new Error(
        `PageSpeed Insights couldn't audit ${url}: Google's Lighthouse run failed ("Something went wrong"), and there wasn't enough time left in this request to retry safely. This is on Google's end, not this app — it usually means the page didn't load cleanly for their headless Chrome (bot/WAF protection, a redirect, or an interstitial). Try again in a bit, or check that ${url} loads normally in an incognito window.`
      );
    }
    // One immediate retry with whatever budget is left — this failure mode
    // is Google's own Lighthouse run failing (not an HTTP/auth/quota
    // problem), and is commonly transient.
    try {
      data = await requestPageSpeed(endpoint, remainingMs);
    } catch (retryErr) {
      if (retryErr instanceof LighthouseRunError) {
        throw new Error(
          `PageSpeed Insights couldn't audit ${url}: Google's Lighthouse run failed twice in a row ("Something went wrong"). This is on Google's end, not this app — it usually means the page didn't load cleanly for their headless Chrome (bot/WAF protection, a redirect, or an interstitial). Try again in a bit, or check that ${url} loads normally in an incognito window.`
        );
      }
      throw retryErr;
    }
  }

  const categories = data.lighthouseResult?.categories ?? {};
  const audits = data.lighthouseResult?.audits ?? {};

  const topIssues = NOTABLE_AUDIT_IDS.map((id) => audits[id])
    .filter((a): a is LighthouseAudit => a != null && typeof a.score === "number" && a.score < 0.9 && !!a.title)
    .map((a) => `${a.title}${a.displayValue ? ` (${a.displayValue})` : ""}`);

  const viewportAudit = audits["viewport"];

  return {
    url,
    performanceScore: toPercent(categories.performance?.score),
    lcp: audits["largest-contentful-paint"]?.displayValue ?? null,
    // "total-blocking-time" is Google's own recommended lab proxy for INP.
    // The previous code read audits["interactive"] (Time to Interactive) —
    // a real Lighthouse audit, but a seconds-range page-load metric with no
    // relationship to interaction responsiveness, which is why it showed
    // implausible ~12s "INP" values sitting right next to a ~12s LCP.
    tbt: audits["total-blocking-time"]?.displayValue ?? audits["max-potential-fid"]?.displayValue ?? null,
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
    "- Accessibility: not checked by this step — see the Technical Audit's other sections; a dedicated accessibility pass (e.g. axe-core) is a known follow-up, not yet built.",
    "",
    "## Core Web Vitals",
    "",
    `- Largest Contentful Paint (LCP): ${result.lcp ?? "n/a"}`,
    `- Total Blocking Time (TBT — lab-data proxy for INP, not measured field data): ${result.tbt ?? "n/a"}`,
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
