// Configuration management for kimi-memory.
// Replaces hand-rolled TOML parser with validated config schema.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { logConfigValidationError } from './diagnostics.js';

// Configuration schema and validation.
const DEFAULT_CONFIG = {
  'kimi-memory': {
    disable_auto_extract: false,
    disable_embeddings: false,
    embed_timeout_ms: 4000,
    llm_model: null, // Will be resolved from [models] section
    llm_provider: null, // Will be resolved from [models] section
  },
};

export function validateConfig(raw) {
  if (!raw || typeof raw !== 'object') {
    return { ok: true, value: DEFAULT_CONFIG };
  }

  const km = raw['kimi-memory'] || {};
  
  // Validate field types.
  const validatedKm = {};
  
  if (typeof km.disable_auto_extract === 'boolean') {
    validatedKm.disable_auto_extract = km.disable_auto_extract;
  }
  
  if (typeof km.disable_embeddings === 'boolean') {
    validatedKm.disable_embeddings = km.disable_embeddings;
  }
  
  if (typeof km.embed_timeout_ms === 'number' && km.embed_timeout_ms > 0) {
    validatedKm.embed_timeout_ms = km.embed_timeout_ms;
  }
  
  if (typeof km.llm_model === 'string') {
    validatedKm.llm_model = km.llm_model;
  }
  
  if (typeof km.llm_provider === 'string') {
    validatedKm.llm_provider = km.llm_provider;
  }

  return {
    ok: true,
    value: {
      ...DEFAULT_CONFIG,
      'kimi-memory': {
        ...DEFAULT_CONFIG['kimi-memory'],
        ...validatedKm,
      },
    },
  };
}

// Simple TOML-like parser optimized for kimi-code config.toml structure.
// Handles: [section] headers, key = value pairs, comments, quoted strings.
// NOT a full TOML implementation, but sufficient for our config needs.
export function parseTomlLike(content) {
  if (!content || typeof content !== 'string') {
    return {};
  }

  const result = {};
  let currentSection = null;

  const lines = content.split('\n');
  for (const rawLine of lines) {
    // Strip comments (but not # inside quotes).
    const line = stripComment(rawLine).trim();
    if (!line) continue;

    // Detect section header [section].
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      if (!result[currentSection]) {
        result[currentSection] = {};
      }
      continue;
    }

    // Parse key = value.
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;

    const key = line.slice(0, eqIdx).trim();
    const valueStr = line.slice(eqIdx + 1).trim();

    if (!key) continue;

    const value = parseTomlValue(valueStr);
    if (currentSection) {
      result[currentSection][key] = value;
    } else {
      result[key] = value;
    }
  }

  return result;
}

// Strip comments while respecting quotes.
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

// Parse TOML-like values: strings (quoted/unquoted), booleans, numbers, arrays.
function parseTomlValue(valueStr) {
  if (!valueStr) return null;

  const trimmed = valueStr.trim();

  // Quoted string.
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }

  // Boolean.
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;

  // Number.
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return trimmed.includes('.') ? parseFloat(trimmed) : parseInt(trimmed, 10);
  }

  // Array [val1, val2, ...].
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1);
    return inner
      .split(',')
      .map((v) => parseTomlValue(v.trim()))
      .filter((v) => v != null);
  }

  // Unquoted string.
  return trimmed;
}

// Load and validate config from file.
export async function loadConfig(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const parsed = parseTomlLike(content);
    const validated = validateConfig(parsed);

    if (!validated.ok) {
      await logConfigValidationError(new Error(validated.error), { filePath }).catch(() => {});
      return DEFAULT_CONFIG;
    }

    return validated.value;
  } catch (err) {
    // File not found or read error: use defaults.
    if (err.code !== 'ENOENT') {
      await logConfigValidationError(err, { filePath }).catch(() => {});
    }
    return DEFAULT_CONFIG;
  }
}

// Merge user config with environment overrides.
export function mergeConfigWithEnv(config) {
  const merged = JSON.parse(JSON.stringify(config)); // Deep copy
  const km = merged['kimi-memory'] || {};

  if (process.env.KIMI_MEMORY_AUTO_EXTRACT === 'off') {
    km.disable_auto_extract = true;
  }
  if (process.env.KIMI_MEMORY_EMBEDDINGS === 'off') {
    km.disable_embeddings = true;
  }
  if (process.env.KIMI_MEMORY_EMBED_TIMEOUT_MS) {
    const timeout = parseInt(process.env.KIMI_MEMORY_EMBED_TIMEOUT_MS, 10);
    if (Number.isFinite(timeout) && timeout > 0) {
      km.embed_timeout_ms = timeout;
    }
  }

  merged['kimi-memory'] = km;
  return merged;
}

// Get effective config with all overrides applied.
export async function getEffectiveConfig(kimiHome) {
  const configPath = path.join(kimiHome, 'config.toml');
  const config = await loadConfig(configPath);
  return mergeConfigWithEnv(config);
}

// Config summary for diagnostics.
export function summarizeConfig(config) {
  const km = config['kimi-memory'] || {};
  return {
    auto_extract_enabled: !km.disable_auto_extract,
    embeddings_enabled: !km.disable_embeddings,
    embed_timeout_ms: km.embed_timeout_ms || 4000,
    llm_model: km.llm_model || 'not configured',
    llm_provider: km.llm_provider || 'not configured',
  };
}
