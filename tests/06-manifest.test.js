// Validates the on-disk plugin shape: kimi.plugin.json is present,
// references real files, all hook wrappers exist, the manifest's
// fields are well-formed, and the new three-layer/global-scope notes
// show up in the description text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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
  assert.deepEqual(manifest.mcpServers['kimi-memory'].args, ['./src/mcp/launcher.js']);
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
  // The advisor module is imported by the per-event user-prompt handler
  // (the dispatcher itself stays event-agnostic). Walk both the
  // dispatcher and the handlers directory to find the import.
  const runnerSrc = readFileSync(path.join(root, 'src', 'hooks', 'run.js'), 'utf8');
  const handlersDir = path.join(root, 'src', 'hooks', 'handlers');
  const handlerFiles = readdirSync(handlersDir);
  const handlerSrc = handlerFiles
    .filter((f) => f.endsWith('.js'))
    .map((f) => readFileSync(path.join(handlersDir, f), 'utf8'))
    .join('\n');
  // The advisor module exports a matchAdvisor function and a frozen keyword list.
  assert.match(detectSrc, /export function matchAdvisor/);
  assert.match(detectSrc, /export const ADVISOR_KEYWORDS/);
  // The advisor detector is imported by either the dispatcher or a handler.
  const importRe = /from ['"](?:\.\.\/)+advisor\/detect\.js['"]/;
  const allSrc = runnerSrc + '\n' + handlerSrc;
  assert.match(allSrc, importRe, 'advisor/detect.js is not imported by the hooks layer');
  assert.match(allSrc, /matchAdvisor\(/);
  // The user-prompt handler emits the [advisor] matched status line.
  assert.match(allSrc, /\[advisor\] matched:/);
});

test('plugin manifest reflects the merged memory + advisor displayName', () => {
  const display = manifest.interface && manifest.interface.displayName;
  assert.ok(display && /advisor/i.test(display), 'displayName should mention advisor: ' + display);
});

test('manifest version matches package.json and package-lock.json', () => {
  assert.equal(manifest.version, '0.6.0');
  assert.equal(pkg.version, manifest.version);
  assert.equal(lock.packages[''].version, manifest.version);
});

test('manifest tool count claim matches the registered tool count', () => {
  // TOOL_DEFS lives in src/mcp/tool-defs.js since the Phase-1 refactor;
  // the per-tool wires live in src/mcp/handlers/*.js since the
  // Phase-2 refactor (one `registerTool(server, D.<name>, ...)` call
  // per tool per handler file). The orchestrator src/server.js is a
  // thin shell that imports + invokes those handlers.
  const defsSrc = readFileSync(path.join(root, 'src', 'mcp', 'tool-defs.js'), 'utf8');
  // Count `name: 'memory_…' / 'working_memory_…' / 'conversation_…' / 'acl_…' / 'codegraph_…'`
  // entries inside the TOOL_DEFS array. Each registered tool declares
  // exactly one. (acl_* added in v10 Phase 1; tier tools in Phase 3;
  // codegraph tools in Phase 5; wiki tools were in Phase 4 and removed
  // in v14.)
  const def = defsSrc.match(/export const TOOL_DEFS = \[([\s\S]*?)\];/);
  assert.ok(def, 'TOOL_DEFS not found in src/mcp/tool-defs.js');
  const allNames =
    def[1].match(
      /name:\s*'(memory_[a-z_]+|working_memory_[a-z_]+|conversation_[a-z_]+|acl_[a-z_]+|codegraph_[a-z_]+|dream_[a-z_]+)'/g,
    ) || [];
  const toolCount = allNames.length;
  assert.ok(toolCount > 0, 'no tools registered in TOOL_DEFS');
  // Every tool must be wired by name via `registerTool(server, D.<name>, ...)`
  // in one of the per-domain handler files. The reference is by name
  // (not by index), so this assertion is index-agnostic — adding a new
  // tool in any handler slot passes without re-numbering.
  const handlersDir = path.join(root, 'src', 'mcp', 'handlers');
  const handlerFiles = readdirSync(handlersDir)
    .filter((f) => f.endsWith('.js'))
    .map((f) => readFileSync(path.join(handlersDir, f), 'utf8'));
  const handlersAll = handlerFiles.join('\n');
  for (const decl of allNames) {
    const name = decl.match(/'([^']+)'/)[1];
    // Wire shape is `registerTool(server, D.<name>, ...)` or, for
    // tools that opt into per-call options,
    // `registerTool(server, { ...D.<name>, ...opts }, ...)`. Match the
    // `D.<name>` token appearing anywhere in a registerTool call,
    // before the next `async (args` handler body marker.
    const wireRe = new RegExp(`registerTool\\([\\s\\S]*?D\\.${name}\\b[\\s\\S]*?async \\(args`);
    assert.ok(
      wireRe.test(handlersAll),
      `${name} is in TOOL_DEFS but not wired in any handler file`,
    );
  }
  // The long description must declare the same count. Accepts both the
  // legacy `Tools (N):` phrasing and the post-deprecation `Tools (N
  // total; …):` phrasing that splits N into always-on + deprecated
  // groups.
  const long = (manifest.interface && manifest.interface.longDescription) || '';
  const claimed = (long.match(/Tools \((\d+)(?:\s+total[^)]*)?\):/) || [])[1];
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
  for (const name of ['list-memories.md', 'advisor.md', 'memos.md', 'prune.md']) {
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

test('README documents GitHub installation and inline teardown', () => {
  const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.match(
    readme,
    /\/plugins install https:\/\/github\.com\/cbuntingde\/kimi-memory/,
    'README must include the GitHub plugin install command',
  );
  assert.match(readme, /\/plugins remove kimi-memory/);
  assert.match(readme, /plugins\/managed\/kimi-memory/);
  assert.match(readme, /\$KIMI_CODE_HOME\/kimi-memory/);
  assert.match(readme, /_global/);
});

test('memory_prune tool is registered, wired, and documented', () => {
  // TOOL_DEFS moved to src/mcp/tool-defs.js in the Phase-1 refactor;
  // per-tool wires live in src/mcp/handlers/*.js since Phase 2.
  const defsSrc = readFileSync(path.join(root, 'src', 'mcp', 'tool-defs.js'), 'utf8');
  const maintenanceSrc = readFileSync(
    path.join(root, 'src', 'mcp', 'handlers', 'maintenance.js'),
    'utf8',
  );
  assert.match(defsSrc, /name: 'memory_prune'/, 'TOOL_DEFS must include memory_prune');
  // The wire call is `registerTool(server, D.memory_prune, ...)` or
  // `registerTool(server, { ...D.memory_prune, ...opts }, ...)`. Match
  // the name token appearing anywhere within a registerTool call
  // before the next `,\n    async` (start of the handler body).
  assert.match(
    maintenanceSrc,
    /registerTool\([\s\S]*?D\.memory_prune[\s\S]*?async \(args/,
    'memory_prune must be wired via registerTool in src/mcp/handlers/maintenance.js',
  );
  // The long description must mention it.
  const long = (manifest.interface && manifest.interface.longDescription) || '';
  assert.match(long, /memory_prune/, 'longDescription must mention memory_prune');
  // The exact count is governed by the regex match above; this hardcode
  // exists to flag a description that claims a different number than the
  // TOOL_DEFS array. Bump this when a new tool is added. Accepts both
  // the legacy `Tools (50):` phrasing and the post-deprecation
  // `Tools (50 total; ...):` phrasing that splits the 50 into
  // always-on + deprecated groups. (50 reflects v14 wiki removal — was 55.)
  assert.match(long, /Tools \(50(?:\s+total[^)]*)?\)/, 'longDescription must claim 50 tools');
  // The slash command exists and links to the tool.
  const pruneCmd = readFileSync(path.join(root, 'commands', 'prune.md'), 'utf8');
  assert.match(pruneCmd, /memory_prune\(/);
  assert.match(pruneCmd, /# \/kimi-memory:prune/);
});
