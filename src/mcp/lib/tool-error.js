// Typed-error seam between registerTool wrappers and per-tool handlers.
//
// Why a class instead of a magic key on the return value: every handler
// is now a plain async function whose return is wrapped in `ok(...)`.
// Surfacing a structured failure as `throw toolError(msg)` keeps the
// happy path looking like a normal function call (just `return result`)
// and the failure path looking like a thrown exception — the shape
// every handler author already expects from any async library.
//
// The wrapper in src/mcp/lib/register-tool.js catches ToolError
// specifically (before the generic catch) so the message becomes the
// user-facing textError string verbatim — no double-encoding, no
// `toError(e).error` round-trip on what is already a clean message.

export class ToolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ToolError';
  }
}

export function toolError(message) {
  return new ToolError(message);
}
