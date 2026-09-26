# Adding a New Client — Staff Training Guide

_Updated 24 September 2026_

## Overview

This guide covers bringing a new client into client-portal:

- creating the client
- setting up more than one login per company
- setting the client's category and site URL
- archiving a client when the engagement ends

It also covers how a new client links to the Audit app, which each audit and Studio intake needs.

---

## Before you start

Have these ready before you create the client:

- Company name
- Primary contact's name and role/title (optional, but worth having)
- A login email and a temporary password for the client. Share the password through a separate channel, not in the same email.
- Category/industry, if known (see Step 2)
- Site URL, if known
- A logo file, if you have one (optional; staff see it, the client never does)

---

## Step 1: Add the client

1. Go to `/admin` and log in with the admin password.
2. Under **Add a client**, fill in:
    - **Company name** (required)
    - **Primary contact name** (optional)
    - **Role / title** (optional)
    - **Login email** (required). This becomes the client's own portal login.
    - **Temporary password** (required, 8+ characters). Share it with the client through a separate channel.
    - **Category** (optional dropdown, defaults to "Not set")
    - **Site URL** (optional)
    - **Logo** (optional image file)
3. Click **Create client**.

Behind the scenes, client-portal:

- creates a login for that email
- creates the client's record
- adds the primary contact as the first entry in the client's contacts list. If you left Role/title blank, it's labelled "Primary Contact".

The id that links this client to the Audit app (`portal_client_id`) is generated automatically, so there's nothing to type in for it.

---

## Step 2: Why category and site URL matter

**Category** uses the same options as the Audit app's client categories:

- General business
- Specialty medical/dental
- Legal
- B2B professional services
- Ecommerce/retail
- Other

When you run an SEO Audit, the category is passed to the Audit app and can trigger its "Confirm Before Scoping" step. If it's "Not set", that step can't run. Set it now if you know it, or add it later (Step 4).

**Site URL** is stored on the client record for reference. It doesn't auto-fill the **Website URL** field when you run an audit, so you'll still type the URL in each time.

---

## Step 3: Adding more contacts

More than one person at a client's company can have their own login to the same portal.

1. Under **Documents**, select the client from the dropdown.
2. The **Contacts** list shows everyone who has access so far (name, email, role).
3. Under **Add a contact**, fill in a login email, a temporary password and, optionally, a name and role/title. Then click **Add contact**.
4. To revoke someone's access, click **Remove** next to their row. This removes only that person's access. It never touches the company's documents or anyone else's login.

Removing a contact doesn't delete their login account, only their access to this client. You can't currently re-add the same email as a contact afterwards; it fails as a duplicate. Use a different email, or ask engineering if you need that exact login restored.

---

## Step 4: Editing client details later

Use this for clients created before Category and Site URL existed, or when the details weren't known at signup:

1. Select the client under **Documents**.
2. Under **Client details**, set Category and/or Site URL.
3. Click **Save client details**.

---

## Step 5: Archiving and unarchiving a client

When an engagement ends:

1. Select the client, click **Archive this client** and confirm.
2. Archiving only hides the client from the active list. Their documents and portal login stay exactly as they are; nothing is deleted.
3. To bring them back, click **View archived clients** at the top of the Admin page, find the client and click **Unarchive**.

---

## How this connects to the Audit app

`portal_client_id` is the link between the two apps. You never enter it by hand; client-portal generates it when the client is created. How the Audit-app record gets linked depends on what you run first:

| What you run | What happens if the client has no linked Audit-app record |
| --- | --- |
| **SEO Audit** (client-portal Admin) | The handoff creates and links an Audit-app client automatically. The category set here is what reaches the Audit app. See the _SEO Audit_ guide. |
| **AI Search Visibility Audit** (client-portal Admin) | It won't start. The readiness check says the client isn't linked. Link it first (below), or run an SEO Audit first, which links it automatically. |
| **Studio intake** (Audit app → **New Intake ▾ → Start a Studio intake**) | The intake finds the Audit-app client by its exact name, or creates one if there's no match. Link it to the portal account afterwards (below). |

### First Studio intake: client onboarding

The first time a client fills in any Studio intake, they answer a short **client onboarding** block once, before choosing a studio:

- Who has final sign-off on recommendations, and who's the day-to-day point of contact?
- Is there a deadline or event (launch, budget cycle, board meeting) driving the timeline?
- Any tools, platforms, or vendors that are off-limits or locked in by contract?
- Any data privacy, compliance, or brand guidelines we need to work within?

Later intakes for the same client skip it. The answers are used in every Studio report for that client. See the _Studio Audit & Scope Framework — Delivery Guide_.

---

## Manually linking an existing Audit-app client

Sometimes a company already has an Audit-app record, for example from a Studio intake, before anything is run from client-portal. The automatic link only happens when no Audit-app record exists yet, so link it by hand:

1. In the Audit app, go to the **Clients** page (internal only).
2. Find the client's row. It shows **"Not linked to a portal account"** if it isn't linked yet.
3. Use the dropdown next to it to select the matching client-portal company by name, then click **Link**.
4. The dropdown only lists portal accounts that aren't already linked to another Audit-app client. One portal account can be linked to only one Audit-app client at a time.

To undo a link, click **Unlink** on the same row. This only removes the connection between the two records; it doesn't delete either one.

Linking is manual and by company name, not automatic matching. If two companies have similar names, double-check you're picking the right one; the two apps sometimes store slightly different names for the same client.

---

## Deleting a client (Audit app)

Archiving in client-portal is fully reversible and keeps the login and documents. Deleting a client in the Audit app is **permanent**. Use it only for test or junk data, never for a client whose engagement has simply ended. For those, use client-portal's Archive (Step 5).

1. Go to the Audit app's **Clients** page or the **Dashboard**. Both have a **Delete** button for each client.
2. Confirming deletes the client and everything tied to it:
    - every studio's intakes and reports
    - its AI Search Visibility runs
    - its prompt set and competitor list

   The confirmation dialog shows how many intakes, and their reports, are about to be deleted, so you know what you're removing before you confirm.
3. This only affects the Audit app's own records. It doesn't touch client-portal and doesn't delete the client's portal login or documents, even if the two are linked.

**Test clients:** when you practise a process, create a clearly named test client, e.g. "Brandaify (TEST)". Delete it from the Audit app and archive or remove it from client-portal when you're done. Test data sits in the same database as real clients.

---

## FAQ / troubleshooting

**Do I need to fill in Category or Site URL to create a client?**
No. Both are optional and can be added or changed later under Client details.

**What if I don't know the primary contact's name yet?**
Leave it blank. Only the login email and temporary password are needed for that first login to work.

**Can I add a second contact right after creating the client?**
Yes, any time; there's no waiting period.

**What happens if I remove a contact by mistake?**
Their access is revoked, but their login account isn't deleted. You can't currently re-add the same email as a contact; see the note in Step 3.

**A client already exists in the Audit app under a slightly different name. Is that a problem?**
No. The two apps link by `portal_client_id`, not by name, so a name mismatch doesn't cause any issue once they're linked.

**A Studio intake created a second Audit-app client for the same company.**
Studio intakes find the client by its **exact name**, so "Kids Quest" and "Kids Quest Inc." become two clients. Always use the name exactly as it appears on the Audit app's Clients page. If a duplicate slips through and it has no work you need, delete it (see above).
