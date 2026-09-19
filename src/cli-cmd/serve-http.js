// CLI: start the memory proxy HTTP server.
//
//   serve-http [--port 7331] [--host 127.0.0.1]
//              [--auth-token-env KIMI_MEMORY_PROXY_TOKEN] [--no-auth]
//
// The proxy translates POST /tools/<name> into the same TOOL_DEFS
// handlers the stdio MCP server uses. Auth defaults to env-supplied
// bearer; --no-auth is dev-only and refuses non-loopback binds.
import { closeDb } from '../persist.js';
import { startProxy } from '../proxy/server.js';
import { homeDir } from '../cli/lib.js';

export async function cmdServeHttp(args) {
  const home = homeDir(args);
  const port = args.flags.port ? Number(args.flags.port) : 7331;
  const host = args.flags.host ? String(args.flags.host) : '127.0.0.1';
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    process.stderr.write('error: --port must be 1..65535\n');
    process.exit(1);
  }
  if (args.flags['no-auth']) {
    process.env.KIMI_MEMORY_PROXY_AUTH = 'off';
  }
  const authTokenEnv = args.flags['auth-token-env'] ? String(args.flags['auth-token-env']) : null;
  const authToken = authTokenEnv ? process.env[authTokenEnv] || null : null;
  const proxy = await startProxy({
    host,
    port,
    kimiHomeDir: home,
    pluginRootDir: process.cwd(),
    authToken,
  });
  const shutdown = (signal) => {
    process.stderr.write(`\n[serve-http] received ${signal}, shutting down\n`);
    proxy
      .close()
      .then(() => closeDb())
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
