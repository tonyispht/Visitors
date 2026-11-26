import { DurableObject } from "cloudflare:workers";

const SITE_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/i;
const SESSION_GAP = 30 * 60 * 1000; // same visitor returning within 30 min = same visit
const KEEP_VISITS = 200; // rows of history kept per site
const MAX_SOCKETS = 400; // hard cap per site

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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

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
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage() {
    /* "ping" is answered automatically; nothing else is expected from clients */
  }

  async webSocketClose(ws) {
    try {
      ws.close(1000, "bye");
    } catch {}
    this.afterLeave(ws);
  }

  async webSocketError(ws) {
    this.afterLeave(ws);
  }

  afterLeave(ws) {
    let a;
    try {
      a = ws.deserializeAttachment();
    } catch {}
    if (!a || a.obs) return;
    const still = this.onlineSet(ws);
    if (still.has(a.sid)) return; // another tab of the same visitor is open
    this.ctx.storage.sql.exec("UPDATE sessions SET last_seen = ? WHERE sid = ?", Date.now(), a.sid);
    this.broadcast({ type: "leave", online: still.size, total: this.total() }, ws);
  }
}

function pickDevice(v) {
  return ["desktop", "mobile", "tablet"].includes(v) ? v : "desktop";
}
