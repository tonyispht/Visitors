import { DurableObject } from "cloudflare:workers";
import DASH_HTML from "./dash.html";

const SITE_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/i;
const SESSION_GAP = 30 * 60 * 1000; // same visitor returning within 30 min = same visit
const KEEP_VISITS = 200; // rows of history kept per site
const MAX_SOCKETS = 400; // hard cap per site
const MAX_SITES = 100; // sites the private dashboard will list
const KEEP_ACTIVITY = 150; // cross-site activity rows kept for the dashboard

const clean = (s, n) => String(s ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, n);

/** Optional soft lock: only these hostnames (and subdomains) may connect. Empty = allow all. */
function originAllowed(request, env, selfHost) {
  const list = (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!list.length) return true;
  const origin = request.headers.get("Origin");
  if (!origin) return false;
  let host;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === selfHost) return true; // the generator page itself
  return list.some((a) => host === a || host.endsWith("." + a));
}

/** Constant-time check of the private dashboard key (compares SHA-256 digests). */
async function keyOk(given, secret) {
  if (!secret || !given) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(secret)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

/** The dashboard sends its key as a WebSocket subprotocol ("k-" + base64url of the key) so it never lands in URLs/logs. */
function keyFromProtocol(request) {
  const tok = (request.headers.get("Sec-WebSocket-Protocol") || "")
    .split(",")
    .map((s) => s.trim())
    .find((s) => s.startsWith("k-"));
  if (!tok) return "";
  try {
    const bin = atob(tok.slice(2).replace(/-/g, "+").replace(/_/g, "/"));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return "";
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    /* ---------- private all-sites dashboard ---------- */
    if (url.pathname === "/dash") {
      return new Response(DASH_HTML, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-robots-tag": "noindex, nofollow",
        },
      });
    }
    if (url.pathname === "/dash/auth" && request.method === "POST") {
      const given = (await request.text()).slice(0, 200);
      return new Response(null, { status: (await keyOk(given, env.DASH_KEY)) ? 204 : 401, headers: { "cache-control": "no-store" } });
    }
    if (url.pathname === "/dash/ws") {
      if (!env.DASH_KEY) return new Response("Dashboard not configured", { status: 503 });
      if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
      if (!(await keyOk(keyFromProtocol(request), env.DASH_KEY))) return new Response("Unauthorized", { status: 401 });
      return env.REGISTRY.getByName("main").fetch(request);
    }

    /* ---------- public tracking endpoints ---------- */
    if (url.pathname === "/ws" || url.pathname === "/api/stats") {
      const site = url.searchParams.get("site") || "";
      if (!SITE_RE.test(site)) return new Response("Bad site id", { status: 400 });
      if (!originAllowed(request, env, url.hostname)) return new Response("Forbidden", { status: 403 });
      const stub = env.HUB.getByName(site.toLowerCase());

      if (url.pathname === "/ws") {
        if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
        return stub.fetch(request);
      }

      const stats = await stub.stats();
      return Response.json(stats, {
        headers: {
          "access-control-allow-origin": request.headers.get("Origin") || "*",
          "cache-control": "no-store",
        },
      });
    }

    return env.ASSETS.fetch(request);
  },
};

/** One Hub per site ID: counts visitors, keeps history, pushes live events to that site's widgets. */
export class Hub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const sql = ctx.storage.sql;
      sql.exec(`CREATE TABLE IF NOT EXISTS visits (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
        country TEXT, city TEXT, region TEXT, page TEXT, ref TEXT, device TEXT)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, last_seen INTEGER NOT NULL)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)`);
    });
    // Keeps the heartbeat from waking the object (cheap).
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    this.site = ctx.storage.kv.get("site") || ""; // remembered so leave events can name the site
    this.regName = "";
    this.regAt = 0;
  }

  /* ---------- helpers ---------- */
  total() {
    const r = this.ctx.storage.sql.exec("SELECT v FROM meta WHERE k = 'total'").toArray()[0];
    return r ? r.v : 0;
  }

  onlineSet(exclude) {
    const s = new Set();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exclude) continue;
      try {
        const a = ws.deserializeAttachment();
        if (a && !a.obs && a.sid) s.add(a.sid);
      } catch {}
    }
    return s;
  }

  recent(n) {
    return this.ctx.storage.sql
      .exec("SELECT id, ts, country, city, region, page, ref, device FROM visits ORDER BY id DESC LIMIT ?", n)
      .toArray();
  }

  broadcast(msg, except) {
    const data = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try {
        ws.send(data);
      } catch {}
    }
  }

  /** Tell the private dashboard what happened here. Never breaks or noticeably delays a visitor. */
  async notify(msg) {
    if (!this.site || !this.env.REGISTRY) return;
    try {
      await Promise.race([
        this.env.REGISTRY.getByName("main").event(this.site, msg),
        new Promise((resolve) => setTimeout(resolve, 1500)),
      ]);
    } catch {}
  }

  /* ---------- RPC ---------- */
  async stats() {
    return { online: this.onlineSet().size, total: this.total() };
  }

  /* ---------- WebSocket upgrade ---------- */
  async fetch(request) {
    if (this.ctx.getWebSockets().length >= MAX_SOCKETS) return new Response("Busy", { status: 503 });

    const url = new URL(request.url);
    const cf = request.cf || {};
    const obs = url.searchParams.get("obs") === "1"; // observer: watches, never counted
    const sid = clean(url.searchParams.get("sid"), 40) || crypto.randomUUID();
    const now = Date.now();
    const sql = this.ctx.storage.sql;
    const wasOnline = !obs && this.onlineSet().has(sid);

    const site = clean(url.searchParams.get("site"), 48).toLowerCase();
    if (site && site !== this.site) {
      this.site = site;
      this.ctx.storage.kv.put("site", site);
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ sid, obs });

    let joined = null;
    if (!obs) {
      const row = sql.exec("SELECT last_seen FROM sessions WHERE sid = ?", sid).toArray()[0];
      const fresh = !row || now - row.last_seen > SESSION_GAP;
      sql.exec(
        "INSERT INTO sessions (sid, last_seen) VALUES (?, ?) ON CONFLICT(sid) DO UPDATE SET last_seen = excluded.last_seen",
        sid,
        now,
      );
      if (fresh) {
        const v = {
          country: clean(cf.country, 2).toUpperCase(),
          city: clean(cf.city, 60),
          region: clean(cf.region, 60),
          page: clean(url.searchParams.get("page"), 80),
          ref: clean(url.searchParams.get("ref"), 100),
          device: pickDevice(url.searchParams.get("dev")),
        };
        sql.exec("INSERT INTO meta (k, v) VALUES ('total', 1) ON CONFLICT(k) DO UPDATE SET v = v + 1");
        const id = sql
          .exec(
            "INSERT INTO visits (ts, country, city, region, page, ref, device) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
            now, v.country, v.city, v.region, v.page, v.ref, v.device,
          )
          .one().id;
        sql.exec("DELETE FROM visits WHERE id <= ?", id - KEEP_VISITS);
        sql.exec("DELETE FROM sessions WHERE last_seen < ?", now - 24 * 3600 * 1000);
        joined = { id, ts: now, ...v };
      }
    }

    const online = this.onlineSet().size;
    const total = this.total();
    if (joined) this.broadcast({ type: "join", v: joined, online, total }, server);
    else if (!obs && !wasOnline) this.broadcast({ type: "count", online, total }, server);

    server.send(JSON.stringify({ type: "hello", online, total, recent: this.recent(20) }));

    // Mirror the event to the private all-sites dashboard (also registers the site the first time it is seen).
    const name = clean(url.searchParams.get("page"), 80);
    let note = null;
    if (joined) note = { type: "join", v: joined, online, total };
    else if (!obs && !wasOnline) note = { type: "count", online, total };
    else if (name && (name !== this.regName || now - this.regAt > 6 * 3600 * 1000)) note = { type: "seen", online, total };
    if (note) {
      this.regName = name;
      this.regAt = now;
      await this.notify({ ...note, name });
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage() {
    /* "ping" is answered automatically; nothing else is expected from clients */
  }

  async webSocketClose(ws) {
    try {
      ws.close(1000, "bye");
    } catch {}
    await this.afterLeave(ws);
  }

  async webSocketError(ws) {
    await this.afterLeave(ws);
  }

  async afterLeave(ws) {
    let a;
    try {
      a = ws.deserializeAttachment();
    } catch {}
    if (!a || a.obs) return;
    const still = this.onlineSet(ws);
    if (still.has(a.sid)) return; // another tab of the same visitor is open
    this.ctx.storage.sql.exec("UPDATE sessions SET last_seen = ? WHERE sid = ?", Date.now(), a.sid);
    const total = this.total();
    this.broadcast({ type: "leave", online: still.size, total }, ws);
    await this.notify({ type: "leave", online: still.size, total, name: this.regName });
  }
}

/** One Registry for the whole account: remembers every site that has reported in and fans live events out to the private dashboard. */
export class Registry extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const sql = ctx.storage.sql;
      sql.exec(`CREATE TABLE IF NOT EXISTS sites (
        site TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
        last_visit INTEGER, online INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS activity (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, site TEXT NOT NULL,
        country TEXT, city TEXT, region TEXT, page TEXT, ref TEXT, device TEXT)`);
    });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {}
    }
  }

  recentActivity(n) {
    return this.ctx.storage.sql
      .exec("SELECT id, ts, site, country, city, region, page, ref, device FROM activity ORDER BY id DESC LIMIT ?", n)
      .toArray();
  }

  /** All sites, optionally re-reading live counts from each Hub so nothing drifts. */
  async snapshot(refresh) {
    const sql = this.ctx.storage.sql;
    if (refresh) {
      const rows = sql.exec("SELECT site FROM sites").toArray();
      await Promise.allSettled(
        rows.map(async ({ site }) => {
          const s = await this.env.HUB.getByName(site).stats();
          sql.exec("UPDATE sites SET online = ?, total = ? WHERE site = ?", s.online, s.total, site);
        }),
      );
    }
    return sql.exec("SELECT * FROM sites").toArray();
  }

  /* ---------- RPC from the Hubs ---------- */
  async event(site, msg) {
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    site = clean(site, 48).toLowerCase();
    if (!SITE_RE.test(site) || !msg) return;
    const name = clean(msg.name, 80);

    const known = sql.exec("SELECT 1 FROM sites WHERE site = ?", site).toArray().length > 0;
    if (!known) {
      if (sql.exec("SELECT COUNT(*) AS c FROM sites").one().c >= MAX_SITES) return;
      sql.exec("INSERT INTO sites (site, name, first_seen, last_seen) VALUES (?, ?, ?, ?)", site, name, now, now);
    }
    sql.exec(
      "UPDATE sites SET last_seen = ?, online = ?, total = ?, name = CASE WHEN ? != '' THEN ? ELSE name END WHERE site = ?",
      now, msg.online | 0, msg.total | 0, name, name, site,
    );

    let v = null;
    if (msg.type === "join" && msg.v) {
      const j = msg.v;
      const ts = Number(j.ts) || now;
      const id = sql
        .exec(
          "INSERT INTO activity (ts, site, country, city, region, page, ref, device) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
          ts, site, clean(j.country, 2), clean(j.city, 60), clean(j.region, 60), clean(j.page, 80), clean(j.ref, 100), clean(j.device, 10),
        )
        .one().id;
      sql.exec("DELETE FROM activity WHERE id <= ?", id - KEEP_ACTIVITY);
      sql.exec("UPDATE sites SET last_visit = ? WHERE site = ?", ts, site);
      v = sql.exec("SELECT id, ts, site, country, city, region, page, ref, device FROM activity WHERE id = ?", id).one();
    }

    const row = sql.exec("SELECT * FROM sites WHERE site = ?", site).one();
    this.broadcast({ type: "site", kind: msg.type, site: row, v });
  }

  /* ---------- dashboard WebSocket ---------- */
  async fetch() {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ type: "hello", sites: await this.snapshot(true), recent: this.recentActivity(40), now: Date.now() }));
    return new Response(null, { status: 101, webSocket: client, headers: { "Sec-WebSocket-Protocol": "visitors-dash" } });
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== "string") return;
    let m;
    try {
      m = JSON.parse(message);
    } catch {
      return;
    }
    const sql = this.ctx.storage.sql;
    if (m.t === "refresh") {
      ws.send(JSON.stringify({ type: "sites", sites: await this.snapshot(true), now: Date.now() }));
    } else if (m.t === "forget" && typeof m.site === "string") {
      const site = clean(m.site, 48).toLowerCase();
      sql.exec("DELETE FROM sites WHERE site = ?", site);
      sql.exec("DELETE FROM activity WHERE site = ?", site);
      this.broadcast({ type: "forgot", site });
    } else if (m.t === "add" && typeof m.site === "string") {
      const site = clean(m.site, 48).toLowerCase();
      if (!SITE_RE.test(site)) return;
      const s = await this.env.HUB.getByName(site).stats();
      await this.event(site, { type: "seen", online: s.online, total: s.total, name: "" });
    }
  }

  async webSocketClose(ws) {
    try {
      ws.close(1000, "bye");
    } catch {}
  }

  async webSocketError() {}
}

function pickDevice(v) {
  return ["desktop", "mobile", "tablet"].includes(v) ? v : "desktop";
}
