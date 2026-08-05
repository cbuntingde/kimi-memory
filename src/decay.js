// Ebbinghaus-style forgetting curve for kimi-memory.
//
// The legacy decay (src/persist/memory.js#decayMemories) scaled a
// single confidence number by elapsed days past a 30-day grace window.
// That treats every memory the same — a memory rehearsed yesterday and
// one created yesterday decay identically, which is wrong for a brain
// analog.
//
// The model here mirrors the Ebbinghaus forgetting curve, simplified:
//
//   R(t, s) = exp(-t / s)
//
//   t = days since the last rehearsal (last_rehearsed_at)
//   s = stability_days (per-row; grows geometrically on each rehearsal)
//
// A memory is "alive" when R is close to 1, "cold" when it approaches
// 0. We surface a retrievability-derived confidence in the recall
// layer (0.1 + 0.9 * R) so the recall score naturally demotes long-
// untouched rows even before the 30-day grace window ends.
//
// Stability growth: each rehearsal multiplies s by a constant factor.
// Ebbinghaus' empirical data suggests ~1.5–2x per successful recall;
// we use 1.5 to keep a memory that is recalled weekly from growing
// without bound. A hard cap of 365 days keeps a single hot memory from
// dominating the recall surface forever.
//
// This module is pure: no DB imports, no Node-only APIs except what
// `now()` is injected. Persistence callers (memory_reinforce,
// updateRetrievability) wrap these functions with their own SQL. The
// pure shape makes the formulas trivially testable.

export const STABILITY_MIN = 1; // 1 day floor so R is bounded sensibly
export const STABILITY_MAX = 365; // hard cap; one year of stability
export const STABILITY_GROWTH = 1.5; // per-rehearsal multiplier
export const STABILITY_INITIAL = 30; // matches the v9 migration default

// Floor for the retrievability-derived confidence. Matches the legacy
// DECAY_FLOOR so existing consumers do not see "everything is now
// zero" on first pass after upgrade.
export const RETRIEVAL_FLOOR = 0.1;

// Parses an ISO timestamp (or returns 0 for missing/invalid). Returns
// the *days* elapsed between the timestamp and the reference `now`.
// Negative values (future-dated rows) are clamped to 0 so a clock-skew
// glitch does not inflate the curve.
export function daysSince(iso, now) {
  if (!iso) return 0;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  const ref = now instanceof Date ? now.getTime() : Date.now();
  const ms = ref - t;
  if (ms <= 0) return 0;
  return ms / (24 * 3600 * 1000);
}

// Computes retrievability R(t, s) = exp(-t / s). Inputs are days. A
// memory with t=0 and s=30 returns 1.0; t=30, s=30 returns ~0.368;
// t=365, s=30 returns ~5e-6.
//
// `stability` is clamped to [STABILITY_MIN, STABILITY_MAX] so a row
// with stability_days=0 does not produce NaN. `days` is clamped to ≥ 0
// so future timestamps do not blow up the exp.
export function retrievability(days, stability) {
  const t = Math.max(0, Number(days) || 0);
  const s = Math.max(STABILITY_MIN, Math.min(STABILITY_MAX, Number(stability) || STABILITY_INITIAL));
  return Math.exp(-t / s);
}

// Translates retrievability into a confidence value the recall layer
// can compare. The floor (0.1) prevents fully cold memories from
// disappearing; the scale (0.9) keeps freshly-rehearsed memories at
// ~1.0 so the existing confidence ordering is preserved.
//
// `clamp01` keeps a caller that explicitly passed a manual confidence
// override from being overridden by the curve; this layer is purely
// the *derived* value. The persist layer may overwrite with the
// user's stored confidence when one is set explicitly.
export function retrievabilityToConfidence(r) {
  const clamped = Math.max(0, Math.min(1, r));
  return RETRIEVAL_FLOOR + (1 - RETRIEVAL_FLOOR) * clamped;
}

// Stability after one rehearsal. Multiplies by STABILITY_GROWTH and
// caps at STABILITY_MAX. Pass `prevStability` as null/undefined to
// grow from the initial stability (handles brand-new rows that have
// not been migrated yet, or rows created by saveMemory without a
// value). The first reinforce of a freshly-saved row should produce
// STABILITY_INITIAL * STABILITY_GROWTH, not STABILITY_MIN — a brand
// new memory has 30 days of expected durability, not 1.
export function growStability(prevStability) {
  const prev =
    prevStability == null || !Number.isFinite(prevStability)
      ? STABILITY_INITIAL
      : prevStability;
  return Math.max(STABILITY_MIN, Math.min(STABILITY_MAX, prev * STABILITY_GROWTH));
}

// Composite: given the row's current stability and the timestamp of
// the last rehearsal, compute the retrievability-derived confidence.
// Convenience wrapper for callers that don't want to chain the three
// primitives above.
//
//   `stability`       — current stability_days (number, may be null)
//   `lastRehearsedAt` — ISO string, may be null/empty
//   `now`             — Date or timestamp (defaults to Date.now())
export function derivedConfidence(stability, lastRehearsedAt, now) {
  const t = daysSince(lastRehearsedAt, now);
  const r = retrievability(t, stability);
  return retrievabilityToConfidence(r);
}
