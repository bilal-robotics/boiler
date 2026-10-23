/* ============================================================
 * COSMO — Smart Steam Boiler dashboard logic
 * Talks to the Vercel API (/api/auth, /api/telemetry, /api/control)
 * which stores controller telemetry in Supabase.
 * ============================================================ */
"use strict";

const ONLINE_WINDOW_MS = 35000;   // a sample is "live" for this long after arrival
const POLL_MS = 2000;             // latest-state polling cadence
const HISTORY_REFRESH_MS = 60000; // full 24h history refresh cadence
const LEASE_RENEW_MS = 5000;      // manual lease renewal (server lease is 12s)
const CHART = { left: 55, right: 875, top: 30, bottom: 270, max: 180 };

const state = {
  latest: null,
  history: [],
  serverSkewMs: 0,
  hasServerTime: false,
  lastHistoryFetch: 0,
  rangeHours: 24,
  manual: false,
  targetPsi: 55,
  targetTempC: 145,
  remoteSecure: true,
  busy: false,
  refreshing: false,
};

const $ = (id) => document.getElementById(id);

/* ---------------- transport ---------------- */
async function request(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  try {
    const response = await fetch(url, {
      cache: "no-store",
      ...options,
      signal: controller.signal,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw Object.assign(new Error(body.error || `Request failed (${response.status})`), { status: response.status });
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- auth ---------------- */
function showLogin(message = "") {
  $("login-screen").hidden = false;
  $("app").hidden = true;
  $("login-error").textContent = message;
}
function showApp() {
  $("login-screen").hidden = true;
  $("app").hidden = false;
}

/* ---------------- helpers ---------------- */
function serverNow() { return Date.now() + state.serverSkewMs; }
function fmtClock(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function formatUptime(seconds) {
  if (!Number.isFinite(seconds)) return "—";
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h >= 100 ? `${h}h` : `${h}h ${m}m`;
}
function signalInfo(online) {
  const rssi = Number(state.latest?.rssi);
  if (!online) return { bars: 0, label: "OFFLINE", tone: "off" };
  if (!Number.isFinite(rssi) || rssi === 0) return { bars: 0, label: "NO SIGNAL", tone: "off" };
  if (rssi >= -55) return { bars: 4, label: "EXCELLENT", tone: "" };
  if (rssi >= -65) return { bars: 3, label: "GOOD", tone: "" };
  if (rssi >= -75) return { bars: 2, label: "FAIR", tone: "fair" };
  return { bars: 1, label: "WEAK", tone: "weak" };
}
function paintBars(container, bars, tone) {
  if (!container) return;
  container.querySelectorAll("i").forEach((node, index) => node.classList.toggle("on", index < bars));
  container.classList.remove("fair", "weak", "off");
  if (tone) container.classList.add(tone);
}
function paintStatus(node, text, color) {
  node.textContent = text;
  node.style.color = color;
}
// SVG elements (e.g. the chart's empty-state label) have no `.hidden` IDL
// property, so toggle the attribute instead.
function setHidden(element, hidden) {
  if (!element) return;
  if (hidden) element.setAttribute("hidden", "");
  else element.removeAttribute("hidden");
}
function isOnline() {
  if (!state.latest?.receivedAt) return false;
  return serverNow() - Date.parse(state.latest.receivedAt) < ONLINE_WINDOW_MS;
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
state.setpointsDirty = false;

/* ---------------- connectivity + summary cards ---------------- */
function renderConnectivity(online) {
  const info = signalInfo(online);
  paintBars($("header-bars"), info.bars, info.tone);
  paintBars($("wifi-bars"), info.bars, info.tone);
  $("online-label").textContent = online ? "ONLINE" : "OFFLINE";
  $("online-label").style.color = online ? "#10e89d" : "#ff536c";
  $("wifi-value").textContent = info.label;
  $("wifi-value").style.color = info.tone === "" ? "#10e89d" : info.tone === "fair" ? "#ff9b31" : "#ff536c";
  const rssi = Number(state.latest?.rssi);
  $("wifi-sub").textContent = online && Number.isFinite(rssi) && rssi !== 0 ? `${rssi} dBm` : "Signal Status";
}

function renderSetpoints() {
  const p = $("pressure-target"), t = $("temperature-target");
  if (!state.setpointsDirty) {
    p.value = state.targetPsi;
    t.value = state.targetTempC;
  }
  $("pressure-target-output").textContent = `${p.value} PSI`;
  $("temperature-target-output").textContent = `${t.value} °C`;
}

function renderControls(online) {
  const d = state.latest || {};
  const chip = $("manual-connection");
  chip.textContent = !online ? "DEVICE OFFLINE" : state.manual ? "MANUAL ACTIVE" : "DEVICE CONNECTED";
  chip.classList.toggle("offline", !online);
  chip.classList.toggle("manual", online && state.manual);

  $("manual-mode").checked = state.manual;
  $("manual-pump").checked = state.manual && Boolean(d.manualPump);
  $("manual-heater").checked = state.manual && Boolean(d.manualHeater);
  $("manual-mode").disabled = !online;
  $("manual-pump").disabled = !online || !state.manual;
  $("manual-heater").disabled = !online || !state.manual;
  $("save-settings").disabled = !online;

  $("settings-feedback").textContent = !state.remoteSecure
    ? "Targets save to the controller, but firmware TLS validation is disabled (USE_ROOT_CA 0)."
    : "Changes apply through the controller's protected control loop.";

  if (state.busy) return;
  if (!online) {
    $("manual-feedback").textContent = "Controller offline — manual requests are unavailable.";
  } else if (!state.remoteSecure) {
    $("manual-feedback").textContent = "Remote control is active. Note: the firmware is not validating the server TLS certificate (USE_ROOT_CA 0) — enable it before production use.";
  } else if (!state.manual) {
    $("manual-feedback").textContent = "Automatic control active. Switch to manual to request the pump or heater.";
  } else {
    $("manual-feedback").textContent = "Manual request renewed; controller interlocks stay active.";
  }
}

function renderDashboard() {
  const d = state.latest;
  if (!d) return;
  const online = isOnline();
  renderConnectivity(online);
  const receivedMs = Date.parse(d.receivedAt);
  $("last-update").textContent = online ? fmtClock(receivedMs) : "stale";
  $("firmware-version").textContent = `FW ${d.fw || "--"}`;

  let boiler = "OFF", boilerColor = "#a9c4dc", boilerOn = false;
  if (!online) { boiler = "OFF"; }
  else if (d.err3) { boiler = "LOCK"; boilerColor = "#ff536c"; }
  else if (d.pump || d.heater) { boiler = "ON"; boilerColor = "#10e89d"; boilerOn = true; }
  paintStatus($("boiler-value"), boiler, boilerColor);
  $("boiler-toggle").classList.toggle("off", !boilerOn);

  let status = "Normal", statusColor = "#10e89d", locked = false;
  if (!online) { status = "Offline"; statusColor = "#ff536c"; locked = true; }
  else if (d.err3) { status = "Critical LOCK"; statusColor = "#ff536c"; locked = true; }
  else if (d.err1) { status = "Error 1"; statusColor = "#ff536c"; locked = true; }
  else if (d.err2) { status = "Error 2"; statusColor = "#ff9b31"; locked = true; }
  else if (d.fault) { status = "Sensor Fault"; statusColor = "#ff9b31"; locked = true; }
  else if (d.cooldown) { status = "Heater LOCK"; statusColor = "#ff9b31"; locked = true; }
  paintStatus($("status-value"), status, statusColor);
  $("status-icon").classList.toggle("off", !locked);

  $("hours-value").textContent = formatUptime(Number(d.up));

  paintStatus($("pump-value"), d.pump ? "ON" : "OFF", d.pump ? "#10e89d" : "#7d93a8");
  let heater = "OFF", heaterColor = "#7d93a8";
  if (d.err3) { heater = "LOCK"; heaterColor = "#ff536c"; }
  else if (d.heater) { heater = "ON"; heaterColor = "#ff9b31"; }
  else if (d.cooldown || d.fault) { heater = "LOCK"; heaterColor = "#ff9b31"; }
  paintStatus($("heater-value"), heater, heaterColor);

  $("pressure-value").textContent = Number.isFinite(d.psi) ? Number(d.psi).toFixed(1) : "--";
  $("temp-value").textContent = Number.isFinite(d.temp) ? Number(d.temp).toFixed(1) : "--";

  state.manual = Boolean(d.manual);
  state.remoteSecure = d.remoteSecure === true;
  state.targetPsi = Number.isFinite(d.targetPsi) ? d.targetPsi : state.targetPsi;
  state.targetTempC = Number.isFinite(d.targetTempC) ? d.targetTempC : state.targetTempC;

  renderSetpoints();
  renderChart();
  renderTimeline();
  renderAlerts();
  renderControls(online);
}

function renderEmpty() {
  renderConnectivity(false);
  $("last-update").textContent = "NO DATA";
  $("hours-value").textContent = "—";
  paintStatus($("boiler-value"), "OFF", "#a9c4dc");
  $("boiler-toggle").classList.add("off");
  paintStatus($("status-value"), "Waiting", "#ff9b31");
  $("status-icon").classList.add("off");
  paintStatus($("pump-value"), "--", "#7d93a8");
  paintStatus($("heater-value"), "--", "#7d93a8");
  $("pressure-value").textContent = "--";
  $("temp-value").textContent = "--";
  setHidden($("chart-empty"), false);
  $("trend-pressure").setAttribute("points", "");
  $("trend-temp").setAttribute("points", "");
  $("trend-xlabels").innerHTML = "";
  $("pump-track").innerHTML = "";
  $("heater-track").innerHTML = "";
  $("alert-current").innerHTML = '<article class="alert-row"><svg viewBox="0 0 32 32"><use href="#i-bell"/></svg><div><strong>Waiting for controller</strong><small>No telemetry has been received yet.</small></div></article>';
  renderControls(false);
}

function renderError(error) {
  renderConnectivity(false);
  $("last-update").textContent = "UNAVAILABLE";
  $("manual-feedback").textContent = error.message;
  $("alert-current").innerHTML = `<article class="alert-row critical"><svg viewBox="0 0 32 32"><use href="#i-bell"/></svg><div><strong>Dashboard link problem</strong><small>${escapeHtml(error.message)}</small></div></article>`;
  renderControls(false);
}

/* ---------------- trend chart (SVG) ---------------- */
function chartWindow() {
  const newest = state.latest ? Date.parse(state.latest.receivedAt) : Date.now();
  const windowMs = state.rangeHours * 3600000;
  return { startMs: newest - windowMs, windowMs };
}

function seriesPoints(samples, key, window) {
  const usable = samples.filter((sample) => Number.isFinite(sample[key]));
  if (!usable.length) return "";
  return usable.map((sample) => {
    const t = Date.parse(sample.receivedAt);
    const ratio = Math.max(0, Math.min(1, (t - window.startMs) / window.windowMs));
    const x = CHART.left + ratio * (CHART.right - CHART.left);
    const value = Math.max(0, Math.min(CHART.max, Number(sample[key])));
    const y = CHART.bottom - (value / CHART.max) * (CHART.bottom - CHART.top);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
}

function renderXLabels(window) {
  const pad = (n) => String(n).padStart(2, "0");
  let html = "";
  for (let i = 0; i <= 6; i++) {
    const x = CHART.left + (CHART.right - CHART.left) * i / 6;
    const t = new Date(window.startMs + window.windowMs * i / 6);
    html += `<text x="${x.toFixed(0)}" y="298" text-anchor="middle">${pad(t.getHours())}:${pad(t.getMinutes())}</text>`;
  }
  $("trend-xlabels").innerHTML = html;
}

function renderChart() {
  const window = chartWindow();
  const samples = state.history.filter((sample) => Date.parse(sample.receivedAt) >= window.startMs);
  const current = state.latest;
  if (current && (!samples.length || samples[samples.length - 1].receivedAt !== current.receivedAt)) samples.push(current);
  renderXLabels(window);
  $("trend-pressure").setAttribute("points", seriesPoints(samples, "psi", window));
  $("trend-temp").setAttribute("points", seriesPoints(samples, "temp", window));
  setHidden($("chart-empty"), samples.some((sample) => Number.isFinite(sample.psi) || Number.isFinite(sample.temp)));
}

/* ---------------- state timeline ---------------- */
function renderTrack(track, samples, classOf, window) {
  if (!samples.length) { track.innerHTML = ""; return; }
  const points = samples.map((sample) => ({ t: Date.parse(sample.receivedAt), c: classOf(sample) }));
  const segments = [];
  let current = null;
  points.forEach((point, index) => {
    const next = points[index + 1];
    const end = next ? next.t : Math.min(point.t + 15000, window.startMs + window.windowMs);
    if (current && current.c === point.c) current.end = end;
    else { current = { c: point.c, start: point.t, end }; segments.push(current); }
  });
  track.innerHTML = segments.map((segment) => {
    const left = Math.max(0, (segment.start - window.startMs) / window.windowMs) * 100;
    const right = Math.min(1, (segment.end - window.startMs) / window.windowMs) * 100;
    return `<div class="seg ${segment.c}" style="left:${left.toFixed(2)}%;width:${Math.max(0.4, right - left).toFixed(2)}%"></div>`;
  }).join("");
}

function renderTimeline() {
  const window = chartWindow();
  const samples = state.history.filter((sample) => Date.parse(sample.receivedAt) >= window.startMs);
  renderTrack($("pump-track"), samples, (s) => (s.err3 ? "lockseg" : s.pump ? "on" : "off"), window);
  renderTrack($("heater-track"), samples, (s) => (s.err3 ? "lockseg" : s.heater ? "on" : "off"), window);
}

/* ---------------- alerts + event history ---------------- */
function renderAlerts() {
  const d = state.latest;
  if (!d) return;
  const items = [];
  if (d.err3) items.push(["critical", "Critical safety trip", "Both pump and heater are disabled until pressure and temperature return to safe limits."]);
  if (d.err1) items.push(["critical", "Error 1 · Water not detected", "Pump timed out before the water probe was reached."]);
  if (d.err2) items.push(["warning", "Error 2 · Refill timeout", "Water was not detected within the refill window."]);
  if (d.fault) items.push(["warning", "Sensor fault", "A required sensor is unreadable; the heater is inhibited."]);
  if (d.cooldown && !d.err3) items.push(["warning", "Heater safety hold", "Heating resumes only after both readings fall below their reset thresholds."]);
  if (!items.length) items.push(["", "No active alerts", "Controller reports normal operation."]);

  const activeCount = [d.err1, d.err2, d.err3, d.fault].filter(Boolean).length;
  $("alert-count").hidden = activeCount === 0;
  $("alert-count").textContent = String(activeCount);
  $("alert-current").innerHTML = items.map(([kind, title, detail]) =>
    `<article class="alert-row ${kind}"><svg viewBox="0 0 32 32"><use href="#${kind ? "i-bell" : "i-shield"}"/></svg><div><strong>${title}</strong><small>${detail}</small></div></article>`
  ).join("");

  const events = state.history.slice(-30).reverse();
  $("event-list").innerHTML = events.length ? events.map((sample) => {
    const time = fmtClock(Date.parse(sample.receivedAt) || Date.now());
    const label = sample.err3 ? "Critical trip" : sample.err2 ? "Error 2" : sample.err1 ? "Error 1" : sample.fault ? "Sensor fault" : sample.heater ? "Heater active" : sample.pump ? "Pump active" : "System normal";
    const value = Number.isFinite(sample.psi) ? `${Number(sample.psi).toFixed(1)} PSI` : "Pressure unavailable";
    return `<div class="event-item"><time>${time}</time><span>${label}</span><span class="event-value">${value}</span></div>`;
  }).join("") : '<p class="empty-copy">Waiting for controller telemetry.</p>';
}

/* ---------------- navigation ---------------- */
function setPage(page) {
  document.querySelectorAll(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.page === page));
  document.querySelectorAll(".page").forEach((section) => section.classList.toggle("active", section.id === `page-${page}`));
}

/* ---------------- data refresh ---------------- */
async function refresh(forceHistory = false) {
  if (state.refreshing) return;
  state.refreshing = true;
  try {
    const historyDue = forceHistory || Date.now() - state.lastHistoryFetch >= HISTORY_REFRESH_MS;
    const data = await request(`/api/telemetry${historyDue ? "?history=1" : ""}`);
    if (typeof data.serverTime === "string") state.serverSkewMs = Date.parse(data.serverTime) - Date.now();
    state.latest = data.latest || null;
    if (historyDue && Array.isArray(data.history)) {
      state.history = data.history;
      state.lastHistoryFetch = Date.now();
    }
    if (!state.latest) { renderEmpty(); showApp(); return; }
    renderDashboard();
    showApp();
  } catch (error) {
    if (error.status === 401) { state.latest = null; state.history = []; showLogin(); return; }
    renderError(error);
    showApp();
  } finally {
    state.refreshing = false;
  }
}

/* ---------------- control actions ---------------- */
async function sendControl() {
  if (state.busy) return;
  state.busy = true;
  const payload = {
    manual: $("manual-mode").checked,
    pump: $("manual-pump").checked,
    heater: $("manual-heater").checked,
    targetPsi: Number($("pressure-target").value),
    targetTempC: Number($("temperature-target").value),
  };
  try {
    const result = await request("/api/control", { method: "POST", body: JSON.stringify(payload) });
    state.manual = Boolean(result.manual);
    state.targetPsi = result.targetPsi;
    state.targetTempC = result.targetTempC;
    state.setpointsDirty = false;
    $("manual-feedback").textContent = result.manual ? "Manual request renewed; controller interlocks stay active." : "Automatic control selected.";
    $("settings-feedback").textContent = "Targets saved to the controller command service.";
    $("settings-feedback").style.color = "#10e89d";
  } catch (error) {
    $("manual-feedback").textContent = error.message;
    $("settings-feedback").textContent = error.message;
    $("settings-feedback").style.color = "#ff536c";
    if (error.status === 401) showLogin("Session expired. Sign in again.");
  } finally {
    state.busy = false;
  }
}

/* ---------------- boot ---------------- */
document.addEventListener("DOMContentLoaded", () => {
  $("app").hidden = true;
  $("login-screen").hidden = false;

  document.querySelectorAll(".nav-item").forEach((button) => button.addEventListener("click", () => setPage(button.dataset.page)));

  $("login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.target.querySelector("button");
    button.disabled = true;
    try {
      await request("/api/auth", { method: "POST", body: JSON.stringify({ password: $("login-password").value }) });
      $("login-password").value = "";
      await refresh(true);
    } catch (error) {
      showLogin(error.message);
    } finally {
      button.disabled = false;
    }
  });

  $("logout-button").addEventListener("click", async () => {
    await request("/api/auth", { method: "POST", body: JSON.stringify({ logout: true }) }).catch(() => {});
    state.latest = null;
    state.history = [];
    showLogin();
  });

  $("manual-mode").addEventListener("change", () => {
    if (!$("manual-mode").checked) { $("manual-pump").checked = false; $("manual-heater").checked = false; }
    $("manual-pump").disabled = !$("manual-mode").checked;
    $("manual-heater").disabled = !$("manual-mode").checked;
    sendControl();
  });
  $("manual-pump").addEventListener("change", sendControl);
  $("manual-heater").addEventListener("change", () => {
    if ($("manual-heater").checked && !state.latest?.water) {
      $("manual-heater").checked = false;
      $("manual-feedback").textContent = "Heater request blocked: water is not detected.";
      return;
    }
    sendControl();
  });

  const markDirty = () => { state.setpointsDirty = true; renderSetpoints(); };
  $("pressure-target").addEventListener("input", markDirty);
  $("temperature-target").addEventListener("input", markDirty);
  $("save-settings").addEventListener("click", sendControl);

  $("range-select").addEventListener("change", () => {
    state.rangeHours = Number($("range-select").value);
    $("trend-caption").textContent = `(Last ${state.rangeHours} Hour${state.rangeHours === 1 ? "" : "s"})`;
    renderChart();
    renderTimeline();
  });

  refresh(true);
  setInterval(() => refresh(false), POLL_MS);
  setInterval(() => { if (state.manual && $("manual-mode").checked) sendControl(); }, LEASE_RENEW_MS);
});
