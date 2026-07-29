// stdio entry point for the kimi-memory MCP server. Run with
// `node src/mcp/main.js` from the plugin root. The manifest pins cwd to
// "./" so this always starts in the plugin directory; we chdir again
// defensively in case a caller invokes it through a different path.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { makeServer } from '../server.js';

const __filename = fileURLToPath(import.meta.url);
const pluginRoot = path.resolve(path.dirname(__filename), '..', '..');

// Pin cwd to the plugin root so all relative paths (assets, default
// kimi-home probe) resolve consistently.
try { process.chdir(pluginRoot); } catch { /* ignore */ }

const { server } = makeServer({ pluginRootDir: pluginRoot });

const transport = new StdioServerTransport();
server.connect(transport).catch((err) => {
  // Fail open: print to stderr and exit non-zero only when the transport
  // is genuinely unusable. MCP surfaces errors to the client anyway.
  try { process.stderr.write('[kimi-memory] connect failed: ' + (err && err.message) + '\n'); } catch { /* ignore */ }
  process.exit(1);
});
