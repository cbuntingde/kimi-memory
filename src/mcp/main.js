// stdio entry point for the kimi-memory MCP server. Run with
// `node src/mcp/main.js` from the plugin root. The manifest pins cwd to
// "./" so this always starts in the plugin directory; we chdir again
// defensively in case a caller invokes it through a different path.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { makeServer } from '../server.js';
import { closeDb, flushEmbeddings } from '../persist.js';

const __filename = fileURLToPath(import.meta.url);
const pluginRoot = path.resolve(path.dirname(__filename), '..', '..');

// Pin cwd to the plugin root so all relative paths (assets, default
// kimi-home probe) resolve consistently.
try {
  process.chdir(pluginRoot);
} catch {
  /* ignore */
}

// Close every cached SQLite handle on signal-driven shutdown. Without
// these, every Kimi cycle leaks a WAL writer; on next open, SQLite has
// to recover the uncheckpointed WAL. closeDb() is idempotent (no-op
// when no handles are open) and never throws — safe to call from
// multiple signal sources. flushEmbeddings() drains any in-flight
// embedding microtasks before the handle closes so a partial row write
// cannot be truncated by db.close().
const flushAndExit = (code = 0) => {
  // Best-effort drain; the wall-clock cap inside flushEmbeddings
  // bounds the wait so a hung encoder cannot block exit.
  Promise.resolve(flushEmbeddings({ timeoutMs: 10000 }))
    .catch(() => {})
    .finally(() => {
      try {
        closeDb();
      } catch {
        /* ignore — fail-open */
      }
      process.exit(code);
    });
};
process.on('SIGINT', () => flushAndExit(0));
process.on('SIGTERM', () => flushAndExit(0));
process.on('beforeExit', () => {
  try {
    closeDb();
  } catch {
    /* ignore */
  }
});

const { server } = makeServer({ pluginRootDir: pluginRoot });

const transport = new StdioServerTransport();
server.connect(transport).catch((err) => {
  // Fail open: print to stderr and exit non-zero only when the transport
  // is genuinely unusable. MCP surfaces errors to the client anyway.
  try {
    process.stderr.write('[kimi-memory] connect failed: ' + (err && err.message) + '\n');
  } catch {
    /* ignore */
  }
  process.exit(1);
});
