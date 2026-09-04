// Core Web Vitals / performance via Google's PageSpeed Insights API —
// deliberately its own module and its own Research document, invoked as a
// separate HTTP request from the rest of Technical Audit's checks (see
// technical-audit.ts). PSI runs a real Lighthouse audit server-side and
// commonly takes 15-30+ seconds to respond, which alone can approach or
// exceed Netlify's ~30s function limit on this plan — so it never gets
// bundled into the same request as anything else, and it's given the full
// available request budget (see TOTAL_BUDGET_MS below) rather than a
// smaller slice.
//
// Only "performance" is requested now — not accessibility, best-practices,
// or seo, all of which PSI can also return in the same call. This request
// used to also ask for "accessibility" (Lighthouse's accessibility category
// runs axe-core internally, so that one call covered both for free), but
// live testing kept timing out even after trimming from 4 categories to 2
// and giving the request its full ~27s budget — accessibility was the next
// lever available to cut real Lighthouse work, at the cost of losing that
// free axe-core coverage (nothing else in Technical Audit covers
// accessibility today; see technical-audit.ts's top-of-file comment, where
// this gap is flagged as a known follow-up). This is a deliberate,
// discussed trade-off (accuracy of the mobile-strategy Core Web Vitals data
// mattered more here than keeping accessibility scoring), not a default —
// see the git history on this file before reaching for another category
// trim as the next lever.
//
// If timeouts persist even with a single category, the real fix is no
// longer trimmable scope — it's decoupling this call from Netlify's
// single-request time limit entirely (a longer-running function type, or a
// poll-for-status pattern instead of one blocking request). That's real new
// infrastructure, not a tweak, and deliberately not built until trimming to
// "performance" alone has been confirmed insufficient in practice.
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

  // The first attempt gets the full available budget — PSI genuinely
  // running long is far more common than a fast Lighthouse-run failure, so
  // shrinking this to make room for a retry (tried previously) just made
  // real timeouts more likely without meaningfully helping the retry case.
  // A Lighthouse-run-error response (see isLighthouseRunError) fails fast —
  // normally within a couple of seconds, nowhere near this budget — so
  // there's almost always time left over for one retry; that leftover time
  // is computed below rather than assumed.
  const TOTAL_BUDGET_MS = 27000;
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
