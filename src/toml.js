// Minimal TOML parser covering the kimi-code config.toml subset.
// Handles: comments, bare/quote keys, [section] headers (with quoted
// segments that may contain dots, e.g. [models."minimax/MiniMax-M3"]),
// basic scalars (string, int, float, bool), string arrays. Sufficient
// for the config.toml we ship; not a full TOML implementation.
//
// The previous comment-stripping regex (#[^"]*$) was unsafe: it
// matched a # that lives inside a string literal (e.g. key = "abc#def")
// and truncated the value. The replacement walks the line char by
// char so a # inside a quoted string is preserved, and a # outside
// any string is treated as a comment terminator.

function stripComment(line) {
  let inQuote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuote) {
      if (c === inQuote && line[i - 1] !== '\\') inQuote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      inQuote = c;
      continue;
    }
    if (c === '#') return line.slice(0, i);
  }
  return line;
}

export function parseToml(text) {
  const out = {};
  let cur = out;
  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw).trim();
    if (!line) continue;
    if (line.startsWith('[')) {
      const sec = line.replace(/^\[|\]$/g, '').trim();
      const parts = splitTomlPath(sec);
      let node = out;
      for (let i = 0; i < parts.length - 1; i++) {
        node[parts[i]] = node[parts[i]] || {};
        node = node[parts[i]];
      }
      node[parts[parts.length - 1]] = node[parts[parts.length - 1]] || {};
      cur = node[parts[parts.length - 1]];
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const k = unquoteKey(line.slice(0, eq).trim());
    const v = parseTomlValue(line.slice(eq + 1).trim());
    cur[k] = v;
  }
  return out;
}

// Split a section header like `models."minimax/MiniMax-M2.7"` into
// ['models', 'minimax/MiniMax-M2.7'] — respecting quoted segments so a
// `.` inside a quoted name is part of the segment, not a path split.
function splitTomlPath(s) {
  const out = [];
  let buf = '';
  let inQuote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuote) {
      buf += c;
      if (c === inQuote) inQuote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      inQuote = c;
      buf += c;
      continue;
    }
    if (c === '.') {
      out.push(unquoteKey(buf));
      buf = '';
      continue;
    }
    buf += c;
  }
  if (buf.length > 0) out.push(unquoteKey(buf));
  return out.filter((p) => p.length > 0);
}

function unquoteKey(k) {
  k = k.trim();
  if ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'"))) {
    return k.slice(1, -1);
  }
  return k;
}

function parseTomlValue(raw) {
  if (raw.startsWith('"') || raw.startsWith("'")) {
    const q = raw[0];
    let out = '';
    for (let i = 1; i < raw.length; i++) {
      const c = raw[i];
      if (c === q) return out;
      if (c === '\\' && i + 1 < raw.length) {
        const n = raw[i + 1];
        out += n === 'n' ? '\n' : n === 't' ? '\t' : n === '\\' ? '\\' : n === '"' ? '"' : n;
        i++;
      } else out += c;
    }
    return out;
  }
  if (raw.startsWith('[')) {
    const inner = raw.slice(1, raw.lastIndexOf(']'));
    const items = [];
    let depth = 0,
      buf = '';
    for (const c of inner) {
      if (c === '[') depth++;
      if (c === ']') depth--;
      if (c === ',' && depth === 0) {
        items.push(buf.trim());
        buf = '';
        continue;
      }
      buf += c;
    }
    if (buf.trim()) items.push(buf.trim());
    return items.map(parseTomlValue);
  }
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+$/.test(raw)) return parseInt(raw, 10);
  if (/^-?\d+\.\d+$/.test(raw)) return parseFloat(raw);
  return raw;
}
