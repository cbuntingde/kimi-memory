// Test helpers shared across files. Temp-dir creation, MCP stdio
// harness, and a few utility functions.
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLUGIN_ROOT = path.resolve(__dirname, '..');

export function pluginRoot() { return PLUGIN_ROOT; }

export function mkTempHome(prefix = 'pm-test-') {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  return dir;
}

export function rmRf(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// Spawn the MCP server in a child process with KIMI_CODE_HOME set to
// `home` and cwd pinned to the plugin root. Provides a small JSON-RPC
// helper that returns parsed responses using the SDK's newline-delimited
// JSON framing.
export class StdioMcp {
  constructor({ home, pluginRootDir = PLUGIN_ROOT } = {}) {
    this.home = home;
    this.root = pluginRootDir;
    this.proc = null;
    this.buf = Buffer.alloc(0);
    this.pending = new Map();
    this.idSeq = 0;
    this.stderr = '';
    this.stdoutLog = '';
    this.onNotification = null;
  }
  start() {
    this.proc = spawn(process.execPath, [path.join(this.root, 'src/mcp/main.js')], {
      cwd: this.root,
      env: { ...process.env, KIMI_CODE_HOME: this.home, NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stdout.on('data', (chunk) => this._onStdout(chunk));
    this.proc.stderr.on('data', (chunk) => { this.stderr += chunk.toString('utf8'); });
    this.proc.on('error', () => { /* ignore */ });
  }
  stop() {
    try { this.proc && this.proc.kill(); } catch { /* ignore */ }
  }
  _onStdout(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (true) {
      const newline = this.buf.indexOf('\n');
      if (newline === -1) return;
      const body = this.buf.slice(0, newline).toString('utf8').replace(/\r$/, '');
      this.buf = this.buf.slice(newline + 1);
      if (!body) continue;
      let msg;
      try { msg = JSON.parse(body); } catch { continue; }
      this.stdoutLog += body + '\n';
      if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
        const r = this.pending.get(msg.id);
        if (r) {
          this.pending.delete(msg.id);
          if (msg.error) r.reject(new Error('rpc error: ' + JSON.stringify(msg.error)));
          else r.resolve(msg.result);
        }
      } else if (msg.method && this.onNotification) {
        try { this.onNotification(msg); } catch { /* ignore */ }
      }
    }
  }
  _send(obj) {
    const id = ++this.idSeq;
    const body = JSON.stringify({ jsonrpc: '2.0', id, ...obj }) + '\n';
    this.proc.stdin.write(body);
    return id;
  }
  call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this._send({ method, params });
      this.pending.set(id, { resolve, reject });
    });
  }
  toolCall(name, args) {
    return this.call('tools/call', { name, arguments: args });
  }
}

export function writeJsonl(file, lines) {
  mkdirSync(path.dirname(file), { recursive: true });
  const body = lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n';
  writeFileSync(file, body);
}

export function writeRaw(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

export function readText(file) {
  return readFileSync(file, 'utf8');
}

export function exists(file) { return existsSync(file); }

export function stat(file) { return statSync(file); }
