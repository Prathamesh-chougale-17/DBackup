import fs from "fs/promises";
import path from "path";
import { StorageAdapter, AdapterConfig, DirectoryDownloadOptions, DirectoryDownloadResult, DirectoryFileEntry } from "@/lib/core/interfaces";
import { LogLevel, LogType } from "@/lib/core/logs";
import { mapWithConcurrency } from "@/lib/concurrency";
import { matchesAnyExcludePattern } from "@/lib/exclude-patterns";
import { summariseExcluded, formatExcludeSummary } from "@/lib/exclude-summary";

/** Strips a queried remotePath prefix from a FileInfo.path (which list() returns relative to the adapter root). */
export function toRelativePath(filePath: string, remotePath: string): string {
    const normalizedFile = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
    const normalizedRoot = remotePath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (normalizedRoot && normalizedFile.startsWith(`${normalizedRoot}/`)) {
        return normalizedFile.slice(normalizedRoot.length + 1);
    }
    if (normalizedRoot && normalizedFile === normalizedRoot) {
        return path.basename(normalizedFile);
    }
    return normalizedFile;
}

type OnProgress = (processedBytes: number, totalBytes: number, processedFiles: number, totalFiles: number) => void;
type OnLog = (msg: string, level?: LogLevel, type?: LogType, details?: string) => void;

/**
 * Generic fallback for StorageAdapter.downloadDirectory: lists the remote directory tree
 * (adapters already implement recursive list()) and downloads each file individually via
 * the adapter's existing download(). Used by every storage adapter that doesn't implement
 * downloadDirectory natively (all except Rsync, which has its own optimized implementation
 * to preserve its delta-transfer advantage).
 */

/**
 * Joins a collected file under the work directory, refusing anything that escapes it.
 *
 * Mirrors the guard the restore side already applies when extracting an archive - the
 * source listing deserves the same suspicion as an archive index.
 */
function resolveWithinRoot(root: string, relative: string): string {
    const resolvedRoot = path.resolve(root);
    const resolved = path.resolve(resolvedRoot, relative);
    if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
        throw new Error(`path escapes the collection directory`);
    }
    return resolved;
}

export async function downloadDirectoryGeneric(
    adapter: StorageAdapter,
    config: AdapterConfig,
    remotePath: string,
    localPath: string,
    excludePatterns?: string[],
    onProgress?: OnProgress,
    onLog?: OnLog,
    options?: DirectoryDownloadOptions
): Promise<DirectoryDownloadResult> {
    const allFiles = await adapter.list(config, remotePath);

    const entries: { relativePath: string; sourcePath: string; size: number; lastModified: Date }[] = [];
    const excluded: { path: string; size: number }[] = [];
    for (const file of allFiles) {
        const relativePath = toRelativePath(file.path, remotePath);
        if (matchesAnyExcludePattern(relativePath, excludePatterns)) {
            excluded.push({ path: relativePath, size: file.size });
            continue;
        }
        entries.push({ relativePath, sourcePath: file.path, size: file.size, lastModified: file.lastModified });
    }

    // Excluding files silently is the one thing a backup must not do: what is missing from a
    // backup is exactly what nobody notices until they need it. Reported per pattern rather
    // than per file - a source with a node_modules in it would otherwise write tens of
    // thousands of paths into the execution log, on every run.
    if (excluded.length > 0 && onLog) {
        const { message, details } = formatExcludeSummary(summariseExcluded(excluded, excludePatterns ?? []));
        onLog(message, "info", "storage", details);
    }

    const totalBytes = entries.reduce((sum, e) => sum + e.size, 0);
    const totalFiles = entries.length;
    let processedBytes = 0;
    let processedFiles = 0;
    let skippedFiles = 0;

    // Each file yields exactly one outcome; mapWithConcurrency keeps them in input order, so
    // the resulting entries/failures lists have the same layout the old serial loop produced,
    // independent of which download finished first.
    type Outcome =
        | { kind: "entry"; entry: DirectoryFileEntry }
        | { kind: "failure"; failure: { path: string; error: string } };

    const bump = (bytes: number) => {
        // Runs synchronously between awaits, so the shared counters stay consistent under
        // parallelism - Node never interleaves these statements.
        processedBytes += bytes;
        processedFiles++;
        onProgress?.(processedBytes, totalBytes, processedFiles, totalFiles);
    };

    // Per-file "started/finished" chatter from an adapter would put one or two lines in the
    // execution history for every file collected - hundreds of lines for a real source, which
    // is why S3 and local stay silent here. Progress is already reported per file via
    // onProgress and summarised at the end, so only warnings and errors are worth a history
    // line; those still come through.
    const fileOnLog: OnLog | undefined = onLog
        ? (msg, level, type, details) => { if (level && level !== "info") onLog(msg, level, type, details); }
        : undefined;

    const outcomes = await mapWithConcurrency(entries, options?.concurrency ?? 1, async (entry): Promise<Outcome> => {
        // Incremental backups skip files the chain already holds. They still belong to the
        // snapshot, so they are reported as unchanged rather than dropped - the archive
        // writer carries them forward by reference.
        if (options?.shouldDownload && !options.shouldDownload(entry)) {
            skippedFiles++;
            bump(0);
            return { kind: "entry", entry: { relativePath: entry.relativePath, size: entry.size, lastModified: entry.lastModified, unchanged: true } };
        }

        // The relative path comes from the remote server's listing, so it is not trusted:
        // an S3 key is stored verbatim and a WebDAV href is whatever the server sends. A
        // ".." segment would otherwise write outside the work directory during collection.
        let localFilePath: string;
        try {
            localFilePath = resolveWithinRoot(localPath, entry.relativePath);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            onLog?.(`Refused to collect '${entry.relativePath}': ${message}`, "error", "security");
            return { kind: "failure", failure: { path: entry.relativePath, error: message } };
        }
        await fs.mkdir(path.dirname(localFilePath), { recursive: true });

        const success = await adapter.download(config, entry.sourcePath, localFilePath, undefined, fileOnLog);
        if (!success) {
            // Recorded, not swallowed: the file is absent from the archive, and a backup
            // that hides that is worse than one that admits it.
            onLog?.(`Failed to download ${entry.sourcePath}`, "error", "storage");
            return { kind: "failure", failure: { path: entry.relativePath, error: "the source did not return the file" } };
        }

        bump(entry.size);
        return { kind: "entry", entry: { relativePath: entry.relativePath, size: entry.size, lastModified: entry.lastModified } };
    });

    const resultEntries: DirectoryFileEntry[] = [];
    const failures: { path: string; error: string }[] = [];
    for (const outcome of outcomes) {
        if (outcome.kind === "entry") resultEntries.push(outcome.entry);
        else failures.push(outcome.failure);
    }

    if (skippedFiles > 0) {
        onLog?.(`${skippedFiles} of ${totalFiles} file(s) unchanged, not transferred`, "info", "storage");
    }

    return { files: resultEntries.length, bytes: processedBytes, entries: resultEntries, failures };
}

/**
 * Dispatches to the adapter's native downloadDirectory() if implemented (e.g. Rsync),
 * otherwise falls back to the generic list()+download() loop.
 */
export async function downloadDirectory(
    adapter: StorageAdapter,
    config: AdapterConfig,
    remotePath: string,
    localPath: string,
    excludePatterns?: string[],
    onProgress?: OnProgress,
    onLog?: OnLog,
    options?: DirectoryDownloadOptions
): Promise<DirectoryDownloadResult> {
    if (adapter.downloadDirectory) {
        return adapter.downloadDirectory(config, remotePath, localPath, excludePatterns, onProgress, onLog, options);
    }
    return downloadDirectoryGeneric(adapter, config, remotePath, localPath, excludePatterns, onProgress, onLog, options);
}
