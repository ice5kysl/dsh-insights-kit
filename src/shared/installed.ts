/**
 * Shared pure helpers for reducing Cordis Loader inventory entries to the
 * set of third-party installed plugin package names.
 *
 * Lives in src/shared (no `node` or `dom` globals) so the browser face and
 * the smoke test import the same implementation.
 *
 * @module dsh-insights-kit/installed
 */

/** Minimal inventory-entry shape the mapping needs (mirrors the Remote row). */
export interface InstalledEntry {
  readonly moduleName: string
  readonly enabled: boolean
}

/**
 * Reduce a Loader module specifier to an npm package name guess: scoped and
 * plain names pass through (subpaths trimmed); path-like specifiers (local
 * `dsh plugin add <path>` installs, incl. `link:`-prefixed ones) reduce to
 * their basename.
 */
export function npmNameOfModule(moduleName: string): string {
  // Local link installs arrive as `link:<path>` — strip the scheme and let
  // the path-like branch below reduce the remainder to its basename.
  const specifier = moduleName.startsWith('link:') ? moduleName.slice('link:'.length) : moduleName
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/')
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier
  }
  if (/^[./~]/.test(specifier) || specifier.includes('\\') || /^[A-Za-z]:/.test(specifier)) {
    return specifier.split(/[\\/]/).filter(Boolean).pop() ?? specifier
  }
  const slash = specifier.indexOf('/')
  return slash < 0 ? specifier : specifier.slice(0, slash)
}

/** npm package-name shape (scoped or plain); anything else is not a package. */
const NPM_NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i

/**
 * Distill the raw inventory into the set of third-party installed plugin
 * package names: enabled entries only, the official `@deepseek-ai/*`
 * baseline excluded (the corpus does not score the shell itself), deduped
 * and sorted for a stable audit request.
 *
 * Loader-internal pseudo entries (e.g. `cordis:include`) and anything that
 * does not look like an npm package name after reduction are dropped — they
 * are not installable plugins and would only pollute the audit batch.
 */
export function installedPluginNames(entries: readonly InstalledEntry[]): string[] {
  const names = new Set<string>()
  for (const entry of entries) {
    if (!entry.enabled) continue
    const name = npmNameOfModule(entry.moduleName)
    if (!name || name.includes(':') || !NPM_NAME_RE.test(name)) continue
    if (name.startsWith('@deepseek-ai/')) continue
    names.add(name)
  }
  return [...names].sort()
}
