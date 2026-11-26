/*! Visitors widget — personal real-time visitor counter, feed & sound */
(() => {
  "use strict";
  if (window.__visitorsWidget) return;
  const script = document.currentScript;
  if (!script) { console.warn("[visitors] load widget.js with a <script> tag"); return; }
  window.__visitorsWidget = true;

  /* ---------- helpers ---------- */
  const d = script.dataset;
  const bool = (v, def) => (v == null || v === "" ? def : !/^(0|false|off|no)$/i.test(v));
  const num = (v, def, lo, hi) => { const n = parseFloat(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; };
  const pick = (v, list, def) => (list.includes(v) ? v : def);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };

  // Owner mode: open any page of yours once with ?visitors=owner  (undo with ?visitors=forget)
  try {
    const q = new URLSearchParams(location.search).get("visitors");
    if (q === "owner") store.set("visitors:owner", "1");
    if (q === "forget") store.del("visitors:owner");
  } catch {}
  const isOwner = store.get("visitors:owner") === "1";

  /* ---------- sounds (synthesized, no files) ---------- */
  const SOUNDS = {
    chime: (p) => { p(880, 0, 0.55, "sine", 0.5); p(1318.5, 0.13, 0.8, "sine", 0.4); },
    ding:  (p) => { p(659.3, 0, 0.35, "sine", 0.5); p(523.3, 0.3, 0.8, "sine", 0.5); },
    bell:  (p) => { p(1046.5, 0, 1.1, "sine", 0.45); p(2093, 0, 0.6, "sine", 0.15); p(1568, 0.18, 1, "sine", 0.3); },
    coin:  (p) => { p(987.8, 0, 0.09, "square", 0.18); p(1318.5, 0.09, 0.45, "square", 0.18); },
    blip:  (p) => { p(520, 0, 0.14, "triangle", 0.6, 980); },
    pop:   (p) => { p(520, 0, 0.16, "sine", 0.8, 110); },
  };

  /* ---------- config ---------- */
  const cfg = {
    site: /^[a-z0-9][a-z0-9_-]{0,47}$/i.test(d.site || "") ? d.site : "default",
    server: (d.server || new URL(script.src, location.href).origin).replace(/\/+$/, ""),
    name: (d.name || document.title || location.hostname || "page").slice(0, 80),
    position: pick(d.position, ["bottom-right", "bottom-left", "top-right", "top-left"], "bottom-right"),
    theme: pick(d.theme, ["neon", "dark", "light", "glass"], "neon"),
    accent: /^#[0-9a-f]{3,8}$/i.test(d.accent || "") ? d.accent : "#00e5ff",
    panel: pick(d.panel, ["collapsed", "open", "hidden"], "collapsed"),
    show: pick(d.show, ["both", "online", "total", "none"], "both"),
    feed: Math.round(num(d.feed, 6, 1, 20)),
    label: (d.label || "Visitors").slice(0, 30),
    sound: bool(d.sound, true),
    soundType: pick(d.soundType, Object.keys(SOUNDS), "chime"),
    volume: num(d.volume, 0.5, 0, 1),
    leaveSound: bool(d.leaveSound, false),
    showTo: pick(d.showTo, ["everyone", "owner"], "everyone"),
    observer: d.observer != null && bool(d.observer, true), // watch without being counted
  };
  const visible = cfg.showTo === "everyone" || isOwner;
  const observer = cfg.observer || isOwner; // you are never counted as a visitor

  /* ---------- audio ---------- */
  let ctx = null, master = null;
  let muted = !visible || (store.get("visitors:mute") !== null ? store.get("visitors:mute") === "1" : !cfg.sound);
  let syncLock = () => {};
  const unlock = () => {
    try {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        ctx = new AC();
        master = ctx.createGain();
        master.gain.value = cfg.volume;
        master.connect(ctx.destination);
        ctx.onstatechange = () => syncLock();
      }
      if (ctx.state !== "running") ctx.resume().then(() => syncLock(), () => {});
      syncLock();
    } catch {}
  };
  const UNLOCK_EVENTS = ["pointerdown", "touchend", "keydown", "click"];
  UNLOCK_EVENTS.forEach((ev) => window.addEventListener(ev, unlock, { capture: true, passive: true }));

  const play = (name) => {
    if (muted || !ctx || ctx.state !== "running") return;
    const t0 = ctx.currentTime;
    SOUNDS[name]((freq, delay, dur, type, vol, slideTo) => {
      const o = ctx.createOscillator(), g = ctx.createGain(), t = t0 + delay;
      o.type = type;
      o.frequency.setValueAtTime(freq, t);
      if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(master);
      o.start(t);
      o.stop(t + dur + 0.05);
    });
  };
  const playLeave = () => {
    if (muted || !ctx || ctx.state !== "running") return;
    const t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(440, t);
    o.frequency.exponentialRampToValueAtTime(220, t + 0.25);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + 0.35);
  };

  /* ---------- identity ---------- */
  const rnd = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, "").slice(0, 24) : Math.random().toString(36).slice(2) + Date.now().toString(36));
  const sidKey = "visitors:sid:" + cfg.site;
  let sid = store.get(sidKey);
  if (!sid) { sid = rnd(); store.set(sidKey, sid); }
  const ua = navigator.userAgent || "";
  const dev = /iPad|Tablet|Android(?!.*Mobi)/i.test(ua) ? "tablet" : /Mobi|iPhone|Android/i.test(ua) ? "mobile" : "desktop";
  let refHost = "";
  try { if (document.referrer) { const h = new URL(document.referrer).hostname; if (h !== location.hostname) refHost = h; } } catch {}

  /* ---------- UI ---------- */
  const css = `
:host{all:initial}
*{box-sizing:border-box}
.wrap{position:fixed;z-index:2147483000;display:flex;gap:8px;pointer-events:none;
  font:13px/1.35 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--fg);--ac:${cfg.accent}}
.wrap.b{bottom:calc(12px + env(safe-area-inset-bottom,0px));flex-direction:column}
.wrap.t{top:calc(12px + env(safe-area-inset-top,0px));flex-direction:column-reverse}
.wrap.r{right:calc(12px + env(safe-area-inset-right,0px));align-items:flex-end}
.wrap.l{left:calc(12px + env(safe-area-inset-left,0px));align-items:flex-start}
.wrap[data-theme=neon]{--bg:rgba(8,10,22,.9);--fg:#e6f6ff;--mut:#7f93ad;--bd:color-mix(in srgb,var(--ac) 55%,transparent);--glow:color-mix(in srgb,var(--ac) 30%,transparent);--row:rgba(255,255,255,.04)}
.wrap[data-theme=dark]{--bg:rgba(22,22,26,.94);--fg:#eee;--mut:#8b8b95;--bd:rgba(255,255,255,.14);--glow:transparent;--row:rgba(255,255,255,.05)}
.wrap[data-theme=light]{--bg:rgba(255,255,255,.96);--fg:#15171c;--mut:#6b7280;--bd:rgba(0,0,0,.14);--glow:transparent;--row:rgba(0,0,0,.04)}
.wrap[data-theme=glass]{--bg:rgba(255,255,255,.1);--fg:#fff;--mut:rgba(255,255,255,.65);--bd:rgba(255,255,255,.28);--glow:transparent;--row:rgba(255,255,255,.08)}
.panel{pointer-events:auto;width:min(320px,calc(100vw - 24px));max-height:min(60vh,430px);display:flex;flex-direction:column;
  background:var(--bg);border:1px solid var(--bd);border-radius:14px;overflow:hidden;
  box-shadow:0 10px 34px rgba(0,0,0,.4),0 0 22px var(--glow);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);
  transition:opacity .2s,transform .2s,visibility .2s}
.panel.closed{opacity:0;transform:translateY(8px) scale(.97);visibility:hidden;pointer-events:none}
.t .panel.closed{transform:translateY(-8px) scale(.97)}
header{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--bd)}
header strong{font-size:13px;letter-spacing:.04em;text-transform:uppercase}
.sp{flex:1}
button{font:inherit;color:inherit;cursor:pointer}
header button{background:none;border:0;padding:2px 6px;border-radius:6px;opacity:.75;font-size:14px}
header button:hover{opacity:1;background:var(--row)}
.dot{width:8px;height:8px;border-radius:50%;background:#777;flex:none}
.live .dot{background:#3ddc84;box-shadow:0 0 8px #3ddc84}
.stats{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--bd)}
.stats div{background:var(--bg);padding:10px 12px;display:flex;flex-direction:column}
.stats b{font-size:24px;line-height:1.1;color:var(--ac);font-variant-numeric:tabular-nums}
.stats span{color:var(--mut);font-size:11px;text-transform:uppercase;letter-spacing:.06em}
.pop{animation:pop .45s}
@keyframes pop{40%{transform:scale(1.25)}}
.feed{list-style:none;margin:0;padding:6px;overflow-y:auto;flex:1}
.feed li{display:flex;gap:10px;align-items:center;padding:7px 8px;border-radius:9px;margin-bottom:4px;background:var(--row)}
.feed li.new{animation:slide .6s}
@keyframes slide{from{opacity:0;transform:translateX(14px);background:color-mix(in srgb,var(--ac) 35%,transparent)}}
.flag{font-size:22px;line-height:1;flex:none}
.l1{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.l2{color:var(--mut);font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.txt{min-width:0}
.empty{color:var(--mut);text-align:center;padding:16px 8px}
footer{padding:7px 12px;font-size:11px;color:var(--mut);border-top:1px solid var(--bd)}
.pill{pointer-events:auto;display:inline-flex;align-items:center;gap:8px;padding:7px 13px;border-radius:999px;
  background:var(--bg);border:1px solid var(--bd);box-shadow:0 4px 16px rgba(0,0,0,.35),0 0 14px var(--glow);
  -webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px)}
.pill:hover{border-color:var(--ac)}
.blink{animation:blink .9s}
@keyframes blink{0%{box-shadow:0 0 0 0 var(--ac)}100%{box-shadow:0 0 0 16px transparent}}
@media (max-width:480px){.pill{padding:5px 10px;font-size:12px}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}`;

  const host = document.createElement("div");
  host.setAttribute("data-visitors-widget", "");
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>${css}</style>
<div class="wrap">
  <section class="panel closed" role="log" aria-live="polite">
    <header><span class="dot"></span><strong class="title"></strong><span class="sp"></span>
      <button class="mute" type="button"></button><button class="x" type="button" title="Close">✕</button></header>
    <div class="stats"><div><b class="n-on">0</b><span>online now</span></div><div><b class="n-tot">0</b><span>total visits</span></div></div>
    <ul class="feed"></ul>
    <footer class="lock" hidden>🔈 Click or tap anywhere once to enable sound</footer>
  </section>
  <button class="pill" type="button" aria-expanded="false"><span class="dot"></span><span class="ptxt"></span></button>
</div>`;
  const $ = (s) => root.querySelector(s);
  const wrap = $(".wrap"), panel = $(".panel"), pill = $(".pill"), feedEl = $(".feed");
  const nOn = $(".n-on"), nTot = $(".n-tot"), muteBtn = $(".mute"), lockEl = $(".lock");
  const [vert, horiz] = cfg.position.split("-");
  wrap.classList.add(vert === "top" ? "t" : "b", horiz === "left" ? "l" : "r");
  wrap.dataset.theme = cfg.theme;
  $(".title").textContent = cfg.label;
  if (cfg.panel === "hidden" || !visible) host.style.display = "none";
  ["pointerdown", "mousedown", "touchstart", "click", "keydown"].forEach((ev) => wrap.addEventListener(ev, (e) => e.stopPropagation()));

  syncLock = () => { lockEl.hidden = muted || (ctx && ctx.state === "running"); };
  const drawMute = () => { muteBtn.textContent = muted ? "🔇" : "🔊"; muteBtn.title = muted ? "Sound off" : "Sound on"; syncLock(); };
  muteBtn.onclick = () => { muted = !muted; store.set("visitors:mute", muted ? "1" : "0"); unlock(); drawMute(); };
  drawMute();

  const setOpen = (open) => { panel.classList.toggle("closed", !open); pill.setAttribute("aria-expanded", String(open)); };
  pill.onclick = () => setOpen(panel.classList.contains("closed"));
  $(".x").onclick = () => setOpen(false);
  setOpen(cfg.panel === "open");

  /* ---------- data / rendering ---------- */
  let online = 0, total = 0, feed = [], live = false;
  let dn = null;
  try { dn = new Intl.DisplayNames(["en"], { type: "region" }); } catch {}
  const countryName = (cc) => { try { return (dn && cc && dn.of(cc)) || cc || ""; } catch { return cc || ""; } };
  const flag = (cc) => (/^[A-Z]{2}$/.test(cc || "") ? String.fromCodePoint(...[...cc].map((c) => 127397 + c.charCodeAt(0))) : "🌐");
  const icon = { desktop: "🖥", mobile: "📱", tablet: "📲" };
  const ago = (ts) => {
    const s = Math.max(0, ((Date.now() - ts) / 1000) | 0);
    if (s < 45) return "just now";
    if (s < 3600) return Math.round(s / 60) + "m ago";
    if (s < 86400) return Math.round(s / 3600) + "h ago";
    return Math.round(s / 86400) + "d ago";
  };
  const place = (v) => (v.city ? v.city + ", " + (v.country === "US" && v.region ? v.region : countryName(v.country)) : countryName(v.country) || "Somewhere on Earth");
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  const drawCounts = (bump) => {
    nOn.textContent = online.toLocaleString();
    nTot.textContent = total.toLocaleString();
    const parts = [];
    if (cfg.show === "both" || cfg.show === "online") parts.push(online.toLocaleString() + " online");
    if (cfg.show === "both" || cfg.show === "total") parts.push(total.toLocaleString() + " visits");
    $(".ptxt").textContent = parts.length ? parts.join(" · ") : cfg.label;
    wrap.classList.toggle("live", live);
    if (bump) for (const n of [nOn, nTot]) { n.classList.remove("pop"); void n.offsetWidth; n.classList.add("pop"); }
  };
  const drawFeed = (newId) => {
    feedEl.replaceChildren();
    if (!feed.length) { feedEl.append(el("li", "empty", "Waiting for visitors…")); return; }
    for (const v of feed.slice(0, cfg.feed)) {
      const li = el("li", v.id === newId ? "new" : "");
      const t = el("div", "txt");
      const bits = [v.page || "", v.ref ? "from " + v.ref : "", icon[v.device] || "", ago(v.ts)].filter(Boolean);
      t.append(el("div", "l1", place(v)), el("div", "l2", bits.join(" · ")));
      li.append(el("span", "flag", flag(v.country)), t);
      feedEl.append(li);
    }
  };
  const flash = () => { pill.classList.remove("blink"); void pill.offsetWidth; pill.classList.add("blink"); };

  const onJoin = (v, silent) => {
    feed.unshift(v);
    feed = feed.slice(0, 20);
    drawFeed(v.id);
    drawCounts(true);
    if (!silent) { flash(); play(cfg.soundType); }
  };

  const handle = (m) => {
    if (m.type === "hello") { online = m.online; total = m.total; feed = m.recent || []; drawCounts(false); drawFeed(); }
    else if (m.type === "join") { online = m.online; total = m.total; onJoin(m.v); }
    else if (m.type === "count") { online = m.online; total = m.total; drawCounts(true); }
    else if (m.type === "leave") { online = m.online; total = m.total; drawCounts(true); if (cfg.leaveSound) playLeave(); }
  };

  /* ---------- connection ---------- */
  let ws = null, hb = 0, retry = 0, dead = false, retryTimer = 0;
  const connect = () => {
    if (dead) return;
    const q = new URLSearchParams({ site: cfg.site, sid, page: cfg.name, ref: refHost, dev });
    if (observer) q.set("obs", "1");
    try { ws = new WebSocket(cfg.server.replace(/^http/, "ws") + "/ws?" + q); } catch { return; }
    ws.onopen = () => {
      retry = 0; live = true; drawCounts(false);
      clearInterval(hb);
      hb = setInterval(() => { if (ws && ws.readyState === 1) ws.send("ping"); }, 25000);
    };
    ws.onmessage = (e) => {
      if (e.data === "pong") return;
      try { handle(JSON.parse(e.data)); } catch {}
    };
    ws.onclose = () => {
      clearInterval(hb); live = false; drawCounts(false);
      if (!dead) retryTimer = setTimeout(connect, Math.min(30000, 1000 * 2 ** retry++) + Math.random() * 500);
    };
    ws.onerror = () => { try { ws.close(); } catch {} };
  };

  drawCounts(false);
  drawFeed();
  const tick = setInterval(() => drawFeed(), 30000);
  (document.body || document.documentElement).appendChild(host);
  connect();

  /* ---------- public API ---------- */
  window.Visitors = {
    open: () => setOpen(true),
    close: () => setOpen(false),
    toggle: () => setOpen(panel.classList.contains("closed")),
    mute: (v = true) => { muted = !!v; drawMute(); },
    /** fake visitor: plays the sound and animates the feed (does not touch real counts) */
    test: () => { unlock(); onJoin({ id: -Date.now(), ts: Date.now(), country: "JP", city: "Tokyo", region: "", page: cfg.name, ref: "", device: "mobile" }); },
    destroy: () => {
      dead = true; clearInterval(hb); clearInterval(tick); clearTimeout(retryTimer);
      try { ws && ws.close(); } catch {}
      UNLOCK_EVENTS.forEach((ev) => window.removeEventListener(ev, unlock, { capture: true }));
      host.remove(); delete window.__visitorsWidget; delete window.Visitors;
    },
  };
})();
