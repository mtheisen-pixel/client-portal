# SEO Audit — Staff Training Guide

_Updated 24 September 2026_

## What this audit measures

The SEO Audit checks a client's site for meta tags and indexability, structured data and technical hygiene. At the deeper tier it adds Local SEO, redirect health, Core Web Vitals and AI-crawler visibility.

The workflow matters more than the checklist. Every SEO Audit goes through a **human review step**:

- The crawl runs in **client-portal**.
- The Findings and Opportunity Recommendations are drafted by AI.
- A consultant reviews, edits and approves them in the **Audit app** before the client sees anything.

This is the same pattern as every other Studio Audit report.

There are two depth tiers, and you choose one each time you run it:

- **Light** — fast, deterministic checks only.
- **Comprehensive** — everything in Light, plus Local SEO, redirect-chain consistency, sitemap and link sampling, AI visibility (GEO) readiness, and a Core Web Vitals performance check.

---

## Before you start

- You'll use **two apps**: client-portal to run the crawl, and the Audit app to review and approve.
- Log into client-portal's `/admin` with the admin password.
- The client must already exist in client-portal. For a client's first-ever SEO Audit, the handoff creates a matching Audit-app record automatically, so there's no extra setup step.
- There's nothing to configure per run: the two apps are already connected.

---

## Step 1: Run the audit in client-portal

1. Go to `/admin` and select the client from the dropdown.
2. Under **Run a website audit**, choose the **Audit type**. There are three options:
    - **Creative Audit** — page copy, color and font summary, screenshots, perceived tone. Fully automated, with no review step; covered elsewhere.
    - **SEO Audit** — this guide.
    - **AI Search Visibility Audit** — asks AI assistants the client's prompts. It has its own guide, _How to Run an AI Search Visibility Audit_.
3. Choose **SEO Audit**.
4. Enter the **Website URL**. It isn't pre-filled from the client record, so type it in.
5. Leave **Competitor name** blank to audit the client's own site, or fill it in to audit a named competitor's site instead.
6. Choose the tier: **Light** or **Comprehensive**.
7. Click **Run Website Audit**.

---

## Step 2: What the crawl checks

**Light** (usually done in seconds):

- Meta tags and indexability, heading structure, structured data (JSON-LD)
- Technical hygiene: HTTPS and security headers, mixed content
- Whether analytics and conversion tracking are installed

**Comprehensive** adds, on top of everything in Light:

- Local SEO and NAP (name, address, phone) consistency
- Redirect-chain consistency
- Sitemap and internal-link sampling
- AI visibility (GEO): AI-crawler robots.txt rules, `llms.txt`, and a note on how easily AI can summarise the site
- A **Core Web Vitals performance check** (Google PageSpeed Insights). This runs in the background and can take a few minutes. Its status updates on the Admin page while it works.

Either tier saves its results as a Research document, which the next step drafts the report from.

> The Comprehensive tier's AI-crawler checks tell you whether AI assistants _can_ read the site. To measure whether they actually _name_ the client in answers, run the **AI Search Visibility Audit**. That audit uses this crawl's results as supporting context and points back here for robots.txt and `llms.txt` fixes.

---

## Step 3: The automatic handoff

You don't do anything for this step. It happens on its own once the crawl finishes (and, for Comprehensive, the performance check):

- client-portal creates a draft review report in the Audit app and attaches the crawl evidence to it.
- The Admin page then shows a **"Review & finalize this SEO Audit in the Audit app ↗"** link. Click it to go straight to the draft.
- If the handoff fails, the crawl data is never lost. The Admin page says the crawl succeeded but the review report couldn't be created, so you know to flag it rather than assume it worked.

---

## Step 4: Review and approve in the Audit app

1. Click the review link, or find the report on the Audit app's dashboard or the `/reports` list.
2. The first time you open it, it may still say **Generating**. Leave the tab open for a bit while Claude drafts the Findings, then the Opportunity Recommendations. If you close the tab, drafting still continues on its own, about every 30 minutes.
3. Once drafted, review it like any other Studio Audit report:
    - Edit the Findings or Opportunity Recommendations text directly if anything needs fixing.
    - Tick **"Approved for client"** on each opportunity the client should see. Unticked ones stay saved but never reach the client.
    - Click **Approve** once you're satisfied. You'll be asked to type your name.
4. Need to make more changes after approving? Click **Reopen**. This immediately takes the report off the client-facing view until you approve it again.

---

## Step 5: Delivering to the client

Once approved, the report is live at its `/client-view/[id]` link in the Audit app. Share that link with the client the same way you'd share any report link. Only the opportunities you ticked "Approved for client" appear there.

The approved report is the deliverable, not the raw crawl output. The crawl data is saved in client-portal as a Research document.

---

## Competitor audits and re-running later

- **Competitor audits** work the same way. Fill in the **Competitor name** field in Step 1; the tier choice, handoff, review and approval are identical.
- **Re-running for the same client** always creates a new draft report. It never overwrites or changes a report you already approved or sent. The old one stays exactly as you left it.

---

## FAQ / troubleshooting

**The crawl failed with "Could not fetch any pages". What do I do?**
The error message names the actual reason, such as a timeout or a connection reset. Most often the site's bot or firewall protection is blocking the crawler, or the site is temporarily unreachable. Try again. If it keeps happening, check whether the site needs to allowlist our crawler.

**Which tier should I pick?**
Light for a quick check. Comprehensive when the engagement calls for the deeper checks (Local SEO, redirects, GEO, Core Web Vitals). It takes longer because of the background performance check.

**What if Core Web Vitals fails but the rest of the crawl succeeds?**
The review report is still created with what's available. It flags that performance data wasn't measured this run rather than guessing, so you still get a usable draft.

**Is this the same as the old "SEO Audit" checklist tool?**
No. The old manual SEO checklist (`/seo-audit/light`, `/seo-audit/comprehensive`) has been retired. Its data has been cleared and it's no longer in the Audit app's menu. The AI-draft-then-review process in this guide is the only SEO Audit workflow.

**Do I ever need to create anything manually in the Audit app for this?**
No, the handoff does it for you. A manual intake page exists there only as a technical fallback, not as part of the normal process.
