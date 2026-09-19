// Guards the plugin's slash-command surface against drift between the
// three places a command name is written down: the file name under
// commands/, the frontmatter `name:` field, and every `/kimi-memory:<x>`
// reference in the docs and the manifest.
//
// Per the plugin docs, a command file's `name` defaults to its path
// relative to the declared commands directory (without .md) but a
// frontmatter `name:` overrides it. That override is exactly how a
// command ends up advertised under a name nothing can invoke, so both
// facts are pinned here: the frontmatter must agree with the file name,
// and every documented reference must resolve to a declared command.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
import { pluginRoot } from './_helpers.js';

const root = pluginRoot();
const commandsDir = path.join(root, 'commands');
const manifest = JSON.parse(readFileSync(path.join(root, 'kimi.plugin.json'), 'utf8'));

const NAMESPACE = 'kimi-memory:';

// A plugin command id is the frontmatter `name:` when present, otherwise
// the file's path relative to the commands directory minus `.md`.
function declaredCommands() {
  const out = [];
  for (const file of readdirSync(commandsDir)) {
    if (!file.endsWith('.md')) continue;
    const body = readFileSync(path.join(commandsDir, file), 'utf8');
    const frontmatter = body.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const named = frontmatter && frontmatter[1].match(/^name:[ \t]*(.+?)[ \t]*$/m);
    out.push({
      file,
      stem: file.replace(/\.md$/, ''),
      body,
      name: named ? named[1] : file.replace(/\.md$/, ''),
    });
  }
  return out;
}

function walkDocs(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkDocs(full, out);
    else if (/\.(md|json)$/.test(entry.name)) out.push(full);
  }
  return out;
}

test('every command file is named after the command it registers', () => {
  const commands = declaredCommands();
  assert.ok(commands.length > 0, 'expected at least one command file');
  for (const cmd of commands) {
    assert.equal(
      cmd.name,
      cmd.stem,
      `commands/${cmd.file} declares name: ${cmd.name}, but its file name registers ` +
        `"${cmd.stem}" when the frontmatter is absent — keep the two identical so the ` +
        `command id does not silently depend on the override`,
    );
  }
});

test('each command heading advertises the id it actually registers', () => {
  for (const cmd of declaredCommands()) {
    const heading = cmd.body.match(/^#\s+\/kimi-memory:(\S+)/m);
    if (!heading) continue;
    assert.equal(
      heading[1],
      cmd.name,
      `commands/${cmd.file} is headed "${heading[1]}" but registers as "${cmd.name}"`,
    );
  }
});

test('every documented /kimi-memory:<name> reference resolves to a command', () => {
  const declared = new Set(declaredCommands().map((c) => c.name));
  // Forward-looking docs only. CHANGELOG.md is deliberately excluded: a
  // changelog has to be able to quote the broken spelling it is reporting,
  // so scanning it would flag every entry that documents a command rename.
  const files = [
    ...['README.md', 'AGENTS.md', 'CONTRIBUTING.md', 'SECURITY.md']
      .map((f) => path.join(root, f))
      .filter((f) => {
        try {
          readFileSync(f);
          return true;
        } catch {
          return false;
        }
      }),
    path.join(root, 'kimi.plugin.json'),
    ...walkDocs(commandsDir),
    ...walkDocs(path.join(root, 'skills')),
  ];

  const unresolved = [];
  // Excludes '.' from the id charset so a sentence-ending period
  // ("…/kimi-memory:memos.") is not read as part of the command name.
  const ref = new RegExp('/' + NAMESPACE + '([A-Za-z0-9_-]+)', 'g');
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(ref)) {
      if (!declared.has(match[1])) {
        unresolved.push(`${path.relative(root, file)} → /${NAMESPACE}${match[1]}`);
      }
    }
  }
  assert.deepEqual(
    unresolved,
    [],
    'these references point at a command no file registers; declared ids are: ' +
      [...declared].sort().join(', '),
  );
});

test('the manifest points its commands field at the commands directory', () => {
  const declared = manifest.commands;
  assert.ok(declared, 'kimi.plugin.json must declare commands');
  const paths = Array.isArray(declared) ? declared : [declared];
  for (const p of paths) {
    assert.match(p, /^\.\//, `commands path must be relative to the plugin root: ${p}`);
  }
  assert.ok(paths.includes('./commands/'), 'expected ./commands/ in the commands field');
});
