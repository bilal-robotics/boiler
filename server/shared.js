const crypto = require("node:crypto");

function send(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function sameSecret(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function bearer(req) {
  const value = req.headers.authorization || "";
  return value.startsWith("Bearer ") ? value.slice(7) : "";
}

function deviceAuthorized(req) {
  return sameSecret(bearer(req), process.env.DEVICE_TOKEN);
}

function dashboardAuthorized(req) {
  const cookies = (req.headers.cookie || "").split(";");
  const cookie = cookies.map((part) => part.trim()).find((part) => part.startsWith("boiler_session="));
  if (!cookie || !process.env.SESSION_SECRET) return false;
  const [expires, signature] = cookie.slice("boiler_session=".length).split(".");
  if (!/^\d+$/.test(expires) || Number(expires) <= Math.floor(Date.now() / 1000)) return false;
  const expected = crypto.createHmac("sha256", process.env.SESSION_SECRET).update(expires).digest("hex");
  return sameSecret(signature, expected);
}

function issueSession(res) {
  const expires = String(Math.floor(Date.now() / 1000) + 12 * 60 * 60);
  const signature = crypto.createHmac("sha256", process.env.SESSION_SECRET).update(expires).digest("hex");
  res.setHeader("Set-Cookie", `boiler_session=${expires}.${signature}; Path=/; Max-Age=43200; HttpOnly; Secure; SameSite=Strict`);
}

function supabaseConfig() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error("Supabase project URL and server-side service key are not configured in Vercel");
  return { url: url.replace(/\/$/, ""), key };
}

async function supabaseRequest(path, { method = "GET", body, prefer } = {}) {
  const { url, key } = supabaseConfig();
  const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  if (prefer) headers.Prefer = prefer;
  const response = await fetch(`${url}/rest/v1/${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    let detail = text;
    try { detail = JSON.parse(text).message || JSON.parse(text).hint || text; } catch {}
    throw new Error(`Supabase request failed (${response.status}): ${detail}`);
  }
  return text ? JSON.parse(text) : null;
}

// PostgREST caps a single response at the project's `db-max-rows` (1000 by
// default). A 24-hour history is far larger than that, so this walks the table
// with `Range` headers and stitches every page together. The result is the full
// history instead of only the newest 1000 rows.
async function supabaseRequestAll(path, { pageSize = 1000, maxRows = 20000 } = {}) {
  const { url, key } = supabaseConfig();
  const rows = [];
  for (let start = 0; start < maxRows; start += pageSize) {
    const end = Math.min(start + pageSize, maxRows) - 1;
    const response = await fetch(`${url}/rest/v1/${path}`, {
      method: "GET",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Range: `${start}-${end}`,
        "Range-Unit": "items",
      },
    });
    const text = await response.text();
    if (!response.ok) {
      let detail = text;
      try { detail = JSON.parse(text).message || JSON.parse(text).hint || text; } catch {}
      throw new Error(`Supabase request failed (${response.status}): ${detail}`);
    }
    const page = text ? JSON.parse(text) : [];
    if (!Array.isArray(page) || page.length === 0) break;
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}

module.exports = { send, sameSecret, deviceAuthorized, dashboardAuthorized, issueSession, supabaseRequest, supabaseRequestAll };
