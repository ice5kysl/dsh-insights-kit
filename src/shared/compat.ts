/**
 * Shared pure helpers for the dsh-compat signal shown on the「体检」rows:
 * a deliberately conservative satisfaction check for the simple ^/~ version
 * ranges that dominate engines.dsh declarations.
 *
 * Prerelease tags are dropped before comparing (`0.1.1-rc.2` is treated as
 * `0.1.1`) — dsh ships almost exclusively prereleases, and matching them
 * with real semver prerelease semantics would flag nearly everything as
 * incompatible. Anything beyond a plain `^x.y.z` / `~x.y.z` range is
 * reported as undecidable (null) and the UI shows the range without a
 * verdict.
 *
 * Lives in src/shared (no `node` or `dom` globals) so the browser face and
 * the smoke test import the same implementation.
 *
 * @module dsh-insights-kit/compat
 */

export type VersionTriple = [number, number, number]

/** Base [major, minor, patch] of a semver-ish version (prerelease dropped). */
export function baseVersion(version: string): VersionTriple | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

function cmp(a: VersionTriple, b: VersionTriple): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

/**
 * Is `version` (base version, prerelease dropped) within `range`? Only
 * simple `^x.y.z` / `~x.y.z` ranges are decided (caret: <next breaking —
 * for 0.x that is the next minor, for 0.0.x the next patch; tilde: <next
 * minor). Anything else (wildcards, comparators, unions, tags) returns null.
 */
export function satisfiesSimpleRange(version: string, range: string): boolean | null {
  const m = /^([~^])\s*(\d+)\.(\d+)\.(\d+)$/.exec(range.trim())
  const base = baseVersion(version)
  if (!m || !base) return null
  const min: VersionTriple = [Number(m[2]), Number(m[3]), Number(m[4])]
  let max: VersionTriple
  if (m[1] === '~') {
    max = [min[0], min[1] + 1, 0]
  } else if (min[0] > 0) {
    max = [min[0] + 1, 0, 0]
  } else if (min[1] > 0) {
    max = [0, min[1] + 1, 0]
  } else {
    max = [0, 0, min[2] + 1]
  }
  return cmp(base, min) >= 0 && cmp(base, max) < 0
}

/** Is `current` (base, prerelease dropped) older than `latest`? Null when either is unparseable. */
export function isOutdated(current: string, latest: string): boolean | null {
  const a = baseVersion(current)
  const b = baseVersion(latest)
  if (!a || !b) return null
  return cmp(a, b) < 0
}
