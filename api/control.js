const { send, deviceAuthorized, dashboardAuthorized, supabaseRequest } = require("../server/shared");

const DEFAULT_SETTINGS = { targetPsi: 55, targetTempC: 145 };

module.exports = async function handler(req, res) {
  if (req.method === "GET") {
    if (!deviceAuthorized(req)) return send(res, 401, { error: "Unauthorized device" });
    try {
      const rows = await supabaseRequest("boiler_control?select=manual,pump,heater,target_psi,target_temp_c,updated_at&id=eq.true&limit=1");
      const row = rows[0];
      const leaseActive = row && Date.now() - new Date(row.updated_at).getTime() < 12000;
      return send(res, 200, {
        targetPsi: row?.target_psi ?? DEFAULT_SETTINGS.targetPsi,
        targetTempC: row?.target_temp_c ?? DEFAULT_SETTINGS.targetTempC,
        manual: Boolean(leaseActive && row.manual),
        pump: Boolean(leaseActive && row.pump),
        heater: Boolean(leaseActive && row.heater),
      });
    } catch (error) {
      return send(res, 503, { error: error.message || "Control storage unavailable" });
    }
  }

  if (req.method !== "POST") return send(res, 405, { error: "Method not allowed" });
  if (!dashboardAuthorized(req)) return send(res, 401, { error: "Sign in to change settings" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const targetPsi = Number(body.targetPsi);
    const targetTempC = Number(body.targetTempC);
    if (typeof body.manual !== "boolean" || typeof body.pump !== "boolean" ||
        typeof body.heater !== "boolean" || !Number.isFinite(targetPsi) ||
        targetPsi < 15 || targetPsi > 60 || !Number.isFinite(targetTempC) ||
        targetTempC < 80 || targetTempC > 160 || (body.heater && !body.manual)) {
      return send(res, 400, { error: "Invalid request. Operating targets: 15–60 PSI, 80–160 °C; heater requires manual mode." });
    }
    const command = { manual: body.manual, pump: body.manual && body.pump, heater: body.manual && body.heater };
    await supabaseRequest("boiler_control?on_conflict=id", {
      method: "POST",
      body: [{ id: true, manual: command.manual, pump: command.pump, heater: command.heater, target_psi: targetPsi, target_temp_c: targetTempC, updated_at: new Date().toISOString() }],
      prefer: "resolution=merge-duplicates,return=minimal",
    });
    return send(res, 200, { accepted: true, targetPsi, targetTempC, ...command, leaseSeconds: 12 });
  } catch (error) {
    return send(res, 503, { error: error.message || "Control storage unavailable" });
  }
};
