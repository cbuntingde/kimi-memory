// Regression coverage for the three CRITICAL audit findings that did
// not have explicit tests when shipgate-report.md was written:
//
//   C1 — symlink guard in extractCodeGraph's walker
//        (prevent arbitrary host-FS reads via an attacker-planted
//        symlink under the project root).
//   C2 — per-symbol try/catch in buildCodeGraphEdges
//        (a malformed FTS5 token must not abort the whole call).
//   C3 — pre-delete audit breadcrumb in memory_prune
//        (pruned-at.json must be written before rmSync, even on the
//        error path, so a crash mid-delete leaves a forensic trail).
//
// All three fixes were applied in the working tree (see inline
// "Audit fix CN" comments in src/). The tests below pin the
// behaviour so a future refactor cannot silently regress the
// protections.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, linkSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { mkTempHome, rmRf, writeRaw } from './_helpers.js';
import { deriveProjectKey } from '../src/project-key.js';
import { extractCodeGraph, buildCodeGraphEdges } from '../src/codegraph.js';
import { enumeratePruneCandidates } from '../src/prune.js';
import { openDb, closeDb, saveMemory, recordProjectPath } from '../src/persist.js';

function freshProject(prefix) {
  const home = mkTempHome(prefix);
  const key = deriveProjectKey(`C:/test/${prefix}-${Date.now()}`);
  return { home, key };
}

// ────────────────────────────────────────────────────────────────────
// C1 — symlink guard
// ────────────────────────────────────────────────────────────────────

test('C1: extractCodeGraph skips a symlink whose realpath escapes the project root', async (t) => {
  const { home } = freshProject('symlink-guard');
  try {
    // Build a normal project tree with one extractable file.
    const root = path.join(home, 'project-root');
    mkdirSync(path.join(root, 'src'), { recursive: true });
    writeRaw(path.join(root, 'src', 'app.js'), 'export function greet() { return 1; }');

    // Build an "outside" directory and a file under it.
    const outside = path.join(home, 'outside-target');
    mkdirSync(outside, { recursive: true });
    writeRaw(path.join(outside, 'evil.js'), 'export function readSecets() { return 1; }');

    // Plant a symlink under project-root pointing outside. Windows
    // requires either admin or Developer Mode for symlink creation.
    // Mark the test explicitly skipped (rather than a bare `return`,
    // which reports a green pass after running zero assertions) so the
    // run shows one skipped test on a host that cannot grant the
    // privilege.
    try {
      symlinkSync(outside, path.join(root, 'sneaky'), 'dir');
    } catch (e) {
      if (e && (e.code === 'EPERM' || e.code === 'ENOTSUP' || e.code === 'EACCES')) {
        t.skip('symlinks require elevation on Windows: ' + e.code);
        return;
      }
      throw e;
    }

    const files = await extractCodeGraph(root, { limit: 50 });
    const paths = files.map((f) => f.file);

    // The normal file is found.
    assert.ok(paths.includes('src/app.js'), 'extractCodeGraph must include the on-tree file');

    // Nothing under the symlink is reachable. The realpath of the
    // symlink resolves to <home>/outside-target, which escapes the
    // project root — the guard (src/codegraph.js:182-218) must skip
    // it before descending.
    for (const p of paths) {
      assert.ok(
        !p.includes('sneaky') && !p.includes('evil'),
        `extracted file must not be under a symlink that escapes the root: ${p}`,
      );
    }
  } finally {
    rmRf(home);
  }
});

// ────────────────────────────────────────────────────────────────────
// C2 — per-symbol try/catch in buildCodeGraphEdges
// ────────────────────────────────────────────────────────────────────

test('C2: buildCodeGraphEdges survives a malformed FTS5 token in a symbol name', async () => {
  const { home, key } = freshProject('fts5-token');
  try {
    const root = path.join(home, 'project-root');
    mkdirSync(root, { recursive: true });
    writeRaw(path.join(root, 'lib.js'), 'export function greet() { return 1; }');

    const dbPath = path.join(home, 'kimi-memory', key, 'memory.sqlite');
    const db = openDb(dbPath);

    // Two memories that both reference "greet". A normal file would
    // pair them into an edge. We splice in a synthetic "bad" symbol
    // (starts with `"`, becomes a malformed FTS5 quoted phrase after
    // the doubling escape). The previous shape threw and aborted the
    // whole call; the fix (src/codegraph.js:310-322) skips the bad
    // symbol and keeps processing the rest.
    saveMemory(db, key, {
      type: 'semantic',
      title: 'greet module',
      content: 'greeting function',
    });
    saveMemory(db, key, {
      type: 'semantic',
      title: 'greet service',
      content: 'greeting flow',
    });
    const files = await extractCodeGraph(root, { limit: 50 });
    // Inject a malformed symbol alongside the real one. The walker
    // produces `[{symbols:[{name:'greet',...}]}]`; we add a symbol
    // whose name begins with a literal `"` after `.replace(/"/g,'""')`
    // yields `"""` — FTS5 sees a quoted phrase with no closing quote
    // and throws.
    files.forEach((f) => {
      f.symbols.push({ name: '"broken', kind: 'function', range: [0, 0], lang: 'js' });
    });

    // Must not throw.
    let result;
    assert.doesNotThrow(() => {
      result = buildCodeGraphEdges(db, key, files, { apply: true, kind: 'calls' });
    }, 'a malformed FTS5 token must not abort buildCodeGraphEdges');

    // The good symbol still produced its candidate edges. We have at
    // least one pair from `greet` x 2 memories.
    assert.ok(result.candidates >= 1, 'good symbols must still produce candidates');
    const edges = db.prepare('SELECT * FROM memory_edges').all();
    assert.ok(edges.length >= 1, 'good symbols must still insert edges');
  } finally {
    closeDb();
    rmRf(home);
  }
});

// ────────────────────────────────────────────────────────────────────
// C3 — pre-delete audit breadcrumb in memory_prune
// ────────────────────────────────────────────────────────────────────

test('C3: memory_prune writes pruned-at.json before rmSync for an orphan project', (t) => {
  const { home, key } = freshProject('prune-breadcrumb');
  try {
    const projectDir = path.join(home, 'kimi-memory', key);
    mkdirSync(projectDir, { recursive: true });
    const dbPath = path.join(projectDir, 'memory.sqlite');
    const db = openDb(dbPath);

    // Insert a project_paths row pointing at a directory that does
    // NOT exist on disk. With a different activeKey, our project is
    // an orphan; with scope='all-projects', it shows up as a prune
    // candidate.
    const fakeRoot = path.join(home, 'deleted-canonical-root');
    recordProjectPath(db, key, fakeRoot);
    closeDb(dbPath);

    // The breadcrumb lands *inside* projectDir, which the same code path
    // then rmSyncs — so after a successful prune it is never readable at
    // its own path. Pre-create the marker path as a hard link to a file
    // outside the directory: the implementation's writeFileSync
    // truncates the shared inode in place, so its bytes become readable
    // at the outside path, while rmSync only unlinks the directory
    // entry. A regression that moved the write after the rmSync would
    // leave the outside file empty, so the assertions below read the
    // breadcrumb the fix actually wrote instead of trusting a comment
    // about call order.
    const observed = path.join(home, 'pruned-at-observed.json');
    writeRaw(observed, '');
    try {
      linkSync(observed, path.join(projectDir, 'pruned-at.json'));
    } catch (e) {
      // Some filesystems (FAT, SMB) have no hard links. Skip explicitly
      // so the run reports one skipped test instead of a green pass that
      // asserted nothing about the breadcrumb.
      t.skip('this filesystem has no hard links: ' + (e && e.code));
      return;
    }

    // Dry-run first — survives the test loop without destructive
    // deletion, and confirms the candidate surfaces.
    const dryRun = enumeratePruneCandidates({
      home,
      activeKey: 'some-other-active-key',
      scope: 'all-projects',
      apply: false,
    });
    const dryOurRow = dryRun.candidates.find((c) => c.project_key === key);
    assert.ok(dryOurRow, 'orphan project must appear in candidates');
    assert.equal(
      dryOurRow.action,
      'would-remove',
      `dry-run should mark the orphan for removal; got action=${dryOurRow.action}`,
    );
    assert.ok(
      dryOurRow.canonical_root === fakeRoot,
      'candidate carries the recorded canonical_root',
    );
    assert.ok(
      dryOurRow.exists_on_disk === false,
      'candidate reports exists_on_disk=false (the canonical_root dir was deleted)',
    );
    assert.equal(
      readFileSync(observed, 'utf8'),
      '',
      'the dry run deletes nothing, so it must not stamp the breadcrumb',
    );

    // Now apply.
    assert.ok(existsSync(projectDir), 'project dir must exist before apply');
    const apply = enumeratePruneCandidates({
      home,
      activeKey: 'some-other-active-key',
      scope: 'all-projects',
      apply: true,
    });
    const ourRow = apply.candidates.find((c) => c.project_key === key);
    assert.ok(ourRow, 'apply run must produce a candidate for our project');
    assert.equal(
      ourRow.action,
      'removed',
      `apply=true should remove the orphan; got action=${ourRow.action}`,
    );
    assert.ok(!existsSync(projectDir), 'project dir is removed by the destructive pass');

    const raw = readFileSync(observed, 'utf8');
    assert.notEqual(raw, '', 'pruned-at.json must be written before the directory is removed');
    const marker = JSON.parse(raw);
    assert.equal(marker.project_key, key, 'breadcrumb must name the project that was pruned');
    assert.equal(marker.canonical_root, fakeRoot, 'breadcrumb must record the orphaned root');
    assert.equal(marker.reason, 'memory_prune', 'breadcrumb must record why the dir was pruned');
    assert.ok(
      typeof marker.pruned_at === 'string' && !Number.isNaN(Date.parse(marker.pruned_at)),
      `breadcrumb must carry an ISO pruned_at timestamp; got ${marker.pruned_at}`,
    );
  } finally {
    rmRf(home);
  }
});
