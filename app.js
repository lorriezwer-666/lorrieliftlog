/* LiftLog - simple weight-training tracker with Strava push
 * All data lives in localStorage. Strava OAuth token exchange & activity
 * creation go through a small serverless proxy (see worker.js / SETUP.md)
 * because Strava's oauth/token endpoint does not support CORS.
 */

//////////////////////// STORAGE ////////////////////////

const DEFAULT_EXERCISES = [
  "Bench Press", "Squat", "Deadlift", "Overhead Press", "Barbell Row",
  "Pull-up", "Lat Pulldown", "Incline Dumbbell Press", "Dumbbell Curl",
  "Tricep Pushdown", "Leg Press", "Romanian Deadlift", "Hip Thrust", "Plank"
];

const Store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) { return fallback; }
  },
  set(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  },
  exercises() { return this.get("liftlog_exercises", DEFAULT_EXERCISES); },
  setExercises(list) { this.set("liftlog_exercises", list); },
  active() { return this.get("liftlog_active", null); },
  setActive(w) { this.set("liftlog_active", w); },
  history() { return this.get("liftlog_history", []); },
  setHistory(h) { this.set("liftlog_history", h); },
  strava() { return this.get("liftlog_strava", null); },
  setStrava(s) { this.set("liftlog_strava", s); },
  config() { return this.get("liftlog_config", { clientId: "", workerUrl: "" }); },
  setConfig(c) { this.set("liftlog_config", c); }
};

//////////////////////// UTIL ////////////////////////

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function fmtDuration(sec) {
  const m = Math.round(sec / 60);
  if (m < 60) return m + " min";
  const h = Math.floor(m / 60);
  return h + "h " + (m % 60) + "m";
}

// Naive local ISO timestamp (no timezone conversion) - what Strava's
// start_date_local field expects.
function toLocalISOString(date) {
  const pad = n => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T` +
         `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}Z`;
}

let toastTimer = null;
function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
}

//////////////////////// APP STATE ////////////////////////

let currentTab = "log";
const app = document.getElementById("app");
const titles = { log: "LiftLog", history: "History", settings: "Settings" };

document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  document.getElementById("topbar-title").textContent = titles[tab];
  render();
}

function render() {
  if (currentTab === "log") renderLog();
  else if (currentTab === "history") renderHistory();
  else if (currentTab === "settings") renderSettings();
}

//////////////////////// LOG TAB ////////////////////////

function renderLog() {
  const w = Store.active();
  if (!w) {
    app.innerHTML = `
      <div class="empty-state">
        <div class="big">&#127997;&#65039;&#8205;&#9794;&#65039;</div>
        <p class="muted">No workout in progress</p>
      </div>
      <button class="btn btn-primary" id="start-workout">Start Workout</button>
    `;
    document.getElementById("start-workout").addEventListener("click", startWorkout);
    return;
  }

  const exList = Store.exercises();
  let html = `<div class="card">
    <div class="timer" id="elapsed-timer">--:--</div>
    <p class="muted" style="text-align:center;margin:0 0 10px">Started ${fmtTime(w.start)}</p>
    <button class="btn btn-primary" id="finish-workout">Finish Workout</button>
  </div>`;

  w.entries.forEach((entry, ei) => {
    html += `<div class="card exercise-card" data-ei="${ei}">
      <h3>${escapeHtml(entry.exercise)}
        <button class="set-remove" data-action="remove-exercise" data-ei="${ei}">&times;</button>
      </h3>`;
    entry.sets.forEach((s, si) => {
      html += `<div class="set-row">
        <span class="set-num">${si + 1}</span>
        <input type="number" inputmode="decimal" placeholder="lbs" value="${s.weight ?? ""}" data-action="set-weight" data-ei="${ei}" data-si="${si}">
        <span class="muted">&times;</span>
        <input type="number" inputmode="numeric" placeholder="reps" value="${s.reps ?? ""}" data-action="set-reps" data-ei="${ei}" data-si="${si}">
        <button class="set-remove" data-action="remove-set" data-ei="${ei}" data-si="${si}">&times;</button>
      </div>`;
    });
    html += `<button class="add-set-btn" data-action="add-set" data-ei="${ei}">+ Add Set</button>
    </div>`;
  });

  html += `<div class="card">
    <label>Add Exercise</label>
    <div class="row">
      <input list="exercise-list" id="new-exercise" placeholder="e.g. Bench Press">
      <button class="btn btn-secondary btn-small" id="add-exercise" style="flex:0 0 auto">Add</button>
    </div>
    <datalist id="exercise-list">
      ${exList.map(x => `<option value="${escapeHtml(x)}">`).join("")}
    </datalist>
  </div>`;

  app.innerHTML = html;

  document.getElementById("finish-workout").addEventListener("click", openFinishModal);
  document.getElementById("add-exercise").addEventListener("click", () => {
    const input = document.getElementById("new-exercise");
    const name = input.value.trim();
    if (!name) return;
    const list = Store.exercises();
    if (!list.includes(name)) { list.push(name); Store.setExercises(list); }
    const w2 = Store.active();
    w2.entries.push({ exercise: name, sets: [{ weight: "", reps: "" }] });
    Store.setActive(w2);
    render();
  });

  app.querySelectorAll("[data-action]").forEach(el => {
    el.addEventListener(el.tagName === "INPUT" ? "input" : "click", handleLogAction);
  });

  startTimer(w.start);
}

function handleLogAction(e) {
  const el = e.currentTarget;
  const action = el.dataset.action;
  const w = Store.active();
  const ei = parseInt(el.dataset.ei);
  const si = el.dataset.si !== undefined ? parseInt(el.dataset.si) : null;

  if (action === "remove-exercise") {
    w.entries.splice(ei, 1);
  } else if (action === "add-set") {
    w.entries[ei].sets.push({ weight: "", reps: "" });
  } else if (action === "remove-set") {
    w.entries[ei].sets.splice(si, 1);
    if (w.entries[ei].sets.length === 0) w.entries.splice(ei, 1);
  } else if (action === "set-weight") {
    w.entries[ei].sets[si].weight = el.value;
    Store.setActive(w);
    return; // no full re-render needed while typing
  } else if (action === "set-reps") {
    w.entries[ei].sets[si].reps = el.value;
    Store.setActive(w);
    return;
  }
  Store.setActive(w);
  render();
}

function startWorkout() {
  Store.setActive({ id: uid(), start: new Date().toISOString(), entries: [] });
  render();
}

let timerInterval = null;
function startTimer(startIso) {
  clearInterval(timerInterval);
  const el = document.getElementById("elapsed-timer");
  const start = new Date(startIso).getTime();
  function tick() {
    if (!document.getElementById("elapsed-timer")) { clearInterval(timerInterval); return; }
    const sec = Math.floor((Date.now() - start) / 1000);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const pad = n => String(n).padStart(2, "0");
    document.getElementById("elapsed-timer").textContent = h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }
  tick();
  timerInterval = setInterval(tick, 1000);
}

function openFinishModal() {
  const w = Store.active();
  const cleanEntries = w.entries
    .map(e => ({ exercise: e.exercise, sets: e.sets.filter(s => s.weight !== "" || s.reps !== "") }))
    .filter(e => e.sets.length > 0);

  if (cleanEntries.length === 0) {
    if (!confirm("No sets logged. Discard this workout?")) return;
    clearInterval(timerInterval);
    Store.setActive(null);
    render();
    return;
  }

  const summary = cleanEntries.map(e =>
    `${e.exercise}: ` + e.sets.map(s => `${s.weight || 0}x${s.reps || 0}`).join(", ")
  ).join("\n");

  const defaultName = "Weight Training - " + fmtDate(w.start);
  const strava = Store.strava();

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal-sheet">
      <h2>Finish Workout</h2>
      <div class="field">
        <label>Title</label>
        <input id="finish-name" value="${escapeHtml(defaultName)}">
      </div>
      <div class="field">
        <label>Summary</label>
        <textarea id="finish-notes">${escapeHtml(summary)}</textarea>
      </div>
      ${strava ? `
      <div class="field">
        <label style="display:flex;align-items:center;gap:8px;text-transform:none;font-size:14px;">
          <input type="checkbox" id="finish-strava" checked style="width:auto"> Send to Strava
        </label>
      </div>` : `<p class="muted">Connect Strava in Settings to auto-post this workout.</p>`}
      <div class="row" style="margin-top:16px">
        <button class="btn btn-secondary" id="finish-cancel">Cancel</button>
        <button class="btn btn-primary" id="finish-save">Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  document.getElementById("finish-cancel").addEventListener("click", () => overlay.remove());
  document.getElementById("finish-save").addEventListener("click", async () => {
    const saveBtn = document.getElementById("finish-save");
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving...";

    const end = new Date().toISOString();
    const name = document.getElementById("finish-name").value.trim() || defaultName;
    const notes = document.getElementById("finish-notes").value;
    const wantStrava = strava && document.getElementById("finish-strava") && document.getElementById("finish-strava").checked;

    const record = {
      id: w.id, start: w.start, end, entries: cleanEntries, name, notes, stravaId: null
    };

    const hist = Store.history();
    hist.unshift(record);
    Store.setHistory(hist);
    clearInterval(timerInterval);
    Store.setActive(null);

    if (wantStrava) {
      try {
        const activity = await pushToStrava(record);
        record.stravaId = activity.id;
        const h2 = Store.history();
        h2[0] = record;
        Store.setHistory(h2);
        toast("Saved & sent to Strava");
      } catch (err) {
        console.error(err);
        toast("Saved locally (Strava sync failed)");
      }
    } else {
      toast("Workout saved");
    }

    overlay.remove();
    render();
  });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

//////////////////////// HISTORY TAB ////////////////////////

function renderHistory() {
  const hist = Store.history();
  if (hist.length === 0) {
    app.innerHTML = `<div class="empty-state"><div class="big">&#128203;</div><p class="muted">No workouts logged yet</p></div>`;
    return;
  }
  let html = `<div class="card">`;
  hist.forEach(w => {
    const durSec = (new Date(w.end) - new Date(w.start)) / 1000;
    html += `<div class="history-item">
      <div class="history-head">
        <span class="date">${escapeHtml(w.name || fmtDate(w.start))}</span>
        <span class="meta">${fmtDate(w.start)} &middot; ${fmtDuration(durSec)}</span>
      </div>
      ${w.entries.map(e => `<div class="exercise-summary"><b>${escapeHtml(e.exercise)}</b>: ${e.sets.map(s => `${s.weight || 0}&times;${s.reps || 0}`).join(", ")}</div>`).join("")}
      ${w.stravaId ? `<span class="badge" style="margin-top:6px">&#10003; Synced to Strava</span>` : ""}
    </div>`;
  });
  html += `</div>`;
  app.innerHTML = html;
}

//////////////////////// SETTINGS TAB ////////////////////////

function renderSettings() {
  const cfg = Store.config();
  const strava = Store.strava();

  app.innerHTML = `
    <div class="section-title">Strava</div>
    <div class="card">
      <div class="strava-status">
        <span class="strava-dot ${strava ? "connected" : ""}"></span>
        <span>${strava ? `Connected as ${escapeHtml(strava.athlete?.firstname || "athlete")}` : "Not connected"}</span>
      </div>
      ${!strava ? `
        <div class="field">
          <label>Strava Client ID</label>
          <input id="cfg-client-id" value="${escapeHtml(cfg.clientId)}" placeholder="12345" inputmode="numeric">
        </div>
        <div class="field">
          <label>Proxy Worker URL</label>
          <input id="cfg-worker-url" value="${escapeHtml(cfg.workerUrl)}" placeholder="https://your-worker.workers.dev">
        </div>
        <button class="btn btn-primary" id="connect-strava">Connect to Strava</button>
        <p class="muted" style="margin-top:10px">See SETUP.md for how to get these values.</p>
      ` : `
        <button class="btn btn-danger" id="disconnect-strava">Disconnect</button>
      `}
    </div>

    <div class="section-title">Exercises</div>
    <div class="card">
      <div class="chip-row" id="exercise-chips">
        ${Store.exercises().map(x => `<span class="chip" data-x="${escapeHtml(x)}">${escapeHtml(x)} &times;</span>`).join("")}
      </div>
      <div class="row">
        <input id="new-ex-name" placeholder="New exercise name">
        <button class="btn btn-secondary btn-small" id="add-ex-btn" style="flex:0 0 auto">Add</button>
      </div>
    </div>

    <div class="section-title">Data</div>
    <div class="card">
      <button class="btn btn-secondary" id="export-data">Export Workout History (JSON)</button>
    </div>
  `;

  if (!strava) {
    document.getElementById("connect-strava").addEventListener("click", () => {
      const clientId = document.getElementById("cfg-client-id").value.trim();
      const workerUrl = document.getElementById("cfg-worker-url").value.trim().replace(/\/$/, "");
      if (!clientId || !workerUrl) { toast("Enter Client ID and Worker URL first"); return; }
      Store.setConfig({ clientId, workerUrl });
      const redirectUri = window.location.origin + window.location.pathname;
      const url = `https://www.strava.com/oauth/authorize?client_id=${encodeURIComponent(clientId)}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&approval_prompt=auto` +
        `&scope=activity:write,activity:read_all`;
      window.location.href = url;
    });
  } else {
    document.getElementById("disconnect-strava").addEventListener("click", () => {
      Store.setStrava(null);
      toast("Disconnected");
      render();
    });
  }

  document.getElementById("add-ex-btn").addEventListener("click", () => {
    const input = document.getElementById("new-ex-name");
    const name = input.value.trim();
    if (!name) return;
    const list = Store.exercises();
    if (!list.includes(name)) { list.push(name); Store.setExercises(list); }
    render();
  });

  document.querySelectorAll("#exercise-chips .chip").forEach(chip => {
    chip.addEventListener("click", () => {
      const list = Store.exercises().filter(x => x !== chip.dataset.x);
      Store.setExercises(list);
      render();
    });
  });

  document.getElementById("export-data").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(Store.history(), null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "liftlog-history.json";
    a.click();
  });
}

//////////////////////// STRAVA ////////////////////////

async function pushToStrava(record) {
  let strava = Store.strava();
  const cfg = Store.config();
  if (!strava || !cfg.workerUrl) throw new Error("Strava not connected");

  // Refresh token if it's expired or about to expire.
  if (!strava.expires_at || strava.expires_at < Math.floor(Date.now() / 1000) + 60) {
    strava = await refreshStravaToken();
  }

  const start = new Date(record.start);
  const elapsed = Math.max(60, Math.round((new Date(record.end) - start) / 1000));

  const res = await fetch(cfg.workerUrl + "/activity", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      access_token: strava.access_token,
      name: record.name,
      sport_type: "WeightTraining",
      start_date_local: toLocalISOString(start),
      elapsed_time: elapsed,
      description: record.notes
    })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error("Strava activity create failed: " + text);
  }
  return res.json();
}

async function refreshStravaToken() {
  const strava = Store.strava();
  const cfg = Store.config();
  const res = await fetch(cfg.workerUrl + "/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: strava.refresh_token })
  });
  if (!res.ok) throw new Error("Token refresh failed");
  const data = await res.json();
  const updated = { ...strava, access_token: data.access_token, refresh_token: data.refresh_token, expires_at: data.expires_at };
  Store.setStrava(updated);
  return updated;
}

async function completeOAuth(code) {
  const cfg = Store.config();
  if (!cfg.workerUrl) { toast("Missing worker URL - reconnect in Settings"); return; }
  try {
    const res = await fetch(cfg.workerUrl + "/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, client_id: cfg.clientId })
    });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    Store.setStrava({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: data.expires_at,
      athlete: data.athlete
    });
    toast("Connected to Strava");
  } catch (err) {
    console.error(err);
    toast("Strava connection failed");
  }
  switchTab("settings");
}

//////////////////////// INIT ////////////////////////

(function init() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  if (code) {
    window.history.replaceState({}, "", window.location.pathname);
    completeOAuth(code);
  } else {
    render();
  }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
