const { send, supabaseRequest } = require("../server/shared");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return send(res, 405, { error: "Method not allowed" });
  try {
    await Promise.all([
      supabaseRequest("boiler_telemetry?select=id&limit=0"),
      supabaseRequest("boiler_control?select=id&limit=0"),
    ]);
    return send(res, 200, { status: "ready", database: "connected", schema: "ready" });
  } catch {
    return send(res, 503, { status: "not-ready", database: "unavailable" });
  }
};
