/**
 * Chain bookkeeping for incremental archives.
 *
 * An incremental archive only stores what changed, but its index still describes the whole
 * tree. Unchanged files keep pointing at whichever archive already holds their bytes, so a
 * restore resolves a snapshot in a single lookup rather than replaying the chain forward.
 *
 * Everything here is pure, so the rules that decide what carries forward and which archives
 * a snapshot depends on can be tested without a runner, a storage adapter or a database.
 */

import {
    ArchiveIndex,
    CarriedIndexContent,
    entryKey,
    FileMetadata,
    IndexEntryLine,
    IndexFileLine,
    isSymlinkLine,
    metadataToIndex,
} from "./types";

/** Identifies a file within a snapshot. Paths are only unique per directory source. */
export function fileKey(src: string, path: string): string {
    // Separated by NUL, written as an escape so it stays visible in the source. It is
    // the one byte that cannot occur in a path, so the key is unambiguous.
    return `${src}\u0000${path}`;
}

/**
 * Carries unchanged files forward from the previous snapshot.
 *
 * @param previous - Parsed index of the predecessor snapshot
 * @param previousArchive - Filename of the predecessor archive
 * @param keep - Files to carry, as fileKey() values. Anything absent has been re-stored in
 * the new archive or no longer exists at the source.
 * @param freshMetadata - Permissions and ownership as the source reports them now, by
 * fileKey(). Carrying bytes forward must not carry stale metadata with them: a `chmod` or a
 * `chown` changes no content, so the file lands here rather than being re-stored, and
 * without this the chain would keep serving the mode from whenever the bytes last changed.
 * On a container volume that is the difference between a database that starts after a
 * restore and one that does not. Absent or empty entries leave the carried values alone, so
 * sources that report no metadata behave exactly as before.
 */
export function carryForward(
    previous: ArchiveIndex,
    previousArchive: string,
    keep: ReadonlySet<string>,
    freshMetadata?: ReadonlyMap<string, FileMetadata>
): CarriedIndexContent {
    const files: IndexFileLine[] = [];
    const neededEntries = new Map<string, string | undefined>();

    for (const line of previous.files) {
        const key = fileKey(line.src, line.p);
        if (!keep.has(key)) continue;

        // A symbolic link stores no bytes, so there is nothing to point back at and nothing
        // saved by trying. Every snapshot restates its links in full, which costs a few dozen
        // bytes each and keeps them out of the chain entirely. Guarded here as well as at the
        // caller: without it `entryKey(archive, undefined)` would look up ordinal NaN and fail
        // the whole incremental with a bogus "missing entry".
        if (isSymlinkLine(line)) continue;

        // A line with no `a` lives in the predecessor itself. One that already has `a`
        // was carried before and keeps pointing further back, so chains never nest.
        const archive = line.a ?? previousArchive;
        // Metadata the source reported this run wins over what the predecessor recorded.
        // A field the source did not report is left as it was, so this can only add detail,
        // never erase it. Mtime is deliberately not refreshed alongside it: carrying a file
        // forward is decided by content identity, and the existing snapshot semantics tie
        // the recorded mtime to the bytes.
        const fresh = freshMetadata?.get(key);
        files.push({ ...line, ...(fresh ? metadataToIndex(fresh) : {}), a: archive });
        neededEntries.set(entryKey(archive, line.n!), line.a);
    }

    const entries: IndexEntryLine[] = [];
    for (const [key, originalArchive] of neededEntries) {
        const ordinal = Number(key.slice(key.lastIndexOf("#") + 1));
        const archive = key.slice(0, key.lastIndexOf("#"));
        const entry = previous.entries.get(entryKey(originalArchive, ordinal));
        if (!entry) {
            throw new Error(
                `Cannot carry forward from '${previousArchive}': its index references missing entry ${ordinal}`
            );
        }
        entries.push({ ...entry, a: archive });
    }

    return { files, entries };
}

/** Archives a snapshot needs besides its own, derived from its file lines. */
export function dependenciesOf(files: readonly IndexFileLine[]): string[] {
    return [...new Set(files.map((f) => f.a).filter((a): a is string => !!a))].sort();
}

export interface ChainCompleteness {
    complete: boolean;
    /** Archives referenced by the snapshot that are not available. */
    missing: string[];
}

/**
 * Checks a snapshot against the archives actually present.
 *
 * Called before a restore starts so a gap is reported by name up front, instead of
 * surfacing halfway through as a confusing failure on an individual file.
 */
export function checkChainCompleteness(
    index: ArchiveIndex,
    availableArchives: ReadonlySet<string>
): ChainCompleteness {
    const missing = index.deps.filter((archive) => !availableArchives.has(archive));
    return { complete: missing.length === 0, missing };
}
