/**
 * Ordering rules for deleting several backups at once.
 *
 * A snapshot in an incremental chain references bytes living in earlier archives, so
 * deleting an earlier member makes every later one unrestorable. Single deletion refuses
 * outright when a dependent exists. That refusal is right for one file but wrong for a
 * batch: asked to delete a whole chain, every member except the last would be refused for
 * depending on members that are also about to go.
 *
 * The fix is order, not an exemption. Delete newest-first inside each chain folder and by
 * the time a member is reached its dependents are already gone, so the same guard passes
 * honestly. Selecting only part of a chain still gets refused, which is the point.
 *
 * Pure so the ordering can be tested without a storage backend.
 */

import { chainFolderOf, isBackupFile } from "@/lib/core/backup-files";

/** The key non-chain paths are grouped under. */
const FLAT = null;

/**
 * Groups paths by their chain folder. Flat backups collect under `null`.
 */
export function groupByChainFolder(paths: string[]): Map<string | null, string[]> {
    const groups = new Map<string | null, string[]>();

    for (const path of paths) {
        const folder = chainFolderOf(path) ?? FLAT;
        const existing = groups.get(folder);
        if (existing) existing.push(path);
        else groups.set(folder, [path]);
    }

    return groups;
}

/**
 * Orders a batch so that chain members are deleted newest-first.
 *
 * Flat backups keep the order they arrived in, and each chain group stays where its first
 * member appeared, so the result still reads like the user's selection.
 */
export function orderPathsForDelete(paths: string[]): string[] {
    const groups = groupByChainFolder(paths);
    const ordered: string[] = [];

    for (const [folder, members] of groups) {
        if (folder === FLAT) {
            ordered.push(...members);
            continue;
        }
        // Descending by filename. The runner's names sort chronologically, which is the
        // same comparison the dependency check uses.
        ordered.push(...[...members].sort((a, b) => (fileNameOf(a) < fileNameOf(b) ? 1 : -1)));
    }

    return ordered;
}

/**
 * Members of a chain folder that would lose their data if `selfName` were deleted.
 *
 * Anything sorting after the archive counts as dependent, since the folder layout is the
 * chain and being conservative here costs only a refusal. Paths already deleted in this
 * batch are excluded, which is what makes deleting a whole chain possible.
 */
export function dependentsOf(
    siblingNames: string[],
    selfName: string,
    alreadyDeleted: ReadonlySet<string> = new Set()
): string[] {
    return siblingNames
        .filter((name) => isBackupFile(name))
        .filter((name) => name > selfName)
        .filter((name) => !alreadyDeleted.has(name))
        .sort();
}

/** Last path segment, with Windows separators normalised. */
export function fileNameOf(filePath: string): string {
    const normalized = filePath.replace(/\\/g, "/");
    return normalized.slice(normalized.lastIndexOf("/") + 1);
}
