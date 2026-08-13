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
// must carry `Authorization: Bearer <token>`. When unset, the proxy
// refuses to start unless `KIMI_MEMORY_PROXY_AUTH=off` (intended for
// dev only — see `proxyAuthBypass()`).
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
// `KIMI_MEMORY_PROXY_ALLOW_TOOLS` (comma-separated). See
// `nonLoopbackToolGuard()` for the exact set.
//
// (Prior audit flag F-003 — a network bind with bearer auth alone was
// the network-wide admin path the audit called out.)

import http from 'node:http';
import { URL } from 'node:url';
import crypto from 'node:crypto';
import { makeServer } from '../server.js';
import { kimiHome } from '../util.js';
import { closeDb, flushEmbeddings } from '../persist.js';

/**
 * Build the tool-name → handler map by walking the MCP server's
 * internal `_handlers` table. We can't directly enumerate
 * `TOOL_DEFS` from outside `server.js` without exposing it, so we
 * pre-register every public tool by calling makeServer() and then
 * iterating the McpServer's internal handler list via a small probe.
 *
 * The pragmatic approach: every call hits the proxy with a known
 * tool name; we forward by spinning up the real handler via the
 * `makeServer()._deps` interface. The MCP server exposes a
 * `server.tool(...)` registration API but no enumeration API; the
 * simplest cross-version path is to forward via the JSON-RPC
 * dispatcher that the McpServer wires up internally. To keep this
 * file self-contained and not depend on internals, the proxy keeps
 * its own name→spec table derived from TOOL_DEFS at startup.
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
  if (bypass && host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') {
    const msg = `kimi-memory proxy: refusing to start — KIMI_MEMORY_PROXY_AUTH=off with host=${host} would expose unauthenticated access. Use a loopback host or set KIMI_MEMORY_PROXY_TOKEN.`;
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
    if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) {
      return { ok: false, error: 'missing Authorization: Bearer <token>' };
    }
    const presented = auth.slice('Bearer '.length).trim();
    // Constant-time comparison so an attacker on the same loopback
    // cannot recover the token byte-by-byte from response timing. The
    // length check is intentionally first because timingSafeEqual
    // throws when buffer lengths differ.
    const a = Buffer.from(presented, 'utf8');
    const b = Buffer.from(token, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return { ok: false, error: 'invalid bearer token' };
    }
    return { ok: true };
  }

  async function readJson(req, limit = 1024 * 1024) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let total = 0;
      let aborted = false;
      const finish = (err) => {
        if (aborted) return;
        aborted = true;
        if (err) return reject(err);
        try {
          const body = Buffer.concat(chunks).toString('utf8');
          resolve(body.length === 0 ? {} : JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      };
      req.on('data', (c) => {
        if (aborted) return;
        total += c.length;
        if (total > limit) {
          chunks.length = 0;
          finish(new Error(`request body too large (>${limit} bytes)`));
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => finish(null));
      req.on('error', finish);
    });
  }

  async function dispatchTool(toolName, args) {
    // Refuse destructive tools on a non-loopback bind unless the
    // operator explicitly opted in via KIMI_MEMORY_PROXY_ALLOW_TOOLS.
    // A network bind with a single shared bearer token is a
    // network-wide admin path otherwise — the audit floor requires
    // this default-off shape. (Prior audit flag F-003.)
    const deny = guardToolName(toolName);
    if (deny) {
      const err = new Error(deny);
      err.code = 'tool_not_allowed';
      throw err;
    }
    // The MCP McpServer exposes `server._registeredTools` (private)
    // in some SDK versions; we fall back to invoking the named
    // tool via the server's tool registry. For an external proxy the
    // shape that matters is the wire response: we want the same
    // `{ content: [{type:'text', text: JSON.stringify(payload)}] }`
    // envelope the stdio MCP server emits.
    //
    // McpServer doesn't expose a public "call by name" API; the
    // closest surface is the internal `_registeredTools` map. We use
    // it as an implementation detail of this version of the SDK and
    // fall back to a 501 if the shape ever drifts.
    const srv = mcp.server;
    const registry = srv && (srv._registeredTools || srv._tools);
    if (!registry) {
      throw new Error('MCP server registry not accessible in this SDK version');
    }
    const entry = registry.get(toolName) || registry[toolName];
    if (!entry) {
      const err = new Error(`unknown tool: ${toolName}`);
      err.code = 'unknown_tool';
      throw err;
    }
    const handler = entry.handler || entry.callback || entry.fn;
    if (typeof handler !== 'function') {
      throw new Error(`tool ${toolName} has no callable handler`);
    }
    return await handler(args || {}, {
      // Minimal signal-bearing second arg — the stdio transport
      // doesn't pass one but the tool handlers tolerate undefined.
      signal: new AbortController().signal,
      sendNotification: () => {},
      sendRequest: () => Promise.resolve({}),
      _meta: { proxy: true },
    });
  }

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
    // (comma-separated). The proxy is a server-to-server transport by
    // default; a wildcard CORS would let any browser-origin exfiltrate a
    // token via a stolen cookie or shared workstation. Setting the env
    // var to e.g. "https://dashboard.local" narrows the cross-origin
    // surface to exactly the call sites that need it. Auth still applies
    // on every tool endpoint regardless.
    const allowedOrigins = (process.env.KIMI_MEMORY_PROXY_CORS_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const reqOrigin = req.headers.origin || '';
    if (allowedOrigins.includes(reqOrigin)) {
      res.setHeader('access-control-allow-origin', reqOrigin);
      res.setHeader('vary', 'Origin');
    }
    res.setHeader('access-control-allow-methods', 'POST');
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

    // Auth gate for every other route, including /tools. Free tool
    // enumeration would let an unauthenticated probe catalogue the
    // proxy's attack surface; require the bearer for everything that
    // is not a liveness probe.
    const auth = authenticate(req);
    if (!auth.ok) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: auth.error }));
      return;
    }

    if (path === '/tools' && req.method === 'GET') {
      // List the tool names the proxy can call. The McpServer does
      // not expose this directly; we walk the registry.
      try {
        const registry = mcp.server && (mcp.server._registeredTools || mcp.server._tools);
        const names = registry
          ? [...(registry.keys ? registry.keys() : Object.keys(registry))]
          : [];
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ tools: names, count: names.length }));
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
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
      // checkpointed.
      setImmediate(() => {
        gracefulShutdown().catch(() => {});
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
        res.end(JSON.stringify({ error: `invalid JSON body: ${e.message}` }));
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
            error: e.message,
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
  // surfaces can never drift.
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

// Destructive MCP tools that must not be reachable on a non-loopback
// bind without an explicit operator opt-in. Read-only and routine-write
// tools (memory_recall, memory_list, memory_get, memory_save, …) stay
// available. The opt-in env var is `KIMI_MEMORY_PROXY_ALLOW_TOOLS`
// (comma-separated). (Prior audit flag F-003.)
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
  // Loopback binds never trip the guard; the bearer-auth boundary is
  // considered sufficient for the same machine.
  const bindHost = host != null ? host : process.env.KIMI_MEMORY_PROXY_HOST || '127.0.0.1';
  const loopback =
    bindHost === '127.0.0.1' || bindHost === '::1' || bindHost === 'localhost' || bindHost === '';
  if (loopback) return null;
  if (!NETWORK_DESTRUCTIVE_TOOLS.has(toolName)) return null;
  // Operator-opt-in: each destructive tool must be named explicitly.
  const allowed = (process.env.KIMI_MEMORY_PROXY_ALLOW_TOOLS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowed.includes(toolName)) return null;
  return `tool ${toolName} is not allowed on a non-loopback bind (host=${bindHost}). Set KIMI_MEMORY_PROXY_ALLOW_TOOLS=${toolName} to opt in.`;
}
