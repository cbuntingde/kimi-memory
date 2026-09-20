// Memory Proxy — HTTP transport adapter for external agent frameworks
// (Claude Code, CodeBuddy, …). Ported from TencentDB-Agent-Memory's
// `MemoryProxy/` module (the third container in their deploy stack).
//
// The proxy is a thin Node `http` server that translates inbound
// POSTs into the same TOOL_DEFS handlers the stdio MCP server uses.
// Every call ultimately routes through the existing server.js logic,
// so the proxy inherits the same schema, validation, and error shape
// as the in-process server.
//
// Auth: `KIMI_MEMORY_PROXY_TOKEN` env var. When set, every request
// must carry `Authorization: Bearer <token>`. When unset the proxy
// still starts, but auth fails closed: `authenticate()` rejects every
// call, so every route except the `/healthz` + `/readyz` probes and
// the CORS preflight answers 401. `KIMI_MEMORY_PROXY_AUTH=off` turns
// that gate off (intended for dev only — see `proxyAuthBypass()`);
// that combination is refused on a non-loopback bind.
//
// Endpoint surface (kept minimal — the proxy is a transport, not a
// re-implementation of the tool surface):
//   POST /tools/<tool_name>     → call the named tool with JSON body
//   GET  /tools                  → list the tool names the proxy can call
//   GET  /healthz                 → liveness probe (always 200)
//   POST /shutdown (auth required) → graceful shutdown
//
// The proxy is bound to the loopback interface by default. Pass
// `--host 0.0.0.0` to expose it on the network — strongly discouraged
// outside of a trusted LAN. Non-loopback binds default to a read-only
// tool surface; the destructive set is opt-in via
// `KIMI_MEMORY_PROXY_ALLOW_TOOLS` (comma-separated). The operator
// deny-list `KIMI_MEMORY_PROXY_DENY_TOOLS` is separate: it applies on
// every bind, loopback included. See `nonLoopbackToolGuard()` for the
// exact sets.
//
// (Prior audit flag F-003 — a network bind with bearer auth alone was
// the network-wide admin path the audit called out.)

import http from 'node:http';
import { URL } from 'node:url';
import crypto from 'node:crypto';
import { makeServer } from '../server.js';
import { kimiHome, safeErrorMessage } from '../util.js';
import { closeDb, flushEmbeddings } from '../persist.js';

/**
 * Start the proxy HTTP server.
 *
 * The callable surface is whatever `makeServer()` (src/server.js)
 * registered: it returns `{ server, handlers }`, where `handlers` is a
 * `Map<tool_name, async fn>` that each domain module fills in as it
 * registers. `dispatchTool()` below resolves an inbound
 * `POST /tools/<name>` through that map and invokes the handler
 * directly — no JSON-RPC round trip, and no reach into the SDK's
 * private registration fields (`_registeredTools` / `_tools`), whose
 * shape has shifted across releases.
 */
export async function startProxy({
  host = '127.0.0.1',
  port = 7331,
  kimiHomeDir,
  pluginRootDir,
  authToken = null,
  logger = null,
} = {}) {
  const log =
    logger || ((...a) => process.stderr.write('[kimi-memory proxy] ' + a.join(' ') + '\n'));
  // Token lookup: trim the env-supplied token once at init so an
  // operator-supplied trailing space can't silently desync client and
  // server (constant-time comparison still rejects the mismatch, but
  // a clean cut makes the failure obvious).
  const token =
    authToken != null
      ? authToken.trim()
      : process.env.KIMI_MEMORY_PROXY_TOKEN
        ? process.env.KIMI_MEMORY_PROXY_TOKEN.trim()
        : null;
  // Auth bypass accepts the common truthy set so `KIMI_MEMORY_PROXY_AUTH=0`,
  // `=false`, `=no`, or `=off` all turn auth off — not just `=off`
  // literally.
  const bypass = proxyAuthBypass();
  // Refuse the dangerous combo: auth bypass on a non-loopback bind
  // exposes the entire MCP surface (read + write) to the network with
  // no authentication. The CLI flag --no-auth + --host 0.0.0.0 would
  // otherwise be a one-keystroke data-leak path.
  if (bypass && !isLoopbackHost(host)) {
    const msg = `kimi-memory proxy: refusing to start — KIMI_MEMORY_PROXY_AUTH=off with host=${host} would expose unauthenticated access. Use a loopback host or set KIMI_MEMORY_PROXY_TOKEN.`;
    log(msg);
    throw new Error(msg);
  }
  // KIMI_MEMORY_PROXY_REQUIRE_HTTPS gates non-loopback binds. The proxy
  // itself does not speak TLS (we're a stdio MCP transport translated to
  // plain HTTP), so "required" means the operator asserts a TLS
  // terminator — haproxy, nginx, Caddy — sits in front. Without that
  // terminator, bearer tokens flow cleartext and any attacker on the
  // same broadcast domain reads them.
  //
  //   unset (default) / anything unrecognised → refuse to start
  //   1 | on | true   → start; TLS is terminated upstream
  //   0 | off | false → start; explicit cleartext opt-out
  const requireHttps = (process.env.KIMI_MEMORY_PROXY_REQUIRE_HTTPS || '').toLowerCase().trim();
  const requireHttpsOn = requireHttps === '1' || requireHttps === 'on' || requireHttps === 'true';
  const requireHttpsOff =
    requireHttps === 'off' || requireHttps === '0' || requireHttps === 'false';
  const isLoopbackBind = isLoopbackHost(host);
  if (!isLoopbackBind && !requireHttpsOn && !requireHttpsOff) {
    const msg =
      `kimi-memory proxy: refusing to start — non-loopback bind host=${host} without TLS. ` +
      `Either place a TLS terminator in front of the proxy and set KIMI_MEMORY_PROXY_REQUIRE_HTTPS=1, ` +
      `or pass --host 127.0.0.1 (or any loopback address). ` +
      `To send bearer tokens in cleartext instead (NOT recommended), set KIMI_MEMORY_PROXY_REQUIRE_HTTPS=off.`;
    log(msg);
    throw new Error(msg);
  }

  const mcp = makeServer({
    kimiHomeDir: kimiHomeDir || kimiHome(),
    pluginRootDir: pluginRootDir || process.cwd(),
    logger: log,
  });

  // Lightweight request counter / lifecycle state.
  const state = {
    startedAt: new Date().toISOString(),
    requests: 0,
    lastRequestAt: null,
    authEnabled: !!token && !bypass,
    host,
    port,
  };

  // Bind the non-loopback guard to this server's actual host. Reads of
  // the host env var are a fallback only — startProxy() is the
  // authoritative source for the bind address.
  const guardToolName = (name) => nonLoopbackToolGuard(name, { host });

  function authenticate(req) {
    if (bypass) return { ok: true, bypass: true };
    if (!token) {
      return { ok: false, error: 'proxy auth token not configured (set KIMI_MEMORY_PROXY_TOKEN)' };
    }
    const auth = req.headers['authorization'] || '';
    // RFC 7235 makes the scheme token case-insensitive, so `Bearer`,
    // `bearer` and `BEARER` are all the same scheme.
    const parts = typeof auth === 'string' ? /^(\S+)\s+(.+)$/.exec(auth.trim()) : null;
    if (!parts || parts[1].toLowerCase() !== 'bearer') {
      return { ok: false, error: 'missing Authorization: Bearer <token>' };
    }
    const presented = parts[2].trim();
    // Constant-time comparison so an attacker on the same loopback
    // cannot recover the token byte-by-byte from response timing.
    // Compare fixed-size SHA-256 digests instead of the raw strings:
    // timingSafeEqual() throws on mismatched buffer lengths, so a raw
    // comparison would need a length short-circuit that leaks the
    // token's length before the constant-time step ever runs.
    const a = crypto.createHash('sha256').update(presented, 'utf8').digest();
    const b = crypto.createHash('sha256').update(token, 'utf8').digest();
    if (!crypto.timingSafeEqual(a, b)) {
      return { ok: false, error: 'invalid bearer token' };
    }
    return { ok: true };
  }

  async function readJson(req, limit = 1024 * 1024) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let total = 0;
      let done = false;
      const onClose = () => finish(new Error('request aborted before the body was received'));
      const onError = (err) => finish(err);
      const onEnd = () => finish(null);
      const onData = (c) => {
        if (done) return;
        total += c.length;
        if (total > limit) {
          chunks.length = 0;
          finish(new Error(`request body too large (>${limit} bytes)`));
          return;
        }
        chunks.push(c);
      };
      const finish = (err) => {
        if (done) return;
        done = true;
        // Detach every listener on all settle paths: a keep-alive socket
        // is reused, and a stale listener would fire against a later
        // request.
        req.removeListener('data', onData);
        req.removeListener('end', onEnd);
        req.removeListener('error', onError);
        req.removeListener('close', onClose);
        if (err) return reject(err);
        try {
          const body = Buffer.concat(chunks).toString('utf8');
          if (body.length === 0) {
            resolve({});
            return;
          }
          // Reject bodies nested deeper than the configured limit
          // BEFORE handing the string to JSON.parse. A pathological
          // body of `[[[[...]]]]` 10k levels deep otherwise hits V8's
          // call-stack limit inside the parser and either throws
          // `RangeError: Maximum call stack size exceeded` (older
          // Node) or crashes the request handler (newer Node). The
          // helper is exported (maxJsonDepth) so the behaviour can
          // be unit-tested without spinning up the HTTP server.
          const depthCheck = maxJsonDepth(body, 64);
          if (!depthCheck.ok) {
            reject(new Error(`request body too deep (${depthCheck.depth} nesting levels > 64)`));
            return;
          }
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      };
      req.on('data', onData);
      req.on('end', onEnd);
      req.on('error', onError);
      // A client that hangs up mid-body fires neither 'end' nor 'error';
      // without this the promise never settles and the handler leaks.
      req.on('close', onClose);
    });
  }

  async function dispatchTool(toolName, args) {
    // Refuse destructive tools on a non-loopback bind unless the
    // operator explicitly opted in via KIMI_MEMORY_PROXY_ALLOW_TOOLS.
    // A network bind with a single shared bearer token is a
    // network-wide admin path otherwise — the audit floor requires
    // this default-off shape. (Prior audit flag F-003.) The operator
    // deny-list is checked inside the same call and applies on every
    // bind, loopback included.
    const deny = guardToolName(toolName);
    if (deny) {
      const err = new Error(deny);
      err.code = 'tool_not_allowed';
      throw err;
    }
    // The orchestrator (src/server.js) populates `mcp.handlers` with
    // every tool's wrapped handler at startup. The Map<name, fn>
    // shape is owned by us, not the SDK, so this code no longer
    // depends on the private `_registeredTools` / `_tools` fields
    // that previously shifted across SDK releases.
    const handler = mcp.handlers && mcp.handlers.get(toolName);
    if (typeof handler !== 'function') {
      const err = new Error(`unknown tool: ${toolName}`);
      err.code = 'unknown_tool';
      throw err;
    }
    // The wrapped handler ignores its second arg (its ctx is built
    // internally from `args.cwd`); we pass the proxy signal context
    // for forward-compat in case a future handler wants to honour
    // cancellation through the proxy transport.
    return await handler(args || {}, {
      signal: new AbortController().signal,
      sendNotification: () => {},
      sendRequest: () => Promise.resolve({}),
      _meta: { proxy: true },
    });
  }

  // Brute-force throttle for the bearer. Ten consecutive 401s from one
  // remote address earn a 429 until the 60s window rolls over; a
  // successful auth clears that address's counter. The map is pruned on
  // every write (and hard-capped) so a spray of failed attempts cannot
  // grow it without bound. Only consulted when auth is actually enabled
  // — with no token configured there is no secret to guess, and the
  // informative 401 should reach the operator instead.
  const AUTH_FAIL_LIMIT = 10;
  const AUTH_FAIL_WINDOW_MS = 60000;
  const AUTH_FAIL_MAX_KEYS = 2048;
  const authFailures = new Map();
  const authFailureKey = (req) => {
    const addr = req.socket && req.socket.remoteAddress;
    return typeof addr === 'string' && addr ? addr : 'unknown';
  };
  const pruneAuthFailures = (now) => {
    for (const [key, entry] of authFailures) {
      if (now - entry.firstAt >= AUTH_FAIL_WINDOW_MS) authFailures.delete(key);
    }
    while (authFailures.size > AUTH_FAIL_MAX_KEYS) {
      const oldest = authFailures.keys().next();
      if (oldest.done) break;
      authFailures.delete(oldest.value);
    }
  };
  const authRetryAfter = (req, now) => {
    const key = authFailureKey(req);
    const entry = authFailures.get(key);
    if (!entry) return 0;
    if (now - entry.firstAt >= AUTH_FAIL_WINDOW_MS) {
      authFailures.delete(key);
      return 0;
    }
    if (entry.count < AUTH_FAIL_LIMIT) return 0;
    return Math.max(1, Math.ceil((entry.firstAt + AUTH_FAIL_WINDOW_MS - now) / 1000));
  };
  const noteAuthFailure = (req, now) => {
    const key = authFailureKey(req);
    const entry = authFailures.get(key);
    if (!entry || now - entry.firstAt >= AUTH_FAIL_WINDOW_MS) {
      authFailures.set(key, { count: 1, firstAt: now });
    } else {
      entry.count += 1;
    }
    pruneAuthFailures(now);
  };

  const server = http.createServer(async (req, res) => {
    state.requests += 1;
    state.lastRequestAt = new Date().toISOString();
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || host}`);
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid request URL' }));
      return;
    }
    const path = url.pathname.replace(/\/+$/, '') || '/';

    // CORS: list-based allowlist via `KIMI_MEMORY_PROXY_CORS_ORIGINS`
    // (comma-separated, exact match, never a wildcard). The proxy is a
    // server-to-server transport by default; a wildcard CORS would let
    // any browser-origin exfiltrate a token via a stolen cookie or shared
    // workstation. Setting the env var to e.g. "https://dashboard.local"
    // narrows the cross-origin surface to exactly the call sites that
    // need it. Auth still applies on every tool endpoint regardless.
    const allowedOrigins = (process.env.KIMI_MEMORY_PROXY_CORS_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const reqOrigin = req.headers.origin || '';
    if (allowedOrigins.includes(reqOrigin)) {
      res.setHeader('access-control-allow-origin', reqOrigin);
    }
    // Vary goes out on every response, reflected origin or not, so a
    // shared cache cannot hand one origin's response to another. Merged
    // into any existing Vary rather than overwritten. No
    // allow-credentials: the bearer is passed explicitly, not via cookie.
    const vary = new Set(
      String(res.getHeader('vary') || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
    vary.add('Origin');
    res.setHeader('vary', [...vary].join(', '));
    // GET covers /tools and /readyz; OPTIONS covers the preflight itself.
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('access-control-allow-headers', 'authorization, content-type');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Liveness — open to anyone (no auth) so a k8s probe can hit it.
    if (path === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, startedAt: state.startedAt, requests: state.requests }));
      return;
    }

    // Readiness — same shape as /healthz but a separate route so a
    // k8s probe can distinguish "the process is alive" from "the
    // process can actually serve tool calls". Right now the two are
    // equivalent because the tool registry is loaded at startup; if
    // we ever add a deferred bootstrap (e.g. lazy model download),
    // /readyz will flip first. Open to anyone so the probe can hit
    // it without a token.
    if (path === '/readyz') {
      let ready = true;
      let reason = null;
      try {
        // The orchestrator populates `mcp.handlers` at startup; if
        // it's missing the orchestrator never ran, so /readyz fails
        // closed (503) until the next reload.
        if (!mcp.handlers || mcp.handlers.size === 0) {
          ready = false;
          reason = 'mcp tool registry not accessible';
        }
      } catch (e) {
        ready = false;
        reason = safeErrorMessage(e);
      }
      res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: ready, reason, startedAt: state.startedAt }));
      return;
    }

    // Auth gate for every other route, including /tools. Free tool
    // enumeration would let an unauthenticated probe catalogue the
    // proxy's attack surface; require the bearer for everything that
    // is not a liveness probe.
    const now = Date.now();
    const retryAfter = state.authEnabled ? authRetryAfter(req, now) : 0;
    if (retryAfter > 0) {
      res.writeHead(429, {
        'content-type': 'application/json',
        'retry-after': String(retryAfter),
      });
      res.end(JSON.stringify({ error: 'too many failed authentication attempts; retry later' }));
      return;
    }
    const auth = authenticate(req);
    if (!auth.ok) {
      if (state.authEnabled) noteAuthFailure(req, now);
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: auth.error }));
      return;
    }
    if (state.authEnabled) authFailures.delete(authFailureKey(req));

    if (path === '/tools' && req.method === 'GET') {
      // List the tool names the proxy can call. Source of truth is
      // `mcp.handlers`, owned by the orchestrator (no SDK reach).
      try {
        const names = mcp.handlers ? [...mcp.handlers.keys()] : [];
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ tools: names, count: names.length }));
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: safeErrorMessage(e), code: e.code || 'internal' }));
      }
      return;
    }

    if (path === '/shutdown' && req.method === 'POST') {
      log('shutdown requested; closing server');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      // Defer the close so the response is flushed first. gracefulShutdown
      // drains in-flight embeddings + closes the SQLite cache so the
      // next process restart inherits a handle whose WAL was
      // checkpointed. Only this route (and the CLI's signal handler)
      // exits the process — the exported `close()` stays pure so a test
      // can tear the proxy down in-process. Without the explicit exit
      // this route leaves a zombie: no listener, a closed SQLite cache,
      // and nothing left to keep the event loop busy except whatever
      // handle `server.close()` is still draining.
      setImmediate(async () => {
        try {
          await gracefulShutdown();
        } catch {
          /* ignore */
        }
        process.exit(0);
      });
      return;
    }

    // POST /tools/<name>
    const m = path.match(/^\/tools\/([A-Za-z0-9_]+)$/);
    if (req.method === 'POST' && m) {
      const toolName = m[1];
      let body;
      try {
        body = await readJson(req);
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `invalid JSON body: ${safeErrorMessage(e)}` }));
        return;
      }
      try {
        const out = await dispatchTool(toolName, body);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out));
      } catch (e) {
        const isUnknown = e && e.code === 'unknown_tool';
        res.writeHead(isUnknown ? 404 : 500, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: safeErrorMessage(e),
            code: e.code || (isUnknown ? 'unknown_tool' : 'internal'),
          }),
        );
      }
      return;
    }

    // Default: 404.
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `unknown route: ${path}` }));
  });

  // Explicit bounds where Node's defaults are far too generous for a
  // local tool transport: the 300s default requestTimeout would let one
  // slow POST pin a request (and its buffers) open for five minutes,
  // which is also the window a token-spraying client gets for free.
  // headersTimeout must stay above keepAliveTimeout and below
  // requestTimeout, or Node warns and picks its own value.
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 100;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  log(`proxy listening on http://${host}:${port} (auth ${state.authEnabled ? 'on' : 'off'})`);

  // gracefulShutdown is the single teardown path: stops accepting
  // new HTTP connections and waits for in-flight requests to drain
  // FIRST, then flushes embedding microtasks, then releases SQLite
  // handles. Closing SQLite before the HTTP server drains lets an
  // active tool request race database teardown — a transient 500
  // or a corrupted in-flight row. (Audit finding F-009.)
  // /shutdown and the exported close() both route here so the two
  // teardown sequences can never drift; the process exit itself is the
  // route's (see /shutdown) and the CLI signal handler's, not this
  // function's.
  async function gracefulShutdown() {
    const serverClosed = new Promise((resolve) => {
      try {
        server.close(() => resolve());
      } catch {
        resolve();
      }
    });
    await serverClosed;

    try {
      await Promise.resolve(flushEmbeddings({ timeoutMs: 10000 }));
    } catch {
      /* ignore */
    }
    try {
      closeDb();
    } catch {
      /* ignore */
    }
  }

  return {
    server,
    host,
    port,
    state,
    close: () => gracefulShutdown(),
  };
}

/**
 * Sentinel for the CLI subcommand — `proxyAuthBypass()` returns true
 * when the operator has explicitly opted out of auth (intended for
 * dev only).
 */
export function proxyAuthBypass() {
  // Accept the common truthy set so `KIMI_MEMORY_PROXY_AUTH=0`,
  // `=false`, `=no`, or `=off` all turn auth off — not just the
  // literal string `off`. Read at call time so a test that toggles
  // the env var mid-suite sees the new value without re-instantiating
  // the proxy.
  const v = (process.env.KIMI_MEMORY_PROXY_AUTH || '').toLowerCase().trim();
  return v === 'off' || v === '0' || v === 'false' || v === 'no';
}

// Genuinely-loopback bind hosts only. The classification matters more
// than it looks: Node binds `listen(port, '')` to `::` (every interface,
// dual-stack) — verified, not assumed — so an empty host is the opposite
// of safe and must never count as loopback. Same for the wildcards
// `0.0.0.0` and `::`. Accepts the whole 127.0.0.0/8 block, `::1` (bare or
// `[::1]`) and `localhost` in any case, with or without a trailing dot.
// Shared by the startup TLS gate, the auth-bypass gate and
// nonLoopbackToolGuard() so those three decisions cannot drift apart.
const LOOPBACK_V4 = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function isLoopbackHost(host) {
  if (typeof host !== 'string') return false;
  let h = host.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h.endsWith('.')) h = h.slice(0, -1);
  if (h === 'localhost' || h === '::1') return true;
  if (!LOOPBACK_V4.test(h)) return false;
  return h
    .split('.')
    .slice(1)
    .every((part) => Number(part) <= 255);
}

// Destructive MCP tools that must not be reachable on a non-loopback
// bind without an explicit operator opt-in. Read-only and routine-write
// tools (memory_recall, memory_list, memory_get, memory_save, …) stay
// available. The opt-in env var is `KIMI_MEMORY_PROXY_ALLOW_TOOLS`
// (comma-separated). This set is a non-loopback rule only; the
// separate `KIMI_MEMORY_PROXY_DENY_TOOLS` check in
// `nonLoopbackToolGuard()` applies on every bind. (Prior audit flag
// F-003.)
const NETWORK_DESTRUCTIVE_TOOLS = new Set([
  'memory_reset_project',
  'memory_prune',
  'memory_delete',
  'acl_grant',
  'acl_revoke',
  'acl_share_memory',
  'memory_save_bulk',
  'memory_update',
  'memory_merge',
  'memory_link',
  'memory_unlink',
  'memory_reinforce',
  'codegraph_build_edges',
]);

export function nonLoopbackToolGuard(toolName, { host } = {}) {
  // `host` is the address startProxy is listening on, and it is
  // authoritative. Only when the caller omits it entirely do we fall
  // back to KIMI_MEMORY_PROXY_HOST and then to the loopback default —
  // startProxy itself never reads that env var, so a stale value there
  // cannot loosen a live bind.
  const bindHost = host != null ? host : process.env.KIMI_MEMORY_PROXY_HOST || '127.0.0.1';
  // Tool names are always lowercase. Normalise both sides of every
  // list comparison so `KIMI_MEMORY_PROXY_DENY_TOOLS=Memory_Delete`
  // denies instead of silently failing open on the operator's typo.
  const name = typeof toolName === 'string' ? toolName.toLowerCase() : toolName;
  // Operator-set deny-list always wins, regardless of any allow-list —
  // and it applies on EVERY bind, loopback included. The proxy is
  // documented to default to 127.0.0.1, so reading the deny-list after
  // the loopback early-return made this control dead on the default
  // configuration while AGENTS.md still advertised it (there is no
  // loopback carve-out in that contract). Use it to harden the proxy
  // against a specific tool even when the operator has a broader
  // ALLOW_TOOLS set.
  const denied = splitToolList(process.env.KIMI_MEMORY_PROXY_DENY_TOOLS);
  if (denied.has(name)) {
    return `tool ${toolName} is on the operator's deny-list (KIMI_MEMORY_PROXY_DENY_TOOLS). Remove it to allow.`;
  }
  // Loopback binds never trip the destructive-tool guard; the
  // bearer-auth boundary is considered sufficient for the same machine.
  if (isLoopbackHost(bindHost)) return null;
  if (!NETWORK_DESTRUCTIVE_TOOLS.has(name)) return null;
  // Operator-opt-in: each destructive tool must be named explicitly.
  const allowed = splitToolList(process.env.KIMI_MEMORY_PROXY_ALLOW_TOOLS);
  if (allowed.has(name)) return null;
  return `tool ${toolName} is not allowed on a non-loopback bind (host=${bindHost}). Set KIMI_MEMORY_PROXY_ALLOW_TOOLS=${toolName} to opt in.`;
}

// Comma-separated env list → lowercase Set. Set membership rather than
// `Array.includes` so the case normalisation cannot be forgotten at one
// of the two comparison sites.
function splitToolList(raw) {
  return new Set(
    (raw || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

// Pre-flight depth check for inbound JSON bodies. Walks the raw
// string and counts the maximum nesting depth of `[`/`{` minus
// `]`/`}`, ignoring those that appear inside JSON strings (so a
// quoted `"[[["` is not mis-counted) and skipping escaped quotes.
// A pathological body of `[[[[...]]]]` 10k levels deep otherwise
// reaches V8's call-stack limit inside JSON.parse and either
// throws `RangeError: Maximum call stack size exceeded` (older
// Node) or crashes the request handler (newer Node). The HTTP
// transport calls this from readJson() before handing the string
// to the parser; exported so the behaviour is unit-testable
// without spinning up the server.
export function maxJsonDepth(body, maxLevels = 64) {
  let depth = 0;
  let max = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{' || ch === '[') {
      depth += 1;
      if (depth > max) max = depth;
      if (max > maxLevels) {
        return { ok: false, depth: max };
      }
    } else if (ch === '}' || ch === ']') {
      depth -= 1;
    }
  }
  return { ok: true, depth: max };
}
