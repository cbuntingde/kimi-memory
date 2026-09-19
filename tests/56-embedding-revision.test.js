// Pins the embedding-model revision integrity classification. The
// plugin's only supply-chain control for the model it downloads is
// pinning `KIMI_MEMORY_EMBEDDING_REVISION` to an immutable commit
// SHA. A branch name or tag is a *movable* ref that looks like a pin
// but guarantees nothing, so `describeEmbeddingIntegrity()` must
// classify those as unpinned rather than reporting a false "pinned".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeEmbeddingIntegrity } from '../src/embedding.js';

function withRevision(value, fn) {
  const previous = process.env.KIMI_MEMORY_EMBEDDING_REVISION;
  try {
    if (value === undefined) delete process.env.KIMI_MEMORY_EMBEDDING_REVISION;
    else process.env.KIMI_MEMORY_EMBEDDING_REVISION = value;
    return fn();
  } finally {
    if (previous === undefined) delete process.env.KIMI_MEMORY_EMBEDDING_REVISION;
    else process.env.KIMI_MEMORY_EMBEDDING_REVISION = previous;
  }
}

const SHA = '0123456789abcdef0123456789abcdef01234567';

test('unset revision defaults to main and is reported unpinned', () => {
  withRevision(undefined, () => {
    const r = describeEmbeddingIntegrity();
    assert.equal(r.revision, 'main');
    assert.equal(r.pinned, false);
    assert.equal(r.reason, 'unset_defaults_to_main');
  });
});

test('a 40-char hex commit SHA is reported pinned', () => {
  withRevision(SHA, () => {
    const r = describeEmbeddingIntegrity();
    assert.equal(r.revision, SHA);
    assert.equal(r.pinned, true);
    assert.equal(r.reason, 'commit_sha');
  });
});

test('an uppercase 40-char hex SHA is reported pinned', () => {
  withRevision(SHA.toUpperCase(), () => {
    const r = describeEmbeddingIntegrity();
    assert.equal(r.pinned, true);
    assert.equal(r.reason, 'commit_sha');
  });
});

test('a branch name is a movable ref and is NOT reported pinned', () => {
  for (const ref of ['main', 'master', 'v1', 'refs/pr/3']) {
    withRevision(ref, () => {
      const r = describeEmbeddingIntegrity();
      assert.equal(r.revision, ref);
      assert.equal(r.pinned, false, `${ref} must not be reported pinned`);
      assert.equal(r.reason, 'mutable_ref');
    });
  }
});

test('an abbreviated short SHA is NOT reported pinned', () => {
  // 39 chars, 7 chars — anything short of a full 40-char hex is movable
  // or ambiguous and gets no integrity guarantee.
  withRevision(SHA.slice(0, 7), () => {
    const r = describeEmbeddingIntegrity();
    assert.equal(r.pinned, false);
    assert.equal(r.reason, 'mutable_ref');
  });
  withRevision(SHA.slice(0, 39), () => {
    const r = describeEmbeddingIntegrity();
    assert.equal(r.pinned, false);
    assert.equal(r.reason, 'mutable_ref');
  });
});

test('empty / whitespace-only revision falls back to the default', () => {
  for (const v of ['', '   ']) {
    withRevision(v, () => {
      const r = describeEmbeddingIntegrity();
      assert.equal(r.revision, 'main');
      assert.equal(r.pinned, false);
      assert.equal(r.reason, 'unset_defaults_to_main');
    });
  }
});

test('surrounding whitespace on a SHA does not defeat the pin', () => {
  withRevision(`  ${SHA}  `, () => {
    const r = describeEmbeddingIntegrity();
    assert.equal(r.revision, SHA);
    assert.equal(r.pinned, true);
  });
});
