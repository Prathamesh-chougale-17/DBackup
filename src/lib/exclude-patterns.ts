import { minimatch } from "minimatch";

/**
 * Returns true if relativePath matches any of the given glob patterns.
 *
 * matchBase lets a slash-free pattern (e.g. "*.tmp") match against the basename at any depth,
 * while a pattern containing a slash (e.g. "cache/**") matches the full relative path.
 *
 * Lives in its own module because both the collection path (which applies exclusions) and the
 * summary that reports them need it - having the summary import from the adapter layer would
 * make the two depend on each other in a circle.
 */
export function matchesAnyExcludePattern(relativePath: string, patterns?: string[]): boolean {
    if (!patterns || patterns.length === 0) return false;
    return patterns.some((pattern) => pattern.trim().length > 0 && minimatch(relativePath, pattern, { dot: true, matchBase: true }));
}
