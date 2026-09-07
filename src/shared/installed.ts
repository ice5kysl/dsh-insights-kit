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
 * `dsh plugin add <path>` installs) reduce to their basename.
 */
export function npmNameOfModule(moduleName: string): string {
  if (moduleName.startsWith('@')) {
    const parts = moduleName.split('/')
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : moduleName
  }
  if (/^[./~]/.test(moduleName) || moduleName.includes('\\') || /^[A-Za-z]:/.test(moduleName)) {
    return moduleName.split(/[\\/]/).filter(Boolean).pop() ?? moduleName
  }
  const slash = moduleName.indexOf('/')
  return slash < 0 ? moduleName : moduleName.slice(0, slash)
}

/**
 * Distill the raw inventory into the set of third-party installed plugin
 * package names: enabled entries only, the official `@deepseek-ai/*`
 * baseline excluded (the corpus does not score the shell itself), deduped
 * and sorted for a stable audit request.
 */
export function installedPluginNames(entries: readonly InstalledEntry[]): string[] {
  const names = new Set<string>()
  for (const entry of entries) {
    if (!entry.enabled) continue
    const name = npmNameOfModule(entry.moduleName)
    if (!name || name.startsWith('@deepseek-ai/')) continue
    names.add(name)
  }
  return [...names].sort()
}
