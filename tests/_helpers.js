// Test helpers shared across files. Temp-dir creation, MCP stdio
// harness, and a few utility functions.
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Tests opt out of embedding by default — we don't want the suite to
// hit Hugging Face to download the model on every CI run. Tests that
// specifically exercise embedding logic should set
// `process.env.KIMI_MEMORY_EMBEDDINGS = 'on'` before importing.
if (!('KIMI_MEMORY_EMBEDDINGS' in process.env)) {
  process.env.KIMI_MEMORY_EMBEDDINGS = 'off';
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLUGIN_ROOT = path.resolve(__dirname, '..');

export function pluginRoot() {
  return PLUGIN_ROOT;
}

export function mkTempHome(prefix = 'pm-test-') {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  return dir;
}

export function rmRf(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

// Spawn the MCP server in a child process with KIMI_CODE_HOME set to
// `home` and cwd pinned to the plugin root. Provides a small JSON-RPC
// helper that returns parsed responses using the SDK's newline-delimited
// JSON framing.
//
// Every request is bounded by `timeoutMs`, and every terminal event on
// the child (spawn error, exit, close) rejects the in-flight promises.
// Without that, a child which dies during startup — for example when
// `node_modules` is missing and `src/mcp/main.js` throws
// ERR_MODULE_NOT_FOUND — leaves `call()` pending forever, so the file
// hangs until the runner's global timeout instead of failing with the
// child's stack trace.
const DEFAULT_TIMEOUT_MS = 15000;

// Characters of the child's stderr carried on every rejection. The child
// prints its stack trace to stderr and that tail is the only useful
// diagnostic in a CI log, so it travels with the error.
const STDERR_TAIL_CHARS = 2000;

export class StdioMcp {
  constructor({
    home,
    pluginRootDir = PLUGIN_ROOT,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    envExtra = {},
  } = {}) {
    this.home = home;
    this.root = pluginRootDir;
    this.timeoutMs = timeoutMs;
    this.envExtra = envExtra;
    this.proc = null;
    this.buf = Buffer.alloc(0);
    this.pending = new Map();
    this.idSeq = 0;
    this.stderr = '';
    this.stdoutLog = '';
    this.onNotification = null;
    // Filled in by the exit/close handlers and folded into later
    // rejections so a caller learns *why* a request got no reply.
    this.exitInfo = null;
  }
  start() {
    this.proc = spawn(process.execPath, [path.join(this.root, 'src/mcp/main.js')], {
      cwd: this.root,
      env: { ...process.env, KIMI_CODE_HOME: this.home, NO_COLOR: '1', ...this.envExtra },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stdout.on('data', (chunk) => this._onStdout(chunk));
    this.proc.stderr.on('data', (chunk) => {
      this.stderr += chunk.toString('utf8');
    });
    // A failed spawn (missing interpreter, EACCES, …) emits 'error' and
    // never 'exit', so it needs its own rejection path.
    this.proc.on('error', (err) => this._failAll('child spawn error: ' + err.message));
    // 'exit' carries the code/signal; 'close' fires once stdio is
    // drained. Both must reject: a request issued after the child died
    // has to fail immediately instead of hanging.
    this.proc.on('exit', (code, signal) => {
      this.exitInfo = this.exitInfo || { code, signal };
      this._failAll(this._exitReason('child exited'));
    });
    this.proc.on('close', (code, signal) => {
      this.exitInfo = this.exitInfo || { code, signal };
      this._failAll(this._exitReason('child closed'));
    });
  }
  stop() {
    try {
      this.proc && this.proc.kill();
    } catch {
      /* ignore */
    }
  }
  // Human-readable description of the child's terminal state plus the
  // stderr tail. Shared by the timeout path and both exit handlers so
  // every rejection carries the same diagnostic shape.
  _exitReason(prefix) {
    const info = this.exitInfo
      ? 'exit code ' + this.exitInfo.code + ', signal ' + this.exitInfo.signal
      : 'exit code unknown (still running?)';
    return prefix + ' (' + info + ')\n--- child stderr (tail) ---\n' + this._stderrTail();
  }
  _stderrTail() {
    if (!this.stderr) return '(empty)';
    return this.stderr.length > STDERR_TAIL_CHARS
      ? '…' + this.stderr.slice(-STDERR_TAIL_CHARS)
      : this.stderr;
  }
  // Reject every in-flight request and drain the map. 'exit' and 'close'
  // both fire, so the map must already be empty on the second event to
  // avoid re-rejecting (and re-throwing) settled promises.
  _failAll(reason) {
    if (this.pending.size === 0) return;
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
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
      try {
        msg = JSON.parse(body);
      } catch {
        continue;
      }
      this.stdoutLog += body + '\n';
      if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
        const r = this.pending.get(msg.id);
        if (r) {
          this.pending.delete(msg.id);
          clearTimeout(r.timer);
          if (msg.error) r.reject(new Error('rpc error: ' + JSON.stringify(msg.error)));
          else r.resolve(msg.result);
        }
      } else if (msg.method && this.onNotification) {
        try {
          this.onNotification(msg);
        } catch {
          /* ignore */
        }
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
    // A call made after the child died must fail with the exit
    // diagnostic rather than an opaque stream-write error.
    if (this.exitInfo) {
      return Promise.reject(
        new Error(method + ': ' + this._exitReason('cannot send, child already exited')),
      );
    }
    return new Promise((resolve, reject) => {
      let id;
      try {
        id = this._send({ method, params });
      } catch (err) {
        reject(new Error(method + ': failed to write to child stdin: ' + err.message));
        return;
      }
      // Watchdog: a child that never answers (deadlocked, or crashed
      // without closing stdio) must fail the call instead of hanging the
      // suite. unref() so a stuck child cannot keep the runner alive.
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            method +
              ': no response within ' +
              this.timeoutMs +
              'ms; ' +
              this._exitReason('child state'),
          ),
        );
      }, this.timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      this.pending.set(id, { resolve, reject, timer });
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

export function exists(file) {
  return existsSync(file);
}

export function stat(file) {
  return statSync(file);
}
