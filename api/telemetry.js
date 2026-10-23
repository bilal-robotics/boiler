const { send, dashboardAuthorized, supabaseRequest, supabaseRequestAll } = require("../server/shared");

// The chart only needs a smooth trend, not every stored sample. When the
// controller pushes frequent updates, the 24-hour history can hold tens of
// thousands of rows; we fetch them all (paginated) and then thin them down so
// the browser receives a small, fast payload.
const HISTORY_MAX_POINTS = 1200;
const HISTORY_MAX_ROWS = 20000;
const HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000;

const STATE_FLAGS = ["pump", "heater", "water", "err1", "err2", "err3", "fault"];

// Supabase rows arrive as { payload, created_at }, so read flags from the
// payload when present and fall back to the row itself for plain objects.
function flagOf(row, key) {
  const source = row && row.payload ? row.payload : row;
  return source ? source[key] : undefined;
}

function isStateChange(previous, current) {
  if (!previous) return true;
  return STATE_FLAGS.some((key) => flagOf(previous, key) !== flagOf(current, key));
}

// Keep every on/off transition (so the state timeline stays accurate) and fill
// the gaps with evenly spaced samples up to the point budget.
function downsampleHistory(rows, maxPoints) {
  if (rows.length <= maxPoints) return rows;
  const step = rows.length / maxPoints;
  const keep = new Set();
  for (let k = 0; k < maxPoints; k++) {
    keep.add(Math.min(rows.length - 1, Math.round(k * step)));
  }
  keep.add(rows.length - 1);
  for (let i = 1; i < rows.length; i++) {
    if (isStateChange(rows[i - 1], rows[i])) keep.add(i);
  }
  return [...keep].sort((a, b) => a - b).map((index) => rows[index]);
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return send(res, 405, { error: "Method not allowed" });
  if (!dashboardAuthorized(req)) return send(res, 401, { error: "Sign in to view boiler data" });
  try {
    const includeHistory = req.query?.history === "1";
    const latestQuery = new URLSearchParams({ select: "payload,created_at", order: "created_at.desc", limit: "1" });
    const latestRows = await supabaseRequest(`boiler_telemetry?${latestQuery}`);
    const latestRow = latestRows[0];
    const latest = latestRow ? { ...latestRow.payload, receivedAt: latestRow.created_at } : null;
    // serverTime lets the dashboard measure staleness against the server clock
    // instead of the (often wrong) browser clock.
    const result = { latest, serverTime: new Date().toISOString() };
    if (includeHistory) {
      const cutoff = new Date(Date.now() - HISTORY_WINDOW_MS).toISOString();
      const historyQuery = new URLSearchParams({
        select: "payload,created_at",
        created_at: `gte.${cutoff}`,
        order: "created_at.asc",
      });
      const historyRows = await supabaseRequestAll(`boiler_telemetry?${historyQuery}`, { pageSize: 1000, maxRows: HISTORY_MAX_ROWS });
      result.history = downsampleHistory(historyRows, HISTORY_MAX_POINTS)
        .map((row) => ({ ...row.payload, receivedAt: row.created_at }));
    }
    return send(res, 200, result);
  } catch (error) {
    return send(res, 503, { error: error.message || "Telemetry storage unavailable" });
  }
};

// Exposed for unit tests.
module.exports.downsampleHistory = downsampleHistory;
