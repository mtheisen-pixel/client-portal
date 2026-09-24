# How to Run an AI Search Visibility Audit — Staff Training Guide

_Updated 24 September 2026_

The AI Search Visibility Audit asks ChatGPT, Claude, Gemini and Perplexity the questions a client's customers ask. It records whether each assistant names the client, where in the answer, and in what tone, and which sources it cites. The results become a draft report for staff review. You start it with one click in client-portal Admin; the answering, analysis and draft are automatic.

---

## How it works

Each run takes about 10–60 minutes in the background. You provide two things: a prompt set, and a review of the draft.

1. **Set up the client** — Audit app setup page (once per client)
2. **Check readiness & cost** — client-portal Admin
3. **Confirm & run** — runs in the background
4. **Review & approve** — the draft report in the Audit app

Setup is done once per client and reused by every later run. Each run:

- asks every prompt on all four AI assistants
- has Claude classify every answer
- saves a Research document to the client's portal
- creates a draft report

---

## Before you start

A run can't start without the first three of these:

- [ ] You can sign in to the **Audit app** (internal staff) and to **client-portal Admin** (admin password).
- [ ] The client exists in both apps and is **linked**. Unlike the SEO Audit, this audit does **not** create the Audit-app client for you. If the client isn't linked, link it on the Audit app's **Clients** page. See the _Adding a New Client_ guide.
- [ ] The client has an **active prompt set** (Step 1). The audit never writes prompts on its own.
- [ ] Paid runs are approved for this client. Every run calls four paid AI services. The exact estimate appears before anything runs (Step 3).

> The older manual **AI Visibility Audit** checklist has been retired and removed from the Audit app's menu, along with its data. Automated runs never appear on those old pages. Find results through the review link in Admin or in the Audit app's reports.

---

## Step 1: Set up the client

Do this once per client in the Audit app. Revisit it only when the business or its market changes. Light and Comprehensive both use the same setup.

1. Open the setup page: **New Intake ▾ → Audits → AI Search Visibility Audit**, then the **AI Search Visibility setup page** link. You can also go straight to `/ai-search-visibility/setup`.
2. Pick the client and click **Open**. The **Setup status** panel at the top shows what's done (✓), what's required (✗) and what's optional (–).
3. **1. Scope** — fill in and click **Save scope**:
    - **Brand names and entities**: every name the business goes by, such as company name, product names, website domain and key people. This is how the audit recognises the client in answers.
    - **Region** (e.g. `US`) and **Language** (e.g. `en`).
4. **2. Prompts** — the questions every run asks. Aim for 10–15 prompts a real customer would type.
    - Add prompts one at a time with **Prompt text**, **Query type** and **Source** (client-supplied or researched), or
    - Use the generator:
        1. Click **Generate**.
        2. Check each suggestion's wording and query type, and untick any you don't want.
        3. Click **Add N selected prompts**. The list clears and a "saved" message appears.

      **Suggestions are not saved until you click Add.** The generator allows 10 generations per client per day. Any prompt already in the set is skipped.
    - Cover several query types, because Light picks its prompts across types:
        - branded
        - non-branded category
        - problem–solution
        - comparison
        - recommendation
        - local/geographic
        - informational
5. **3. Competitors (optional)** — type a name and click **Add competitor**. Each one saves immediately. Three to five direct competitors is plenty. Other businesses the AI names are still picked up.
6. Check the **Setup status** panel. When it says **Ready**, setup is finished. There's no overall Save button and nothing to submit or close.

**Changing prompts later?** Start a **new prompt set version** rather than editing the old one. That way reports can say when results aren't comparable.

---

## Step 2: Choose a tier

Use **Light** for a quick snapshot or a first look. Use **Comprehensive** for the full picture and for tracking change over time.

|  | Light | Comprehensive |
| --- | --- | --- |
| Prompts asked | Up to 10, mixed across query types | The whole active prompt set |
| Web search | On only | On and off (shows what the AI knows vs. what it finds) |
| AI calls | 4 per prompt | 7 per prompt (Perplexity always searches) |
| Report covers | Visibility per platform: whether the client is named, position, sentiment | Adds share of voice vs. competitors, the sources AI assistants cite, and change since the last Comprehensive run |
| Example estimate | 10 prompts: 40 calls, about $1.50–$5.20 | 15 prompts: 105 calls, about $2.40–$8.40 |

A client's **first** Comprehensive run is its baseline, so the "change since" section only fills in from the second run. Keep the prompt set the same between Comprehensive runs you want to compare.

---

## Step 3: Run it from client-portal Admin

Nothing is spent until you click **Confirm & run**.

1. Open **client-portal Admin** and unlock it with the admin password.
2. Select the client.
3. Under **Run a website audit**, choose **AI Search Visibility Audit**. The URL and competitor fields disappear, because this audit doesn't crawl a site.
4. Choose **Light** or **Comprehensive**.
5. Click **Check readiness & cost**. The Audit app checks that the client is linked, has an active prompt set, and has no run already in progress.
6. Read the confirmation panel: prompts × platforms = paid calls, plus the estimated cost range. If it looks wrong (e.g. far more prompts than expected), click **Cancel** and fix the setup first.
7. Click **Confirm & run**.
8. The page shows progress ("Running — X of Y platform calls done"), then a **review link** when the draft report is ready. You can close the page; the run continues.

Changed your mind about the tier after checking cost? Pick the other tier and click **Check readiness & cost** again. The old estimate is cleared.

---

## Step 4: Review and approve the report

The draft is written by AI. A person must check it before the client sees it.

1. Open the **review link** from Admin, or find the report on the Audit app's dashboard. Keep the page open while it finishes drafting. Otherwise it advances on its own about every 30 minutes.
2. Check the **Findings** against the numbers in the Research document: how often the client is named, on which platforms, and in what position.
3. Edit the **Opportunity Recommendations** directly where needed. Tick **"Approved for client"** on each one the client should see. Unticked ones stay saved but never reach the client.
4. Check the **Priority Sequence** reads in a sensible order.
5. Click **Approve** and type your name.
6. Share the report's `/client-view/[id]` link with the client. Only approved opportunities appear there.

Need more changes after approving? Click **Reopen**. This takes the report off the client view until you approve it again.

**What to look for when reviewing:**

- **Look-alike names.** AI assistants sometimes confuse the client with a business that has a similar name. Make sure the report isn't crediting or blaming the client for another company.
- **Crawler access** is supporting context only. If the report says it was "not checked", that's expected unless a Comprehensive SEO Audit exists. Fixes for robots.txt and `llms.txt` belong in the SEO Audit.
- **Light reports** should not talk about citations, search-off answers or trends. Remove any such claims.

The Research document is saved to the client's portal under **Research**.

---

## Troubleshooting

| What you see | Why | What to do |
| --- | --- | --- |
| Client isn't linked | The Audit-app client doesn't point at the client-portal client | Link it on the Audit app **Clients** page, then check again |
| No active prompt set, with a **Set this up** link | The client has no prompts yet | Follow the link and complete Step 1 |
| A run is already in progress | Only one run per client at a time | Click **Track the running batch** and wait for it |
| Stuck on "Queued" for more than 10 minutes | The background job didn't start (e.g. the query runner workflow is turned off in GitHub, or GitHub Actions minutes ran out) | Tell the Audit app admin; don't start another run |
| Run marked failed | An AI service or key failed, or there was no result after 100 minutes | Note the error shown and tell the admin before retrying. A retry is charged again |
| Some calls "errored" but the run finished | One platform was briefly unavailable | Review as normal; mention the gap if a whole platform is missing |
| A Perplexity answer has no sources | Perplexity sometimes answers without searching | Normal occasionally; tell the admin if it happens on every answer |
| Generated prompts disappeared | They were never added | Suggestions are only saved after **Add N selected prompts** |

---

## Rules to follow

- **Always read the cost estimate** before clicking **Confirm & run**. Every run is charged, including failed and repeated ones.
- **Never approve a report unread.** The draft is AI-written and can mistake another business for the client.
- **One run at a time per client.** Don't start a second run to "speed things up".
- **Prompts come from people.** Write them yourself or pick from the generator's suggestions; don't pad the set with near-duplicates.
- **Practise on a test client.** Use a clearly named test client with 2–3 prompts, never a real client's account, and delete it afterwards.
- **Crawler fixes go to the SEO Audit**, not this report.
