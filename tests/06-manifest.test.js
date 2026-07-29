// Validates the on-disk plugin shape: kimi.plugin.json is present,
// references real files, all hook wrappers exist, the manifest's
// fields are well-formed, and the new three-layer/global-scope notes
// show up in the description text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { pluginRoot } from './_helpers.js';

const root = pluginRoot();
const manifest = JSON.parse(readFileSync(path.join(root, 'kimi.plugin.json'), 'utf8'));

test('manifest has the required high-value fields', () => {
  assert.equal(manifest.name, 'kimi-memory');
  assert.ok(manifest.mcpServers && manifest.mcpServers['kimi-memory']);
  assert.equal(manifest.mcpServers['kimi-memory'].command, 'node');
  assert.deepEqual(manifest.mcpServers['kimi-memory'].args, ['./src/mcp/main.js']);
  assert.equal(manifest.mcpServers['kimi-memory'].cwd, './');
  assert.ok(Array.isArray(manifest.hooks));
  assert.ok(manifest.skills);
  assert.ok(manifest.commands);
  assert.equal(manifest.sessionStart.skill, 'kimi-memory');
});

test('every hook command points at an existing file', () => {
  for (const h of manifest.hooks) {
    const rel = h.command.replace(/^node\s+/, '');
    const abs = path.join(root, rel);
    assert.ok(existsSync(abs), 'hook file missing: ' + rel);
  }
});

test('all required hook events are declared', () => {
  const events = new Set(manifest.hooks.map((h) => h.event));
  for (const ev of ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd', 'PreCompact', 'Interrupt', 'StopFailure']) {
    assert.ok(events.has(ev), 'missing hook event: ' + ev);
  }
});

test('skill directories and command files exist on disk', () => {
  const skillsDir = path.join(root, 'skills');
  assert.ok(existsSync(path.join(skillsDir, 'kimi-memory', 'SKILL.md')));
  assert.ok(existsSync(path.join(skillsDir, 'list_memories', 'SKILL.md')));
  assert.ok(existsSync(path.join(root, 'commands', 'list-memories.md')));
});

test('MCP server entry point exists and is syntactically valid', () => {
  const main = path.join(root, 'src/mcp/main.js');
  assert.ok(existsSync(main));
});

test('manifest skill instructions and description mention global scope routing', () => {
  const skillInstructions = manifest.skillInstructions || '';
  const short = manifest.interface && manifest.interface.shortDescription || '';
  const long = manifest.interface && manifest.interface.longDescription || '';
  for (const needle of ['global', 'project', '_global']) {
    assert.ok(skillInstructions.includes(needle), 'skillInstructions missing: ' + needle);
    assert.ok(long.includes(needle), 'longDescription missing: ' + needle);
  }
  // Default scope guidance must be present.
  assert.match(skillInstructions, /scope:'all'/);
  assert.match(skillInstructions, /scope:'global'/);
  void short;
});

test('SKILL.md files document the three-layer model and scope routing', () => {
  const skill = readFileSync(path.join(root, 'skills', 'kimi-memory', 'SKILL.md'), 'utf8');
  const listSkill = readFileSync(path.join(root, 'skills', 'list_memories', 'SKILL.md'), 'utf8');
  const cmd = readFileSync(path.join(root, 'commands', 'list-memories.md'), 'utf8');
  for (const doc of [skill, listSkill, cmd]) {
    assert.match(doc, /global/i, 'doc should mention the global layer');
    assert.match(doc, /scope/i, 'doc should mention scope routing');
  }
});
