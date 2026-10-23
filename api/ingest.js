const { send, deviceAuthorized, supabaseRequest } = require("../server/shared");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Method not allowed" });
  if (!deviceAuthorized(req)) return send(res, 401, { error: "Unauthorized device" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const boolFields = ["water", "pump", "heater", "err1", "err2", "err3", "cooldown", "fault"];
    if (typeof body.fw !== "string" || !Number.isFinite(body.up) ||
        boolFields.some((key) => typeof body[key] !== "boolean") ||
        !(body.temp === null || Number.isFinite(body.temp)) ||
        !(body.psi === null || Number.isFinite(body.psi))) {
      return send(res, 400, { error: "Telemetry payload does not match firmware schema" });
    }
    const sample = { ...body, receivedAt: new Date().toISOString() };
    await supabaseRequest("boiler_telemetry", {
      method: "POST",
      body: { payload: sample },
      prefer: "return=minimal",
    });
    return send(res, 202, { accepted: true });
  } catch (error) {
    return send(res, 503, { error: error.message || "Telemetry storage unavailable" });
  }
};
