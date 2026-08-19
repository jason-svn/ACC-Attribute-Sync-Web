# ACC Attribute Sync — Web

A standalone, static web version of the "ACC Docs Attribute Sync" pyRevit tool. No backend,
no Revit, no pyRevit — it's `index.html` + `app.js` + `styles.css` and a vendored copy of
[SheetJS](https://sheetjs.com/) for reading `.xlsx` files in the browser. Everything talks
directly to Autodesk's APIs over 3-legged OAuth with PKCE.

It does the same thing the original tool does: browse an ACC/BIM 360 hub → project → folder,
load an Excel sheet that maps file name → description / display name / custom attributes, and
push those values back into Autodesk Docs (version description, item description, item display
name, and BIM 360 Docs custom attributes).

## Before you build an APS app: read this

**Signing in with your own Autodesk account does not, by itself, give this app access to a
hub you don't administer.** Autodesk enforces an account-level allow-list for every BIM 360 /
ACC hub, independent of whether the app uses 2-legged or 3-legged auth. Concretely:

- `GET /hubs` will silently omit a hub, and any Data Management or Custom Attributes call
  against that hub's projects will fail, until someone with **Account Admin** rights on
  *that specific hub* adds this app's **Client ID** under
  **Account Admin → Custom Integrations → Add Custom Integration** and enables the **Docs**
  product for it.
- Your own "edit" / project-member permission has no bearing on this. It's a separate,
  admin-only screen, and there's no client-side or protocol-level way around it — see
  [Autodesk's own troubleshooting guide](https://aps.autodesk.com/blog/cant-access-autodesk-docs-api-dont-panic-follow-these-checks)
  and the [BIM 360 Docs provisioning post](https://aps.autodesk.com/blog/bim-360-docs-provisioning-forge-apps).
- The ask to that hub's admin is small: pasting a Client ID into an allow-list and ticking a
  product checkbox. It doesn't make them a developer and doesn't hand out any access beyond
  what you already have as a project member.

If you don't control the hub, plan to send whoever does the request template in
[Requesting provisioning](#requesting-provisioning) below.

## 1. Create the APS app

1. Go to the [APS developer portal](https://aps.autodesk.com/myapps) and create an app.
2. Choose application type **Desktop, Mobile, Single-Page App** — *not* "Traditional Web App".
   This type is a public client: it uses PKCE and Autodesk issues no client secret for it,
   which is what makes a secret-free static page possible.
3. Enable the **Data Management API** (and **ACC/BIM 360 Custom Attributes** if listed
   separately) for the app.
4. Add a callback URL matching wherever you'll host this page, e.g.
   `https://yourname.github.io/acc-attribute-sync/` or `http://localhost:8080/` for local use.
   It must match **exactly** (including trailing slash) what you put in Settings in step 3 below.
5. Copy the **Client ID**.

## 2. Host it

Any static host works: GitHub Pages, an internal file share served over HTTP(S), or just a
local dev server. `crypto.subtle` (used for the PKCE code challenge) requires a secure context,
so plain `file://` won't work — use `http://localhost` or `https://`.

Quick local option (from this folder):

```
python -m http.server 8080
```

Then open `http://127.0.0.1:8080/`.

## 3. Configure

Open the app, click **Settings**, and enter:

- **APS Client ID** — from step 1.
- **Redirect URI** — pre-filled from the current page URL; make sure it's byte-for-byte what
  you registered as the callback URL in the APS app.

Settings are stored in `localStorage` in your own browser only. The access/refresh token pair
is kept in `sessionStorage` (cleared when the tab closes) — nothing is sent anywhere except
Autodesk's own endpoints.

## 4. Sign in and provision

Click **Sign in**. If the hub you need doesn't show up in the Hub dropdown afterward, that's
the allow-list gate described above, not a bug — see the next section.

## Requesting provisioning

Send whoever administers the external ACC/BIM 360 hub something like:

> Could you add an app to your ACC account's allow-list? Go to **Account Admin → Custom
> Integrations → Add Custom Integration**, paste in this Client ID: `<your Client ID>`,
> name it something like "WWP Attribute Sync", and enable the **Docs** product. That's the
> whole step — it doesn't grant the app (or me) any access beyond what my account already
> has on the project.

## What it writes

Matching is by file name, case-insensitive, extension optional (so `A101.rvt` and `a101` both
match a row for either). Column A (or a column headed `File` / `File Name`) is the file name;
every other column becomes an attribute:

| Header (any case)                                   | Applied to                                   |
|-------------------------------------------------------|-----------------------------------------------|
| `Description` / `Desc`                                | Version description (falls back to item description on BIM 360 file types that don't support it; skipped entirely for Revit Cloud Worksharing/C4R models — Autodesk's Data Management API doesn't support writing description on that extension type at all, see [FDM-5304](https://aps.autodesk.com/blog/write-description-attribute-file-item-acc-and-bim360)) |
| `Item Description` / `File Description`               | Item description                              |
| `Display Name` / `Item Name`                          | Item display name                             |
| anything else                                          | BIM 360 Docs custom attribute with a matching name, looked up against the current folder's custom attribute definitions |

## Differences from the pyRevit version

- Auth is PKCE (public client, no secret) instead of an authorization-code exchange with a
  client secret — needed because a static page can't keep a secret.
- Excel is parsed with SheetJS in the browser instead of Excel COM automation, so it works
  without Excel installed, but very unusual workbook layouts may pick a different "best" sheet
  than Excel's own object model would.
- Folder browsing is a simple drill-down breadcrumb instead of an expandable tree.
