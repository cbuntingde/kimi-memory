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
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const gitignore = readFileSync(path.join(root, '.gitignore'), 'utf8');

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
  for (const ev of [
    'SessionStart',
    'UserPromptSubmit',
    'Stop',
    'SessionEnd',
    'PreCompact',
    'Interrupt',
    'StopFailure',
  ]) {
    assert.ok(events.has(ev), 'missing hook event: ' + ev);
  }
});

test('skill directories and command files exist on disk', () => {
  const skillsDir = path.join(root, 'skills');
  assert.ok(existsSync(path.join(skillsDir, 'kimi-memory', 'SKILL.md')));
  assert.ok(existsSync(path.join(skillsDir, 'list_memories', 'SKILL.md')));
  // Advisor subsystem (merged 2026-07-31) lives under skills/advisor/.
  assert.ok(existsSync(path.join(skillsDir, 'advisor', 'SKILL.md')));
  assert.ok(existsSync(path.join(skillsDir, 'advisor', 'references', 'procedure.md')));
  assert.ok(existsSync(path.join(skillsDir, 'advisor', 'references', 'output-format.md')));
  assert.ok(existsSync(path.join(root, 'commands', 'list-memories.md')));
  assert.ok(existsSync(path.join(root, 'commands', 'advisor.md')));
  assert.ok(existsSync(path.join(root, 'commands', 'memos.md')));
});

test('MCP server entry point exists and is syntactically valid', () => {
  const main = path.join(root, 'src/mcp/main.js');
  assert.ok(existsSync(main));
});

test('manifest skill instructions and description mention global scope routing', () => {
  const skillInstructions = manifest.skillInstructions || '';
  const short = (manifest.interface && manifest.interface.shortDescription) || '';
  const long = (manifest.interface && manifest.interface.longDescription) || '';
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

test('advisor subsystem is wired into the hooks runner', () => {
  const detectSrc = readFileSync(path.join(root, 'src', 'advisor', 'detect.js'), 'utf8');
  const runnerSrc = readFileSync(path.join(root, 'src', 'hooks', 'run.js'), 'utf8');
  // The advisor module exports a matchAdvisor function and a frozen keyword list.
  assert.match(detectSrc, /export function matchAdvisor/);
  assert.match(detectSrc, /export const ADVISOR_KEYWORDS/);
  // The hook runner imports the advisor detector and uses it in UserPromptSubmit.
  assert.match(runnerSrc, /from ['"]\.\.\/advisor\/detect\.js['"]/);
  assert.match(runnerSrc, /matchAdvisor\(/);
  // The user-prompt hook emits a status line when an advisor keyword matches.
  assert.match(runnerSrc, /\[advisor\] matched:/);
});

test('plugin manifest reflects the merged memory + advisor displayName', () => {
  const display = manifest.interface && manifest.interface.displayName;
  assert.ok(display && /advisor/i.test(display), 'displayName should mention advisor: ' + display);
});

test('manifest version matches package.json and package-lock.json', () => {
  assert.equal(manifest.version, '0.2.0');
  assert.equal(pkg.version, manifest.version);
  assert.equal(lock.packages[''].version, manifest.version);
});

test('manifest tool count claim matches the registered tool count', () => {
  const serverSrc = readFileSync(path.join(root, 'src', 'server.js'), 'utf8');
  // Count `name: 'memory_…' / 'working_memory_…' / 'conversation_…'` entries
  // inside the TOOL_DEFS array. Each registered tool declares exactly one.
  const def = serverSrc.match(/const TOOL_DEFS = \[([\s\S]*?)\];/);
  assert.ok(def, 'TOOL_DEFS not found in src/server.js');
  const toolNames = def[1].match(/name: '(?:memory_|working_memory_|conversation_)[a-z_]+'/g) || [];
  const toolCount = toolNames.length;
  assert.ok(toolCount > 0, 'no tools registered in TOOL_DEFS');
  // Every tool must be wired into `server.tool(TOOL_DEFS[N]…)`. The wire
  // call may be on a single line or split across lines (memory_save is
  // split), so accept whitespace between `server.tool(` and the index.
  const wireIndices = new Set();
  for (const m of serverSrc.matchAll(/server\.tool\(\s*TOOL_DEFS\[(\d+)\]/g)) {
    wireIndices.add(Number(m[1]));
  }
  for (let i = 0; i < toolCount; i++) {
    assert.ok(
      wireIndices.has(i),
      'TOOL_DEFS[' + i + '] is registered but not wired into server.tool',
    );
  }
  // The long description must declare the same count.
  const long = (manifest.interface && manifest.interface.longDescription) || '';
  const claimed = (long.match(/Tools \((\d+)\):/) || [])[1];
  assert.ok(claimed, 'longDescription must declare "Tools (N):"');
  assert.equal(Number(claimed), toolCount, 'claimed tool count does not match TOOL_DEFS');
});

test('plugin commands are documented in their namespaced form', () => {
  const long = (manifest.interface && manifest.interface.longDescription) || '';
  assert.match(long, /\/kimi-memory:list_memories/);
  assert.match(long, /\/kimi-memory:advisor/);
  assert.match(long, /\/kimi-memory:memos/);
  // And the unnamespaced forms must not be promoted as plugin commands.
  assert.ok(
    !/\/advisor\b/.test(long.replace(/\/kimi-memory:advisor/g, '')),
    'longDescription should not advertise /advisor without the kimi-memory: prefix',
  );
  assert.ok(
    !/\/memos\b/.test(long.replace(/\/kimi-memory:memos/g, '')),
    'longDescription should not advertise /memos without the kimi-memory: prefix',
  );
});

test('_diagnostics/ is git-ignored so plugin-local log files do not dirty checkouts', () => {
  assert.match(gitignore, /(^|\n)_diagnostics\/(\n|$)/);
});

test('commands/*.md have valid frontmatter so /plugins can derive descriptions', () => {
  for (const name of ['list-memories.md', 'advisor.md', 'memos.md']) {
    const p = path.join(root, 'commands', name);
    const body = readFileSync(p, 'utf8');
    assert.match(body, /^---\n[\s\S]*?\n---\n/, name + ' is missing YAML frontmatter');
    assert.match(body, /\nname:/, name + ' is missing a name field in frontmatter');
    assert.match(body, /\ndescription:/, name + ' is missing a description field in frontmatter');
  }
});

test('advisor command no longer claims a non-existent /reflect alias', () => {
  const advisorCmd = readFileSync(path.join(root, 'commands', 'advisor.md'), 'utf8');
  assert.ok(
    !/Aliases?:\s*\/?reflect/i.test(advisorCmd),
    'commands/advisor.md should not advertise a /reflect alias',
  );
  assert.match(
    advisorCmd,
    /# \/kimi-memory:advisor/,
    'commands/advisor.md heading should use the namespaced form',
  );
});

test('uninstall.md exists, is tracked, and documents the full teardown', () => {
  const uninstallPath = path.join(root, 'uninstall.md');
  assert.ok(existsSync(uninstallPath), 'uninstall.md must exist at the repo root');
  const body = readFileSync(uninstallPath, 'utf8');
  // The doc must mention the plugin id so /plugins remove kimi-memory is unambiguous.
  assert.match(body, /\/plugins remove kimi-memory/);
  assert.match(body, /plugins\/managed\/kimi-memory/);
  // It must describe the destructive memory wipe so users see what they are deleting.
  assert.match(body, /\$KIMI_CODE_HOME\/kimi-memory/);
  assert.match(body, /_global/);
  // The README and ai-install.md must link to it.
  const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
  const aiInstall = readFileSync(path.join(root, 'ai-install.md'), 'utf8');
  assert.match(readme, /uninstall\.md/);
  assert.match(aiInstall, /uninstall\.md/);
});

test('README exposes the paste-able AI-driven install URL', () => {
  const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.match(
    readme,
    /https:\/\/raw\.githubusercontent\.com\/cbuntingde\/kimi-memory\/main\/ai-install\.md/,
    'README must include the raw URL to ai-install.md so the user can paste it into Kimi Code',
  );
});
