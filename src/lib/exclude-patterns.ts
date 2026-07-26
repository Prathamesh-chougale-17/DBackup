import { Minimatch } from "minimatch";

/**
 * Compiled patterns keyed by their source string, since a source's exclude list is matched
 * against every file it walks - a tree with 100k entries otherwise recompiles the same handful
 * of globs 100k times over. Unbounded, but bounded in practice by how many distinct pattern
 * strings ever appear across a process's lifetime, which is a handful per job.
 */
const compiled = new Map<string, Minimatch>();

function getCompiled(pattern: string): Minimatch {
    let mm = compiled.get(pattern);
    if (!mm) {
        mm = new Minimatch(pattern, { dot: true, matchBase: true });
        compiled.set(pattern, mm);
    }
    return mm;
}

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
    return patterns.some((pattern) => pattern.trim().length > 0 && getCompiled(pattern).match(relativePath));
}
