// Integration test for the real MiniLM embedding pipeline. Gated on
// KIMI_MEMORY_INTEGRATION_EMBED=1 so the default `npm test` stays
// fast (no Hugging Face download). Enable in CI by either exporting
// the env var or running `npm run test:integration`.
//
// What this test exercises that the unit suite cannot:
//   - The Xenova/all-MiniLM-L6-v2 model download + load path.
//   - The full hybrid FTS5 + cosine merge with real vectors
//     (~384-dim, float32, L2-normalised).
//   - End-to-end MCP save → recall ranking.
//
// To keep CI time bounded we use a small 3-memory smoke test: a
// query close to two pre-seeded memories ranks them above an
// unrelated third memory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkTempHome, rmRf, StdioMcp } from './_helpers.js';

const ENABLED = process.env.KIMI_MEMORY_INTEGRATION_EMBED === '1';
const SKIP_REASON = 'set KIMI_MEMORY_INTEGRATION_EMBED=1 to enable real-encoder integration tests';

test('real MiniLM encoder ranks semantically-related memories above unrelated ones', {
  skip: ENABLED ? false : SKIP_REASON,
}, async () => {
  const home = mkTempHome();
  // Force the embeddings pipeline on for the child MCP server, even
  // though _helpers.js sets KIMI_MEMORY_EMBEDDINGS=off for the
  // parent process.
  const mcp = new StdioMcp({ home, envExtra: { KIMI_MEMORY_EMBEDDINGS: 'on' } });
  mcp.start();
  try {
    await mcp.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'embed-int', version: '0' },
    });
    const cwd = 'C:/projects/embed-int-' + Date.now();

    // Two semantically related memories + one unrelated. The first
    // two share the encoder's "convention / repository rules" topic;
    // the third is unrelated noise.
    const relatedA = await mcp.toolCall('memory_save', {
      cwd,
      type: 'semantic',
      title: 'tabs vs spaces policy',
      content: 'Use four spaces for indentation. Tabs are forbidden in this repository.',
      tags: ['style', 'indent'],
    });
    const relatedB = await mcp.toolCall('memory_save', {
      cwd,
      type: 'semantic',
      title: 'line length',
      content: 'Hard-wrap lines at 100 characters. Long URLs are the only exception.',
      tags: ['style'],
    });
    const unrelated = await mcp.toolCall('memory_save', {
      cwd,
      type: 'semantic',
      title: 'lunch order',
      content: 'The team orders pizza from Antonio every Friday at noon.',
      tags: ['off-topic'],
    });

    // Give the async embedding microtask a moment to land (the
    // encoder is slow on first call because of model load).
    await new Promise((r) => setTimeout(r, 4000));

    const r = await mcp.toolCall('memory_recall', {
      cwd,
      query: 'indentation and formatting rules for this repository',
      limit: 3,
    });
    const ids = (r.memories || []).map((m) => m.id);
    // The unrelated memory must rank below the two related entries.
    const unrelatedIdx = ids.indexOf(unrelated.id);
    assert.ok(
      unrelatedIdx === ids.length - 1 || unrelatedIdx === -1,
      `unrelated memory should rank lowest, got order: ${ids.join(', ')}`,
    );
    assert.ok(
      ids.includes(relatedA.id) && ids.includes(relatedB.id),
      'both related memories should appear in the recall',
    );
  } finally {
    mcp.stop();
    rmRf(home);
  }
});
