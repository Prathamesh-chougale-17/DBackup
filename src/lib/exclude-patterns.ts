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
    return patterns.some((pattern) => matchesExcludePattern(relativePath, pattern));
}

/** Whether one pattern matches one path. Same rules as above, for callers attributing a match. */
export function matchesExcludePattern(relativePath: string, pattern: string): boolean {
    return pattern.trim().length > 0 && getCompiled(pattern).match(relativePath);
}

/** A stand-in path segment no real file is named, used to ask a pattern about hypothetical contents. */
const PROBE_SEGMENT = "__dbackup_probe__";

/** How many levels below a directory are probed before it is considered fully excluded. */
const PROBE_DEPTH = 3;

/**
 * The pattern proving nothing under `relativeDirPath` could be kept, or undefined.
 *
 * Lets a walk skip a directory instead of listing it. That is the difference between a
 * source with a `node_modules` in it taking minutes and taking hours, because exclusions are
 * otherwise applied to a listing that has already been paid for.
 *
 * Answered by probing: the directory is prunable when a single pattern excludes a
 * hypothetical file directly inside it, one a level deeper, and one deeper still. Two rules
 * make that safe, and both were arrived at by finding the cases that break without them:
 *
 * - **One pattern must cover every depth.** `dir/*` and `dir/*\/*` together cover the first
 *   two levels, but a file three levels down is still wanted. Accepting a different pattern
 *   per depth would drop it.
 * - **A pattern matching the directory's own path counts for nothing.** `matchBase` means a
 *   slash-free pattern matches a basename at any depth, so `*.log` matches a *directory*
 *   named `foo.log` while `foo.log/notes.txt` is not excluded at all. The same holds for a
 *   bare `node_modules`, which today excludes nothing inside itself. Pruning on self-match
 *   would quietly remove those files from the backup.
 *
 * Not a proof for an adversarial glob, so it errs in the only direction it may: failing to
 * prune costs one directory listing, pruning wrongly costs files nobody notices are missing
 * until they are needed.
 */
export function canPruneDirectory(relativeDirPath: string, patterns?: string[]): string | undefined {
    if (!patterns || patterns.length === 0) return undefined;

    const base = relativeDirPath.replace(/\/+$/, "");
    if (!base) return undefined;

    return patterns.find((pattern) => {
        if (pattern.trim().length === 0) return false;
        const mm = getCompiled(pattern);
        for (let depth = 1; depth <= PROBE_DEPTH; depth++) {
            const probe = `${base}/${Array<string>(depth).fill(PROBE_SEGMENT).join("/")}`;
            if (!mm.match(probe)) return false;
        }
        return true;
    });
}
