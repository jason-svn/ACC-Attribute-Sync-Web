"use strict";

/* =========================================================================
 * ACC Attribute Sync — standalone web client
 *
 * 3-legged OAuth via PKCE (Autodesk "Desktop, Mobile, Single-Page App"
 * app type) — no client secret, no backend. Everything runs in the browser.
 *
 * NOTE: signing in never bypasses ACC/BIM 360's account-level app allow-list.
 * A hub only returns data to this app once someone with Account Admin
 * rights on that hub adds this app's Client ID under
 * Account Admin > Custom Integrations. See the Settings modal.
 * ========================================================================= */

const OAUTH_AUTHORIZE_URL = "https://developer.api.autodesk.com/authentication/v2/authorize";
const OAUTH_TOKEN_URL = "https://developer.api.autodesk.com/authentication/v2/token";
const SCOPES = "data:read data:write account:read";

const DM_BASE = "https://developer.api.autodesk.com/project/v1";
const DATA_BASE = "https://developer.api.autodesk.com/data/v1";
const BIM360_BASE = "https://developer.api.autodesk.com/bim360/docs/v1";

const LS_CLIENT_ID = "acc_sync.client_id";
const LS_CLIENT_SECRET = "acc_sync.client_secret";
const LS_REDIRECT_URI = "acc_sync.redirect_uri";
const SS_SESSION = "acc_sync.session";
const SS_PKCE_VERIFIER = "acc_sync.pkce_verifier";
const SS_PKCE_STATE = "acc_sync.pkce_state";

const EXCEL_ATTRIBUTE_ALIASES = {
  "description": "description",
  "desc": "description",
  "item description": "item_description",
  "item_description": "item_description",
  "file description": "item_description",
  "file_description": "item_description",
  "display name": "display_name",
  "displayname": "display_name",
  "item name": "display_name",
  "item_name": "display_name",
};

// Columns "Download all data" adds purely for human reference — never treated as attributes
// to write back, even if you edit and re-drop that same export as a sync source.
const EXCEL_IGNORED_COLUMNS = new Set(["folder path", "type"]);

/* ---------------------------------------------------------------------
 * Utilities
 * ------------------------------------------------------------------- */

function nowStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function log(message, kind) {
  const body = document.getElementById("consoleBody");
  const line = document.createElement("div");
  line.className = "line" + (kind ? " " + kind : "");
  const ts = document.createElement("span");
  ts.className = "ts";
  ts.textContent = nowStamp();
  line.appendChild(ts);
  line.appendChild(document.createTextNode(String(message)));
  body.appendChild(line);
  body.scrollTop = body.scrollHeight;
}

// Appends many log lines in one DOM write and one scroll, instead of a layout per line.
// Each entry is {message, kind, ts}; ts is captured when the event happened.
function logBatch(entries) {
  if (!entries.length) return;
  const body = document.getElementById("consoleBody");
  const frag = document.createDocumentFragment();
  for (const { message, kind, ts } of entries) {
    const line = document.createElement("div");
    line.className = "line" + (kind ? " " + kind : "");
    const tsEl = document.createElement("span");
    tsEl.className = "ts";
    tsEl.textContent = ts;
    line.appendChild(tsEl);
    line.appendChild(document.createTextNode(String(message)));
    frag.appendChild(line);
  }
  body.appendChild(frag);
  body.scrollTop = body.scrollHeight;
}

// Adds a log line that cycles "Scanning." -> "Scanning.." ... up to 10 dots, then restarts, on a
// timer, purely as a "still alive" cue (not tied to real progress). Returns stop(), which removes it.
function startLogAnimation(label) {
  const body = document.getElementById("consoleBody");
  const line = document.createElement("div");
  line.className = "line";
  const ts = document.createElement("span");
  ts.className = "ts";
  ts.textContent = nowStamp();
  const text = document.createTextNode(label + ".");
  line.appendChild(ts);
  line.appendChild(text);
  body.appendChild(line);
  body.scrollTop = body.scrollHeight;
  const MAX_DOTS = 10;
  let dots = 1;
  const timer = setInterval(() => {
    dots = dots % MAX_DOTS + 1;
    text.nodeValue = label + ".".repeat(dots);
  }, 600);
  return function stop() {
    clearInterval(timer);
    line.remove();
  };
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function truncate(s, n) {
  s = s == null ? "" : String(s);
  return s.length > n ? s.slice(0, n - 3) + "..." : s;
}

/* ---------------------------------------------------------------------
 * Excel-style name normalization (ported from ExcelReader in script.py)
 * ------------------------------------------------------------------- */

function normalizeName(value) {
  if (value == null) return "";
  let text = String(value);
  text = text.replace(/ /g, " ")
    .replace(/[‎‏]/g, "")
    .replace(/[‪‫‬]/g, "")
    .replace(/[–—−]/g, "-");
  text = text.replace(/\s+/g, " ");
  return text.trim().toLowerCase();
}

function normalizeBase(value) {
  const name = normalizeName(value);
  if (!name) return "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return name; // no extension, or a dot-leading name (".gitignore"-style)
  return name.slice(0, dot);
}

/* ---------------------------------------------------------------------
 * PKCE helpers
 * ------------------------------------------------------------------- */

function randomString(len) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length];
  return out;
}

async function codeChallengeFor(verifier) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/* ---------------------------------------------------------------------
 * Settings (persisted in localStorage — client_id is not a secret)
 * ------------------------------------------------------------------- */

const Settings = {
  get clientId() { return localStorage.getItem(LS_CLIENT_ID) || ""; },
  set clientId(v) { localStorage.setItem(LS_CLIENT_ID, v || ""); },
  // Optional. Leave blank to use PKCE (no secret, works with a "Desktop, Mobile, Single-Page
  // App" APS app type). Fill in only when testing a confidential "Traditional Web App" type —
  // e.g. reusing an app that's already been granted elevated access (like C4R schema access)
  // that a fresh public-client app wouldn't have. Stored in this browser's localStorage only.
  get clientSecret() { return localStorage.getItem(LS_CLIENT_SECRET) || ""; },
  set clientSecret(v) { localStorage.setItem(LS_CLIENT_SECRET, v || ""); },
  get redirectUri() {
    return localStorage.getItem(LS_REDIRECT_URI) || (location.origin + location.pathname);
  },
  set redirectUri(v) { localStorage.setItem(LS_REDIRECT_URI, v || ""); },
};

/* ---------------------------------------------------------------------
 * Auth session (kept in localStorage — persists until Sign out)
 * ------------------------------------------------------------------- */

const Session = {
  data: null,
  load() {
    try {
      // Persisted in localStorage so sign-in survives closing the tab/browser; the refresh token
      // renews the access token silently. Falls back to a pre-existing sessionStorage session.
      const raw = localStorage.getItem(SS_SESSION) || sessionStorage.getItem(SS_SESSION);
      this.data = raw ? JSON.parse(raw) : null;
    } catch (e) { this.data = null; }
    return this.data;
  },
  save() {
    try { localStorage.setItem(SS_SESSION, JSON.stringify(this.data)); } catch (e) { /* storage blocked */ }
    try { sessionStorage.removeItem(SS_SESSION); } catch (e) { /* ignore */ }
  },
  clear() {
    this.data = null;
    try { localStorage.removeItem(SS_SESSION); } catch (e) { /* ignore */ }
    try { sessionStorage.removeItem(SS_SESSION); } catch (e) { /* ignore */ }
  },
  set(tokenResponse) {
    const expiresIn = Number(tokenResponse.expires_in) || 3000;
    this.data = {
      access_token: tokenResponse.access_token,
      refresh_token: tokenResponse.refresh_token || (this.data && this.data.refresh_token) || "",
      expires_at: Date.now() + expiresIn * 1000,
    };
    this.save();
  },
  get isSignedIn() { return !!(this.data && this.data.access_token); },
};

/* ---------------------------------------------------------------------
 * Auth flow — PKCE (no secret) by default; falls back to classic
 * Authorization Code + client_secret when Settings.clientSecret is set,
 * for testing/using a Traditional Web App type APS app instead.
 * ------------------------------------------------------------------- */

function basicAuthHeader(clientId, clientSecret) {
  return "Basic " + btoa(`${clientId}:${clientSecret}`);
}

const Auth = {
  async login() {
    const clientId = Settings.clientId;
    const clientSecret = Settings.clientSecret;
    if (!clientId) {
      openSettings();
      log("Set an APS Client ID in Settings before signing in.", "err");
      return;
    }

    const state = randomString(16);
    sessionStorage.setItem(SS_PKCE_STATE, state);

    const url = new URL(OAUTH_AUTHORIZE_URL);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", Settings.redirectUri);
    url.searchParams.set("scope", SCOPES);
    url.searchParams.set("state", state);
    url.searchParams.set("prompt", "login");

    if (clientSecret) {
      // Confidential client (Traditional Web App) — classic Authorization Code grant, no PKCE.
      log(`Redirecting to Autodesk sign-in (client_secret flow, redirect_uri=${Settings.redirectUri})...`);
      location.href = url.toString();
      return;
    }

    if (!window.isSecureContext || !window.crypto || !window.crypto.subtle) {
      log(
        `Can't sign in from ${location.origin} — PKCE needs a secure context ` +
        `(https://, or http://localhost / http://127.0.0.1 specifically). ` +
        `Open the page via 127.0.0.1 or localhost, not a LAN IP or other hostname.`,
        "err"
      );
      return;
    }
    try {
      const verifier = randomString(64);
      sessionStorage.setItem(SS_PKCE_VERIFIER, verifier);
      const challenge = await codeChallengeFor(verifier);
      url.searchParams.set("code_challenge", challenge);
      url.searchParams.set("code_challenge_method", "S256");

      log(`Redirecting to Autodesk sign-in (redirect_uri=${Settings.redirectUri})...`);
      location.href = url.toString();
    } catch (e) {
      log(`Sign-in setup failed: ${e.message}`, "err");
    }
  },

  async handleCallback() {
    const params = new URLSearchParams(location.search);
    if (!params.has("code")) return false;

    const code = params.get("code");
    const returnedState = params.get("state");
    const expectedState = sessionStorage.getItem(SS_PKCE_STATE);
    const verifier = sessionStorage.getItem(SS_PKCE_VERIFIER);
    const clientSecret = Settings.clientSecret;

    // Strip the OAuth params from the URL so a reload doesn't replay them.
    history.replaceState(null, "", Settings.redirectUri);

    if (params.has("error")) {
      log(`Sign-in failed: ${params.get("error_description") || params.get("error")}`, "err");
      return true;
    }
    if (!clientSecret && !verifier) {
      log("Sign-in failed: missing PKCE verifier (was the callback opened in a new tab?).", "err");
      return true;
    }
    if (expectedState && returnedState !== expectedState) {
      log("Sign-in failed: state mismatch. Possible tampering — try again.", "err");
      return true;
    }

    try {
      const form = { grant_type: "authorization_code", code, redirect_uri: Settings.redirectUri };
      const headers = { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" };
      if (clientSecret) {
        headers.Authorization = basicAuthHeader(Settings.clientId, clientSecret);
      } else {
        form.client_id = Settings.clientId;
        form.code_verifier = verifier;
      }
      const resp = await fetch(OAUTH_TOKEN_URL, {
        method: "POST",
        headers,
        body: new URLSearchParams(form).toString(),
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error_description || json.error || resp.statusText);
      Session.set(json);
      log("Signed in.", "ok");
    } catch (e) {
      log(`Token exchange failed: ${e.message}`, "err");
    } finally {
      sessionStorage.removeItem(SS_PKCE_VERIFIER);
      sessionStorage.removeItem(SS_PKCE_STATE);
    }
    return true;
  },

  async refresh() {
    if (!Session.data || !Session.data.refresh_token) throw new Error("No refresh token available.");
    const clientSecret = Settings.clientSecret;
    const form = { grant_type: "refresh_token", refresh_token: Session.data.refresh_token };
    const headers = { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" };
    if (clientSecret) {
      headers.Authorization = basicAuthHeader(Settings.clientId, clientSecret);
    } else {
      form.client_id = Settings.clientId;
      form.scope = SCOPES;
    }
    const resp = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers,
      body: new URLSearchParams(form).toString(),
    });
    const json = await resp.json();
    if (!resp.ok) throw new Error(json.error_description || json.error || resp.statusText);
    Session.set(json);
  },

  async ensureToken() {
    if (!Session.data) throw new Error("Not signed in.");
    if (Session.data.expires_at - Date.now() < 2 * 60 * 1000) {
      log("Refreshing token...");
      await this.refresh();
    }
  },

  signOut() {
    Session.clear();
    log("Signed out.");
  },
};

/* ---------------------------------------------------------------------
 * HTTP helper
 * ------------------------------------------------------------------- */

async function apiFetch(method, url, body, contentType) {
  await Auth.ensureToken();
  const headers = {
    Authorization: "Bearer " + Session.data.access_token,
    Accept: "application/json, application/vnd.api+json",
  };
  if (contentType) headers["Content-Type"] = contentType;

  // APS rate-limits per app (HTTP 429, "Quota limit exceeded"). A big crawl will hit it, so wait
  // and retry rather than failing the whole job. Retry-After isn't always readable cross-origin,
  // so fall back to exponential backoff.
  // Up to ~30 minutes of waiting in total (waits cap at 60s), so a long export pauses through
  // the limit window and resumes on its own instead of failing.
  const MAX_RETRIES = 30;
  let resp, text;
  for (let attempt = 0; ; attempt++) {
    resp = await fetch(url, { method, headers, body: body || undefined });
    text = await resp.text();
    const throttled = resp.status === 429 || (!resp.ok && /quota limit exceeded/i.test(text));
    if (!throttled || attempt >= MAX_RETRIES) break;
    const retryAfter = Number(resp.headers.get("Retry-After"));
    const waitSec = retryAfter > 0 ? retryAfter : Math.min(60, 10 * 2 ** attempt);
    log(`Rate limited by Autodesk — waiting ${waitSec}s before retry ${attempt + 1}/${MAX_RETRIES}...`, "err");
    await new Promise((r) => setTimeout(r, waitSec * 1000));
    await Auth.ensureToken();
    headers.Authorization = "Bearer " + Session.data.access_token;
  }
  if (!resp.ok) {
    let message = text;
    try {
      const j = JSON.parse(text);
      message = j.errorMessage || j.detail || (j.errors && j.errors[0] && j.errors[0].detail) || text;
    } catch (e) { /* keep raw text */ }
    const err = new Error(message || `${resp.status} ${resp.statusText}`);
    err.status = resp.status;
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

function getNextLink(root) {
  const links = root && root.links;
  const next = links && links.next;
  if (next && typeof next === "object") return next.href;
  return null;
}

/* ---------------------------------------------------------------------
 * Data Management / BIM 360 Docs API client
 * ------------------------------------------------------------------- */

function normalizeBim360ProjectId(projectId) {
  if (!projectId) return projectId;
  const pid = projectId.trim();
  if (pid.startsWith("b.") || pid.startsWith("a.")) return pid.slice(2);
  return pid;
}

function normalizeProjectIdCandidates(projectId) {
  const ids = [];
  if (!projectId) return ids;
  let pid = projectId.trim();
  if (pid.startsWith("urn:")) {
    const tail = pid.split(":").pop();
    pid = tail || pid;
  }
  ids.push(pid);
  if (!pid.startsWith("b.") && !pid.startsWith("a.")) {
    ids.push("b." + pid);
    ids.push("a." + pid);
  }
  return [...new Set(ids.filter(Boolean))];
}

function parseFolderContents(root) {
  const folders = [];
  const files = [];
  for (const item of (root && root.data) || []) {
    const type = (item.type || "").toLowerCase();
    const attrs = item.attributes || {};
    if (type === "folders") {
      folders.push({ id: item.id, name: attrs.displayName || "" });
    } else if (type === "items") {
      const ext = attrs.extension || {};
      files.push({
        id: item.id,
        displayName: attrs.displayName || "",
        description: attrs.description || "",
        extensionType: ext.type || "",
      });
    }
  }
  return { folders, files };
}

const Acc = {
  // Used only to silently resolve which hub a pasted Project ID belongs to — never shown as a
  // picker. Most users have a small handful of hubs at most, so trying each one is cheap.
  async getHubs() {
    const root = await apiFetch("GET", `${DM_BASE}/hubs`);
    return (root.data || []).map((h) => ({ id: h.id, name: (h.attributes || {}).name || h.id }));
  },

  async getTopFolders(hubId, projectId) {
    const root = await apiFetch(
      "GET",
      `${DM_BASE}/hubs/${encodeURIComponent(hubId)}/projects/${encodeURIComponent(projectId)}/topFolders`
    );
    return (root.data || []).map((f) => ({ id: f.id, name: (f.attributes || {}).displayName || "" }));
  },

  // Combined, paginated fetch of a folder's direct children — both subfolders and files —
  // from the same `contents` pages (avoids hitting the endpoint twice for the same folder).
  async getFolderContentsFull(projectId, folderId) {
    let url = `${DATA_BASE}/projects/${encodeURIComponent(projectId)}/folders/${encodeURIComponent(folderId)}/contents`;
    const folders = [];
    const files = [];
    while (url) {
      const root = await apiFetch("GET", url);
      const page = parseFolderContents(root);
      folders.push(...page.folders);
      files.push(...page.files);
      url = getNextLink(root);
    }
    return { folders, files };
  },

  // Reads current custom attribute values (and description-adjacent fields) for a batch of
  // item ids. Note: this does NOT return the item description — that only comes from the
  // folder-contents `attributes.description` field, fetched separately.
  async batchGetVersionAttributes(projectId, itemIds) {
    if (!itemIds.length) return [];
    const pid = normalizeBim360ProjectId(projectId);
    const CHUNK = 25;
    const results = [];
    for (let i = 0; i < itemIds.length; i += CHUNK) {
      const chunk = itemIds.slice(i, i + CHUNK);
      const root = await apiFetch(
        "POST",
        `${BIM360_BASE}/projects/${encodeURIComponent(pid)}/versions:batch-get`,
        JSON.stringify({ urns: chunk }),
        "application/json"
      );
      results.push(...((root && root.results) || []));
    }
    return results;
  },

  async getItemDetail(projectId, itemId) {
    return apiFetch("GET", `${DATA_BASE}/projects/${encodeURIComponent(projectId)}/items/${encodeURIComponent(itemId)}`);
  },

  // The description shown in ACC's UI lives at attributes.extension.data.description on the
  // item detail response — NOT the flat attributes.description a folder-contents listing
  // returns (that field is essentially always blank in practice). Also returns the tip version
  // id, needed for anything that reads/writes version-level data.
  async getItemDescriptionAndTip(projectId, itemId) {
    const detail = await this.getItemDetail(projectId, itemId);
    const data = (detail && detail.data) || {};
    const attrs = data.attributes || {};
    const extData = (attrs.extension || {}).data || {};
    const rel = data.relationships || {};
    const tip = ((rel.tip || {}).data || {}).id || null;
    return { description: extData.description || "", tip };
  },

  async updateFileDescription(projectId, itemId, description) {
    const body = JSON.stringify({
      jsonapi: { version: "1.0" },
      data: { type: "items", id: itemId, attributes: { extension: { data: { description } } } },
    });
    log(`PATCH item description: ${itemId} desc='${truncate(description, 120)}'`);
    await apiFetch(
      "PATCH",
      `${DATA_BASE}/projects/${encodeURIComponent(projectId)}/items/${encodeURIComponent(itemId)}`,
      body,
      "application/vnd.api+json"
    );
  },

  async updateItemDisplayName(projectId, itemId, displayName) {
    const body = JSON.stringify({
      jsonapi: { version: "1.0" },
      data: { type: "items", id: itemId, attributes: { displayName } },
    });
    log(`PATCH item displayName: ${itemId} name='${truncate(displayName, 120)}'`);
    await apiFetch(
      "PATCH",
      `${DATA_BASE}/projects/${encodeURIComponent(projectId)}/items/${encodeURIComponent(itemId)}`,
      body,
      "application/vnd.api+json"
    );
  },

  async updateVersionDescription(projectId, versionId, description) {
    const body = JSON.stringify({
      jsonapi: { version: "1.0" },
      data: { type: "versions", id: versionId, attributes: { extension: { data: { description } } } },
    });
    log(`PATCH version description: ${versionId} desc='${truncate(description, 120)}'`);
    await apiFetch(
      "PATCH",
      `${DATA_BASE}/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(versionId)}`,
      body,
      "application/vnd.api+json"
    );
  },

  async getCustomAttributeDefinitions(projectId, folderId) {
    const pid = normalizeBim360ProjectId(projectId);
    return apiFetch(
      "GET",
      `${BIM360_BASE}/projects/${encodeURIComponent(pid)}/folders/${encodeURIComponent(folderId)}/custom-attribute-definitions`
    );
  },

  async updateVersionCustomAttributes(projectId, versionId, attributes) {
    if (!attributes || !attributes.length) return;
    const pid = normalizeBim360ProjectId(projectId);
    log(`POST custom attributes: version=${versionId} attrs=${attributes.length}`);
    await apiFetch(
      "POST",
      `${BIM360_BASE}/projects/${encodeURIComponent(pid)}/versions/${encodeURIComponent(versionId)}/custom-attributes:batch-update`,
      JSON.stringify(attributes),
      "application/json"
    );
  },
};

/* ---------------------------------------------------------------------
 * Folder URL parsing (ported from _parse_folder_url / _normalize_project_id)
 * ------------------------------------------------------------------- */

function parseFolderUrl(url) {
  if (!url) return { projectId: null, folderId: null };
  let projectId = null;
  let folderId = null;

  try {
    const u = new URL(url);
    for (const [key, value] of u.searchParams.entries()) {
      if (key === "folderUrn") folderId = value;
      if (key === "projectId") projectId = value;
    }
  } catch (e) { /* not a full URL; fall through to regex */ }

  const projectMatch = url.match(/\/projects\/([a-zA-Z0-9\-.]+)/);
  if (projectMatch) projectId = projectMatch[1];

  if (!folderId) {
    const folderMatch = url.match(/\/folders\/([^/?#]+)/);
    if (folderMatch) folderId = decodeURIComponent(folderMatch[1]);
  }
  if (folderId && folderId.startsWith("urn%3A")) {
    try { folderId = decodeURIComponent(folderId); } catch (e) { /* ignore */ }
  }

  return { projectId, folderId };
}

/* ---------------------------------------------------------------------
 * Excel reading + matching (ported from ExcelReader)
 * ------------------------------------------------------------------- */

const ExcelReader = {
  async readFile(file) {
    const buf = await file.arrayBuffer();
    const workbook = XLSX.read(buf, { type: "array" });

    let best = { rows: 0, descRows: 0, aoa: null, sheetName: null };
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: null, blankrows: false });
      if (!aoa.length) continue;
      let rows = 0;
      let descRows = 0;
      for (let r = 1; r < aoa.length; r++) {
        const row = aoa[r] || [];
        if (row[0] != null && String(row[0]).trim()) rows++;
        if (row[1] != null && String(row[1]).trim()) descRows++;
      }
      const pick = descRows > best.descRows || (descRows === best.descRows && rows > best.rows);
      if (pick) best = { rows, descRows, aoa, sheetName };
    }

    const result = new Map();
    const diag = { sheet: best.sheetName, rowsRead: 0, headers: [] };
    if (!best.aoa || best.aoa.length < 1) {
      return { rows: result, diag };
    }

    const headerRow = best.aoa[0] || [];
    const headers = {}; // normalized header -> column index
    headerRow.forEach((h, col) => {
      const key = normalizeName(h);
      if (key) headers[key] = col;
    });
    diag.headers = Object.keys(headers);

    let fileCol = null;
    for (const key of ["file", "file name", "filename", "file_name"]) {
      if (key in headers) { fileCol = headers[key]; break; }
    }
    if (fileCol == null) fileCol = 0;

    let descriptionIndex = "description" in headers ? headers["description"] : 1;

    for (let r = 1; r < best.aoa.length; r++) {
      const row = best.aoa[r] || [];
      const fileVal = row[fileCol];
      if (fileVal == null || !String(fileVal).trim()) continue;
      const fileName = String(fileVal).trim();

      const attributes = {};
      for (const [header, col] of Object.entries(headers)) {
        if (col === fileCol) continue;
        if (EXCEL_IGNORED_COLUMNS.has(header)) continue;
        const val = row[col];
        if (val == null) continue;
        const text = String(val).trim();
        if (!text) continue;
        attributes[header] = text;
      }

      let description = attributes["description"] || "";
      if (!description && descriptionIndex != null && descriptionIndex >= 0) {
        const descVal = row[descriptionIndex];
        if (descVal != null) {
          description = String(descVal).trim();
          if (description && !("description" in attributes)) attributes["description"] = description;
        }
      }

      const rowObj = { fileName, description, attributes };
      const key1 = normalizeName(fileName);
      const key2 = normalizeBase(fileName);
      if (key1 && !result.has(key1)) result.set(key1, rowObj);
      if (key2 && !result.has(key2)) result.set(key2, rowObj);
      diag.rowsRead++;
    }

    return { rows: result, diag };
  },
};

/* ---------------------------------------------------------------------
 * App state
 * ------------------------------------------------------------------- */

const state = {
  hub: null,
  project: null,
  folderStack: [], // [{id, name, folders, files}], last is current
  folders: [], // current folder's subfolders
  files: [], // current folder's files
  excelRows: new Map(),
  excelFileName: "",
  customAttrDefsByFolder: new Map(),
};

/* ---------------------------------------------------------------------
 * UI wiring
 * ------------------------------------------------------------------- */

const el = (id) => document.getElementById(id);

function setStatus(text, mode) {
  el("statusText").textContent = text;
  const dot = el("statusDot");
  dot.className = "status-dot" + (mode ? " " + mode : "");
}

function refreshTitleblock() {
  el("tbHub").textContent = state.hub ? state.hub.name : "—";
  el("tbHub").classList.toggle("muted", !state.hub);
  el("tbProject").textContent = state.project ? state.project.name : "—";
  el("tbProject").classList.toggle("muted", !state.project);
  const current = state.folderStack[state.folderStack.length - 1];
  el("tbFolder").textContent = current ? current.name : "—";
  el("tbFolder").classList.toggle("muted", !current);
}

function openSettings() {
  el("clientIdInput").value = Settings.clientId;
  el("clientSecretInput").value = Settings.clientSecret;
  el("redirectUriInput").value = Settings.redirectUri;
  el("settingsModal").classList.remove("hidden");
}
function closeSettings() { el("settingsModal").classList.add("hidden"); }

function renderSignedInUi() {
  const signedIn = Session.isSignedIn;
  el("btnSignIn").classList.toggle("hidden", signedIn);
  el("btnSignOut").classList.toggle("hidden", !signedIn);
  setStatus(signedIn ? "Signed in" : "Signed out", signedIn ? "online" : "");
}

function updateConnectButton() {
  el("btnConnect").disabled = !el("projectIdInput").value.trim();
}

// ACC folder/project URLs never include a hub id, so we resolve it ourselves: fetch the
// (usually short) list of hubs this app can see, and try each one against the project id
// candidates until topFolders succeeds. Most accounts only have one or two hubs, so this is
// a handful of calls at most, not a real scan.
async function connect() {
  const projectIdRaw = el("projectIdInput").value.trim();
  if (!projectIdRaw) return;
  if (!Session.isSignedIn) { log("Sign in first.", "err"); return; }

  state.folders = [];
  state.files = [];
  state.folderStack = [];
  renderContentsTable();

  const candidates = normalizeProjectIdCandidates(projectIdRaw);
  let lastError = null;
  try {
    setStatus("Resolving hub...", "online");
    const hubs = await Acc.getHubs();
    if (!hubs.length) throw new Error("No hubs visible to this app.");

    for (const hub of hubs) {
      for (const pid of candidates) {
        try {
          setStatus(`Checking '${hub.name}'...`, "online");
          const top = await Acc.getTopFolders(hub.id, pid);
          state.hub = hub;
          state.project = { id: pid, name: pid };
          state.folderStack = [{ id: null, name: pid, folders: top, files: [] }];
          el("provisionNote").classList.add("hidden");
          renderContentsTable();
          refreshTitleblock();
          setStatus("Signed in", "online");
          log(`Connected via hub '${hub.name}'. Top folders loaded (${top.length}).`, "ok");

          const projectFiles = top.find((f) => (f.name || "").toLowerCase() === "project files");
          if (projectFiles) await drillInto(projectFiles);
          return;
        } catch (e) {
          lastError = e;
        }
      }
    }
    throw lastError || new Error("Project id not found in any visible hub.");
  } catch (e) {
    setStatus("Connect failed", "error");
    el("provisionNote").classList.remove("hidden");
    log(`Failed to connect: ${e.message}`, "err");
  }
}

async function drillInto(folder) {
  try {
    log(`Opening '${folder.name}'...`);
    const contents = await Acc.getFolderContentsFull(state.project.id, folder.id);
    state.folderStack.push({ id: folder.id, name: folder.name, folders: contents.folders, files: contents.files });
    renderContentsTable();
    refreshTitleblock();
    log(`Loaded ${contents.folders.length} subfolder(s), ${contents.files.length} file(s) from '${folder.name}'.`);
  } catch (e) {
    log(`Failed to open folder '${folder.name}': ${e.message}`, "err");
  }
}

function goToBreadcrumb(index) {
  state.folderStack = state.folderStack.slice(0, index + 1);
  renderContentsTable();
  refreshTitleblock();
}

function renderBreadcrumb() {
  const crumbWrap = el("folderBreadcrumb");
  crumbWrap.innerHTML = state.folderStack
    .map((node, i) => {
      const isLast = i === state.folderStack.length - 1;
      return `<span class="crumb${isLast ? " current" : ""}" data-index="${i}">${escapeHtml(node.name)}</span>` +
        (isLast ? "" : `<span class="sep">/</span>`);
    })
    .join("");
  crumbWrap.querySelectorAll(".crumb:not(.current)").forEach((elm) => {
    elm.addEventListener("click", () => goToBreadcrumb(Number(elm.dataset.index)));
  });
}

function matchForFile(displayName) {
  const key1 = normalizeName(displayName);
  const row = state.excelRows.get(key1) || state.excelRows.get(normalizeBase(displayName));
  return row || null;
}

// Maps a real file extension to a short flat color chip — the actual AEC formats this tool
// moves (Revit, AutoCAD, IFC, Navisworks, PDF) rather than a generic document-icon set.
const FILE_TYPE_CHIPS = {
  rvt: ["rvt", "RVT"], rfa: ["rvt", "RFA"], rte: ["rvt", "RTE"],
  dwg: ["dwg", "DWG"], dxf: ["dwg", "DXF"],
  ifc: ["ifc", "IFC"],
  nwd: ["nwd", "NWD"], nwc: ["nwd", "NWC"], nwf: ["nwd", "NWF"],
  pdf: ["pdf", "PDF"],
  xlsx: ["xls", "XLS"], xls: ["xls", "XLS"], csv: ["xls", "CSV"],
  docx: ["doc", "DOC"], doc: ["doc", "DOC"],
};
function fileTypeChip(name) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  const [cls, label] = FILE_TYPE_CHIPS[ext] || [null, ext.slice(0, 4).toUpperCase() || "FILE"];
  return `<span class="ftype${cls ? ` ftype-${cls}` : ""}">${escapeHtml(label)}</span>`;
}

// Renders the current folder's subfolders (clickable, drill in) and files (with Excel match
// status) in one table, and keeps state.folders/state.files in sync with the current node.
function renderContentsTable() {
  renderBreadcrumb();
  const current = state.folderStack[state.folderStack.length - 1];
  state.folders = (current && current.folders) || [];
  state.files = (current && current.files) || [];

  const body = el("fileTableBody");
  const total = state.folders.length + state.files.length;
  el("fileCount").textContent = `${total} item${total === 1 ? "" : "s"}`;
  el("footerItemCount").textContent = total;
  el("btnDownloadAll").disabled = !(Session.isSignedIn && state.project);

  if (!current) {
    body.innerHTML = `<tr><td colspan="4" class="col-match match-no">Enter a Hub ID + Project ID and click Connect.</td></tr>`;
    updateApplyButton();
    return;
  }
  if (!total) {
    body.innerHTML = `<tr><td colspan="4" class="col-match match-no">Empty folder.</td></tr>`;
    updateApplyButton();
    return;
  }

  const folderRows = state.folders
    .map((f) => `<tr class="folder-row" data-folder-id="${escapeHtml(f.id)}" style="cursor:pointer;">
        <td></td>
        <td class="col-name"><span class="fi">&#9656;</span> ${escapeHtml(f.name)}</td>
        <td class="col-type">folder</td>
        <td class="col-match match-no">&mdash;</td>
      </tr>`)
    .join("");

  const fileRows = state.files
    .map((f) => {
      const row = matchForFile(f.displayName);
      const matchLabel = row ? "matched" : "no match";
      const matchClass = row ? "match-yes" : "match-no";
      return `<tr>
        <td><input type="checkbox" checked disabled></td>
        <td class="col-name">${fileTypeChip(f.displayName)}${escapeHtml(f.displayName)}</td>
        <td class="col-type">${escapeHtml((f.extensionType || "").split(":").pop() || "—")}</td>
        <td class="col-match ${matchClass}">${matchLabel}</td>
      </tr>`;
    })
    .join("");

  body.innerHTML = folderRows + fileRows;
  body.querySelectorAll("tr.folder-row").forEach((tr) => {
    tr.addEventListener("click", () => {
      const folder = state.folders.find((f) => f.id === tr.dataset.folderId);
      if (folder) drillInto(folder);
    });
  });
  updateApplyButton();
}

function updateApplyButton() {
  const matches = state.files.filter((f) => matchForFile(f.displayName));
  el("btnApply").disabled = !(Session.isSignedIn && state.project && matches.length);
  el("applyTally").textContent = state.excelRows.size
    ? `${matches.length} of ${state.files.length} file(s) have a match`
    : "";
}

async function handleExcelFile(file) {
  try {
    const { rows, diag } = await ExcelReader.readFile(file);
    state.excelRows = rows;
    state.excelFileName = file.name;
    const uniqueNames = new Set([...rows.values()].map((r) => r.fileName));
    el("excelSummary").classList.remove("hidden");
    el("excelPath").textContent = file.name;
    el("excelRowCount").textContent =
      `Loaded ${uniqueNames.size} row(s) (case-insensitive; extension optional).` +
      (diag.sheet ? ` Sheet: ${diag.sheet}.` : "");
    log(`Excel loaded: ${file.name} (${uniqueNames.size} rows, sheet '${diag.sheet}', headers: ${diag.headers.join(", ")}).`);
    renderContentsTable();
  } catch (e) {
    el("excelSummary").classList.add("hidden");
    log(`Excel load failed: ${e.message}`, "err");
  }
}

/* ---------------------------------------------------------------------
 * Apply / sync logic (ported from on_apply_descriptions)
 * ------------------------------------------------------------------- */

async function getCustomAttributeDefinitionsCached(projectId, folderId) {
  if (!folderId) return new Map();
  if (state.customAttrDefsByFolder.has(folderId)) return state.customAttrDefsByFolder.get(folderId);

  const defsMap = new Map();
  try {
    const root = await Acc.getCustomAttributeDefinitions(projectId, folderId);
    let defs = [];
    if (Array.isArray(root)) defs = root;
    else if (root && typeof root === "object") defs = root.data || root.results || root.customAttributes || [];
    for (const item of defs) {
      if (!item || typeof item !== "object") continue;
      const name = item.name || item.displayName || "";
      const key = normalizeName(name);
      if (!key) continue;
      defsMap.set(key, { id: item.id, name, type: item.type });
    }
  } catch (e) {
    log(`Failed to load custom attribute definitions: ${e.message}`, "err");
  }
  state.customAttrDefsByFolder.set(folderId, defsMap);
  return defsMap;
}

async function applyUpdates() {
  if (!state.excelRows.size) { log("Load an Excel file first.", "err"); return; }
  if (!state.project) { log("Select a project first.", "err"); return; }

  const current = state.folderStack[state.folderStack.length - 1];
  const folderId = current ? current.id : null;

  const btn = el("btnApply");
  btn.disabled = true;
  let updated = 0;
  let skipped = 0;

  for (const fileItem of state.files.slice()) {
    const itemLabel = `${fileItem.displayName} [${fileItem.extensionType}]`;
    if (!fileItem.id) { skipped++; log(`Skipped (missing item id): ${itemLabel}`); continue; }

    const row = matchForFile(fileItem.displayName);
    if (!row) { skipped++; log(`Skipped (no Excel row): ${itemLabel}`); continue; }

    let rowAttrs = row.attributes || {};
    if (!Object.keys(rowAttrs).length && row.description) rowAttrs = { description: row.description };

    const normalizedAttrs = {};
    const customAttrValues = {};
    for (const [rawKey, rawValue] of Object.entries(rowAttrs)) {
      const normKey = normalizeName(rawKey);
      const text = rawValue == null ? "" : String(rawValue).trim();
      if (!text) continue;
      const alias = EXCEL_ATTRIBUTE_ALIASES[normKey];
      if (alias) {
        if (!(alias in normalizedAttrs)) normalizedAttrs[alias] = text;
      } else if (normKey && !(normKey in customAttrValues)) {
        customAttrValues[normKey] = text;
      }
    }

    if (!Object.keys(normalizedAttrs).length && !Object.keys(customAttrValues).length) {
      skipped++;
      log(`Skipped (no supported attributes): ${itemLabel}`);
      continue;
    }

    try {
      let tip = null;
      const needItemDetail = "description" in normalizedAttrs || Object.keys(customAttrValues).length > 0;
      if (needItemDetail) {
        try {
          const detail = await Acc.getItemDetail(state.project.id, fileItem.id);
          const data = (detail && detail.data) || {};
          const rel = data.relationships || {};
          tip = ((rel.tip || {}).data || {}).id || null;
        } catch (e) {
          log(`Pre-update fetch failed: ${e.message}`, "err");
        }
      }

      if ("description" in normalizedAttrs) {
        // Autodesk's Data Management API PATCH /items only supports writing the description
        // extension for "items:autodesk.bim360:File" — it explicitly does NOT support
        // Revit Cloud Worksharing/C4R models ("items:autodesk.bim360:C4RModel") or a few other
        // extension types (Data Exchange, Folders). Confirmed via Autodesk's own blog post:
        // https://aps.autodesk.com/blog/write-description-attribute-file-item-acc-and-bim360
        // (tracked as product wish FDM-5304, unresolved). There is no client-side workaround —
        // attempting it returns "client_id is not whitelisted for schema ... access", which is
        // Autodesk's platform-level block, not a hub/Custom-Integration permission gap.
        if (fileItem.extensionType === "items:autodesk.bim360:C4RModel") {
          log(`Skipped description (Autodesk API doesn't support writes on C4R models — see FDM-5304): ${itemLabel}`);
          delete normalizedAttrs.description;
        } else if ((fileItem.extensionType || "").startsWith("items:autodesk.bim360")) {
          if (!("item_description" in normalizedAttrs)) {
            normalizedAttrs.item_description = normalizedAttrs.description;
          }
          delete normalizedAttrs.description;
        } else if (!tip) {
          log(`Skipped description (missing tip version id): ${itemLabel}`);
          delete normalizedAttrs.description;
        }
      }

      let applied = 0;
      let failed = 0;

      if ("description" in normalizedAttrs && tip) {
        try {
          await Acc.updateVersionDescription(state.project.id, tip, normalizedAttrs.description);
          fileItem.description = normalizedAttrs.description;
          applied++;
        } catch (e) {
          failed++;
          log(`Failed to update description: ${itemLabel}: ${e.message}`, "err");
        }
      }
      if ("item_description" in normalizedAttrs) {
        try {
          await Acc.updateFileDescription(state.project.id, fileItem.id, normalizedAttrs.item_description);
          fileItem.description = normalizedAttrs.item_description;
          applied++;
        } catch (e) {
          failed++;
          log(`Failed to update item description: ${itemLabel}: ${e.message}`, "err");
        }
      }
      if ("display_name" in normalizedAttrs) {
        try {
          await Acc.updateItemDisplayName(state.project.id, fileItem.id, normalizedAttrs.display_name);
          fileItem.displayName = normalizedAttrs.display_name;
          applied++;
        } catch (e) {
          failed++;
          log(`Failed to update display name: ${itemLabel}: ${e.message}`, "err");
        }
      }

      if (Object.keys(customAttrValues).length) {
        if (!tip) {
          log(`Skipped custom attributes (missing tip version id): ${itemLabel}`);
        } else {
          try {
            const defsMap = await getCustomAttributeDefinitionsCached(state.project.id, folderId);
            const payload = [];
            const missing = [];
            for (const [key, value] of Object.entries(customAttrValues)) {
              const def = defsMap.get(key);
              if (!def || !def.id) { missing.push(key); continue; }
              payload.push({ id: def.id, value });
            }
            if (missing.length) log(`Custom attributes not found in folder definitions: ${missing.join(", ")}`);
            if (payload.length) {
              await Acc.updateVersionCustomAttributes(state.project.id, tip, payload);
              applied += payload.length;
            }
          } catch (e) {
            failed++;
            log(`Failed to update custom attributes: ${itemLabel}: ${e.message}`, "err");
          }
        }
      }

      if (applied) {
        updated += applied;
        log(`Updated: ${itemLabel} (${applied} attribute${applied === 1 ? "" : "s"}${failed ? `, ${failed} failed` : ""})`, "ok");
      } else if (failed) {
        skipped++;
        log(`Skipped (all attribute updates failed): ${itemLabel}`);
      } else {
        skipped++;
        log(`Skipped (no applicable updates): ${itemLabel}`);
      }
    } catch (e) {
      log(`Failed to update ${itemLabel}: ${e.message}`, "err");
    }
  }

  renderContentsTable();
  el("applyTally").innerHTML = `<b>${updated}</b> updated &middot; <span class="skip">${skipped}</span> skipped`;
  log(`Update finished. Updated: ${updated}, Skipped: ${skipped}.`, "ok");
  btn.disabled = false;
}

/* ---------------------------------------------------------------------
 * Load-by-URL
 * ------------------------------------------------------------------- */

async function loadFolderFromUrl() {
  const url = el("folderUrlInput").value.trim();
  if (!Session.isSignedIn) { log("Sign in first.", "err"); return; }
  const { projectId, folderId } = parseFolderUrl(url);
  if (!folderId) { log("Invalid folder URL. Paste a Project Files folder URL from ACC.", "err"); return; }

  const candidates = projectId ? normalizeProjectIdCandidates(projectId) : [];
  if (state.project && !candidates.includes(state.project.id)) candidates.push(state.project.id);
  if (!candidates.length) { log("No project id found in URL, and no project selected.", "err"); return; }

  const btn = el("btnLoadFolderUrl");
  btn.disabled = true;
  log("Loading contents from URL...");

  let lastError = null;
  for (const pid of candidates) {
    try {
      const contents = await Acc.getFolderContentsFull(pid, folderId);
      state.project = { id: pid, name: state.project ? state.project.name : pid };
      state.hub = state.hub || { id: "", name: "(from URL)" };
      state.folderStack = [{ id: folderId, name: "(from URL)", folders: contents.folders, files: contents.files }];
      el("projectIdInput").value = pid;
      renderContentsTable();
      refreshTitleblock();
      log(`Loaded ${contents.folders.length} subfolder(s), ${contents.files.length} file(s) from URL.`, "ok");
      btn.disabled = false;
      return;
    } catch (e) {
      lastError = e;
      if (!/invalid project id/i.test(e.message || "")) break;
    }
  }
  log(`Failed to load folder URL: ${lastError ? lastError.message : "unknown error"}`, "err");
  btn.disabled = false;
}

/* ---------------------------------------------------------------------
 * Download all data — crawl of the current folder (or, if we're sitting
 * at the project root, every top folder), optionally recursing into
 * subfolders, reading each file's current description + custom attribute
 * values, exported to .xlsx.
 * ------------------------------------------------------------------- */

// Returns true (and notes it in the scan log) when a folder is excluded by the folder-name filter.
// Excluded folders are never opened, so everything beneath them is skipped and costs no API calls.
function isFolderSkipped(skipFolder, folder, path, scanLog) {
  if (!skipFolder || !skipFolder(folder.name)) return false;
  const herePath = path ? `${path}/${folder.name}` : folder.name;
  scanLog.push({ ts: nowStamp(), message: `Skipped '${herePath}' — folder name matches the exclusion filter.` });
  return true;
}

async function crawlFolder(projectId, folder, path, out, seenFolderIds, recursive, scanLog, skipFolder) {
  if (seenFolderIds.has(folder.id)) return; // guards against any cyclical/duplicate refs
  seenFolderIds.add(folder.id);

  const contents = await Acc.getFolderContentsFull(projectId, folder.id);
  const herePath = path ? `${path}/${folder.name}` : folder.name;

  for (const f of contents.files) {
    out.push({ path: herePath, ...f });
  }
  // Buffered: the caller prints all scan lines in one shot once the crawl finishes. Live
  // progress goes to the tally label instead (a single small text node, cheap to update).
  const nowMs = Date.now();
  if (nowMs - (crawlFolder.lastTally || 0) > 250) {
    crawlFolder.lastTally = nowMs;
    el("downloadTally").textContent = `Scanning... ${scanLog.length + 1} folder(s), ${out.length} file(s) so far`;
  }
  scanLog.push({
    ts: nowStamp(),
    message: `Scanned '${herePath}' — ${contents.files.length} file(s), ${contents.folders.length} subfolder(s)` +
      `${recursive ? "" : " (subfolders not included)"}. Total so far: ${out.length}.`,
  });

  if (!recursive) return;
  for (const sub of contents.folders) {
    if (isFolderSkipped(skipFolder, sub, herePath, scanLog)) continue;
    await crawlFolder(projectId, sub, herePath, out, seenFolderIds, recursive, scanLog, skipFolder);
  }
}

// Predicate over a folder name from the "Folder name does not contain" box (same comma = OR,
// semicolon = AND rules as the file name boxes). Returns null when the box is empty.
function buildFolderSkip() {
  const groups = parseFilterGroups(el("filterExcludeFolders").value);
  if (!groups.length) return null;
  return (folderName) => {
    const name = String(folderName || "").toLowerCase();
    return groups.some((g) => g.every((t) => name.includes(t)));
  };
}

function parseFilterList(value) {
  return String(value || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

// "ARC; M3D, STR" -> [["arc","m3d"],["str"]]: comma separates OR groups, semicolon ANDs terms in a group.
function parseFilterGroups(value) {
  return String(value || "").split(",")
    .map((g) => g.split(";").map((s) => s.trim().toLowerCase()).filter(Boolean))
    .filter((g) => g.length);
}

// Builds a predicate over a crawled file from the four filter inputs. File type is the
// extension of the file name (".rvt" or "rvt" both accepted); text matches the whole name.
function buildFileFilter() {
  const incTypes = parseFilterList(el("filterIncludeTypes").value).map((t) => t.replace(/^\./, ""));
  const excTypes = parseFilterList(el("filterExcludeTypes").value).map((t) => t.replace(/^\./, ""));
  const incText = parseFilterGroups(el("filterIncludeText").value);
  const excText = parseFilterGroups(el("filterExcludeText").value);
  const active = !!(incTypes.length || excTypes.length || incText.length || excText.length);
  // A group (terms joined by ";") matches when the name contains every term in it.
  const groupMatches = (name, group) => group.every((t) => name.includes(t));

  const test = (f) => {
    const name = String(f.displayName || "").toLowerCase();
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 ? name.slice(dot + 1) : "";
    if (incTypes.length && !incTypes.includes(ext)) return false;
    if (excTypes.includes(ext)) return false;
    if (incText.length && !incText.some((g) => groupMatches(name, g))) return false;
    if (excText.some((g) => groupMatches(name, g))) return false;
    return true;
  };
  return { active, test };
}

// Runs `worker` over `items` with at most `limit` in flight at once — used so a few hundred
// per-file detail lookups don't run fully sequentially, without hammering the API unbounded.
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function runNext() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runNext));
  return results;
}

async function downloadAllData() {
  if (!state.project) { log("Connect to a project first.", "err"); return; }
  const current = state.folderStack[state.folderStack.length - 1];
  if (!current) { log("Connect to a project first.", "err"); return; }

  const btn = el("btnDownloadAll");
  btn.disabled = true;
  el("downloadTally").textContent = "Scanning...";

  const recursive = el("chkDownloadRecursive").checked;

  try {
    const projectId = state.project.id;
    const collected = [];
    const seen = new Set();
    const scanLog = [];
    const skipFolder = buildFolderSkip();
    log("Per-folder lines print when the scan finishes; running counts show beside the Export button.");
    const stopScanAnimation = startLogAnimation("Scanning");

    try {
      if (current.id == null) {
        // Synthetic project-root node (has no real folder id of its own, and no files of its
        // own either) — sweep every top folder. With subfolders excluded, that means just each
        // top folder's own files, one level deep, rather than nothing at all.
        for (const folder of current.folders) {
          if (isFolderSkipped(skipFolder, folder, "", scanLog)) continue;
          await crawlFolder(projectId, folder, "", collected, seen, recursive, scanLog, skipFolder);
        }
      } else {
        // A real folder — whether reached by drilling in or by pasting a folder URL, it may have
        // files sitting directly inside it as well as subfolders, so crawl it as a single unit
        // (its own files first, then everything beneath it) rather than skipping straight to children.
        const startPath = state.folderStack.slice(0, -1).map((n) => n.name).join("/");
        await crawlFolder(projectId, { id: current.id, name: current.name }, startPath, collected, seen, recursive, scanLog, skipFolder);
      }
    } finally {
      // Drop the animated line, then one DOM write for the whole scan, even if the crawl failed.
      stopScanAnimation();
      logBatch(scanLog);
    }

    // Filter before the per-file description/attribute lookups so excluded files cost no API calls.
    const filter = buildFileFilter();
    if (filter.active) {
      const before = collected.length;
      const kept = collected.filter(filter.test);
      collected.length = 0;
      collected.push(...kept);
      log(`Filters kept ${kept.length} of ${before} file(s).`);
    }

    if (!collected.length) {
      log(filter.active ? "No files match the filters." : "No files found under this folder.", "err");
      el("downloadTally").textContent = filter.active ? "No files match filters." : "No files found.";
      btn.disabled = false;
      return;
    }

    log(`Reading current descriptions for ${collected.length} file(s)...`);
    let descFailures = 0;
    await mapWithConcurrency(collected, 6, async (f) => {
      try {
        const info = await Acc.getItemDescriptionAndTip(projectId, f.id);
        f.description = info.description;
      } catch (e) {
        descFailures++;
      }
    });
    if (descFailures) log(`Could not read description for ${descFailures} file(s) — left blank.`, "err");

    log(`Reading current custom attribute values for ${collected.length} file(s)...`);
    let batchResults = [];
    try {
      batchResults = await Acc.batchGetVersionAttributes(projectId, collected.map((f) => f.id));
    } catch (e) {
      log(`Custom attribute values are not readable from this app/account (${e.message}). ` +
        `Continuing with name/type/description only — see Settings for what this means.`, "err");
    }
    const attrsByItemUrn = new Map(batchResults.map((r) => [r.itemUrn, r]));

    const attrNames = new Set();
    const rows = collected.map((f) => {
      const row = {
        "Folder Path": f.path,
        "File Name": f.displayName,
        "Type": (f.extensionType || "").split(":").pop() || "",
        "Description": f.description || "",
      };
      const batchResult = attrsByItemUrn.get(f.id);
      for (const attr of (batchResult && batchResult.customAttributes) || []) {
        const name = attr.name || "";
        if (!name) continue;
        attrNames.add(name);
        row[name] = attr.value == null ? "" : attr.value;
      }
      return row;
    });

    // Normalize every row to the full set of attribute columns encountered, in a stable order.
    const orderedAttrNames = [...attrNames].sort((a, b) => a.localeCompare(b));
    for (const row of rows) {
      for (const name of orderedAttrNames) if (!(name in row)) row[name] = "";
    }

    const sheet = XLSX.utils.json_to_sheet(rows, {
      header: ["Folder Path", "File Name", "Type", "Description", ...orderedAttrNames],
    });
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "ACC Export");
    const filename = `ACC_Export_${state.project.name || state.project.id}.xlsx`.replace(/[\\/:*?"<>|]/g, "_");
    XLSX.writeFile(workbook, filename);

    el("downloadTally").textContent = `${rows.length} file(s), ${orderedAttrNames.length} attribute column(s).`;
    log(`Export ready: ${rows.length} file(s) across ${seen.size} folder(s)${recursive ? "" : " (subfolders not included)"}, ` +
      `${orderedAttrNames.length} attribute column(s). Downloaded as ${filename}.`, "ok");
  } catch (e) {
    log(`Download all data failed: ${e.message}`, "err");
    el("downloadTally").textContent = "Failed — see log.";
  } finally {
    btn.disabled = !(Session.isSignedIn && state.project);
  }
}

/* ---------------------------------------------------------------------
 * Wire up DOM events
 * ------------------------------------------------------------------- */

function initEvents() {
  el("btnSignIn").addEventListener("click", () => Auth.login());
  el("btnSignOut").addEventListener("click", () => {
    Auth.signOut();
    state.hub = null; state.project = null;
    state.folderStack = []; state.folders = []; state.files = [];
    renderContentsTable();
    refreshTitleblock();
    renderSignedInUi();
  });

  el("btnSettings").addEventListener("click", openSettings);
  el("btnSettingsCancel").addEventListener("click", closeSettings);
  el("btnSettingsSave").addEventListener("click", () => {
    Settings.clientId = el("clientIdInput").value.trim();
    Settings.clientSecret = el("clientSecretInput").value.trim();
    closeSettings();
    log(Settings.clientSecret ? "Settings saved (using client_secret auth)." : "Settings saved (using PKCE).");
  });
  el("linkProvisionHelp").addEventListener("click", (e) => {
    e.preventDefault();
    openSettings();
    el("provisionHelp").scrollIntoView({ behavior: "smooth", block: "center" });
  });

  el("projectIdInput").addEventListener("input", updateConnectButton);
  el("btnConnect").addEventListener("click", connect);
  el("btnLoadFolderUrl").addEventListener("click", loadFolderFromUrl);
  el("btnDownloadAll").addEventListener("click", downloadAllData);

  const dropzone = el("dropzone");
  const excelInput = el("excelInput");
  dropzone.addEventListener("click", () => excelInput.click());
  excelInput.addEventListener("change", () => {
    if (excelInput.files[0]) handleExcelFile(excelInput.files[0]);
  });
  ["dragenter", "dragover"].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.add("drag"); })
  );
  ["dragleave", "drop"].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.remove("drag"); })
  );
  dropzone.addEventListener("drop", (e) => {
    const file = e.dataTransfer.files[0];
    if (file) handleExcelFile(file);
  });

  el("btnApply").addEventListener("click", () => {
    const matches = state.files.filter((f) => matchForFile(f.displayName)).length;
    if (confirm(`Apply updates to ${matches} matched file(s) in ACC Docs? This writes changes immediately.`)) {
      applyUpdates();
    }
  });

  el("consoleHead").addEventListener("click", () => el("console").classList.toggle("collapsed"));
  el("btnClearLog").addEventListener("click", (e) => { e.stopPropagation(); el("consoleBody").innerHTML = ""; });
}

/* ---------------------------------------------------------------------
 * Init
 * ------------------------------------------------------------------- */

async function init() {
  initEvents();
  Session.load();
  renderSignedInUi();
  refreshTitleblock();
  renderContentsTable();
  updateConnectButton();

  await Auth.handleCallback();
  renderSignedInUi();
}

document.addEventListener("DOMContentLoaded", init);
