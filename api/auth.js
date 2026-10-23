const { send, sameSecret, issueSession } = require("../server/shared");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Method not allowed" });
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  if (body.logout === true) {
    res.setHeader("Set-Cookie", "boiler_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict");
    return send(res, 200, { authenticated: false });
  }
  if (!process.env.DASHBOARD_PASSWORD || !process.env.SESSION_SECRET) {
    return send(res, 503, { error: "Dashboard login is not configured" });
  }
  if (!sameSecret(body.password, process.env.DASHBOARD_PASSWORD)) {
    return send(res, 401, { error: "Incorrect password" });
  }
  issueSession(res);
  return send(res, 200, { authenticated: true });
};
