// Regression tests for two MCP-surface defects found by the security
// audit.
//
//   1. `memory_diagnostics` was a dead tool. Its schema has no `cwd`
//      (it reads the cross-project diagnostics log, not a project DB),
//      but `registerTool` resolved a project root unconditionally, so
//      every call failed with {"error":"project cwd is required"}.
//
//   2. `registerTool` returned the raw driver error to the client,
//      including its absolute filesystem path. A reproduced example:
//        memory_reset_project ->
//        {"error":"no project DB at C:\\Users\\<user>\\…\\<key>\\memory.sqlite"}
//      which leaks the home layout and the project key to the model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkTempHome, rmRf, StdioMcp, writeRaw } from './_helpers.js';

function init(mcp) {
  return mcp.call('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  });
}

// A home-absolute path shape that must never reach the client.
const PATH_SHAPE = /(?:[A-Za-z]:[\\/]|\/(?:home|Users|tmp)\/)/;

test('memory_diagnostics is callable end-to-end without a cwd', async () => {
  const home = mkTempHome('km-diagtool-');
  const mcp = new StdioMcp({ home });
  mcp.start();
  try {
    await init(mcp);
    // Seed one log record the way the hooks would, then ask for it.
    writeRaw(
      path.join(home, 'kimi-memory', '_diagnostics', 'hooks.log'),
      JSON.stringify({
        timestamp: new Date().toISOString(),
        type: 'hook_error',
        event: 'SessionStart',
        hook_name: 'session-start.js',
        error_code: 'boom',
        error_message: 'seeded for the diagnostics-tool regression test',
      }) + '\n',
    );

    const out = await mcp.toolCall('memory_diagnostics', { hours_back: 24, limit: 10 });
    assert.ok(!out.isError, 'diagnostics call must succeed without a cwd');
    const json = JSON.parse(out.content[0].text);
    assert.equal(json.error, undefined, 'no error in the payload');
    assert.equal(json.operation, 'diagnostics');
    assert.ok(
      json.recent_logs.some(
        (r) => r.error_message === 'seeded for the diagnostics-tool regression test',
      ),
      'the seeded record is returned',
    );
    assert.equal(
      json.error_summary['hook_error:boom'],
      1,
      'error summary counts the seeded record',
    );
  } finally {
    mcp.stop();
    rmRf(home);
  }
});

test('memory_diagnostics does not disclose the absolute log location', async () => {
  const home = mkTempHome('km-diagloc-');
  const mcp = new StdioMcp({ home });
  mcp.start();
  try {
    await init(mcp);
    const out = await mcp.toolCall('memory_diagnostics', {});
    assert.ok(!out.isError);
    const json = JSON.parse(out.content[0].text);
    assert.equal(json.log_location, '<kimi-code-home>/kimi-memory/_diagnostics/hooks.log');
    assert.equal(PATH_SHAPE.test(json.log_location), false, 'log_location must stay relative');
    assert.equal(json.log_location.includes(home), false, 'temp home must not appear');
  } finally {
    mcp.stop();
    rmRf(home);
  }
});

test('MCP errors are scrubbed of absolute paths before reaching the client', async () => {
  const home = mkTempHome('km-errscrub-');
  const projectRoot = mkTempHome('km-errscrub-proj-');
  const mcp = new StdioMcp({ home });
  mcp.start();
  try {
    await init(mcp);
    // The project has never been written to, so the handler throws a
    // ToolError whose message embeds the on-disk DB path.
    const out = await mcp.toolCall('memory_reset_project', { cwd: projectRoot, confirm: true });
    assert.ok(out.isError, 'reset against a missing DB is an error');
    const json = JSON.parse(out.content[0].text);
    assert.match(json.error, /no project DB/, 'the reason survives the scrub');
    assert.equal(PATH_SHAPE.test(json.error), false, 'no absolute path in the error');
    assert.equal(json.error.includes(home), false, 'home path must not appear');
    assert.equal(json.error.includes(projectRoot), false, 'project path must not appear');
  } finally {
    mcp.stop();
    rmRf(home);
    rmRf(projectRoot);
  }
});
