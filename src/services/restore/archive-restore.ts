/**
 * Full restore of a seekable (manifest v2) archive, driven by byte ranges.
 *
 * Replaces the old combined-restore path, which downloaded the entire archive before
 * doing anything. Here the archive is opened remotely: on adapters with ranged reads only
 * the selected entries are ever transferred - restoring just the database out of a 60 GB
 * archive moves only the database's bytes. Adapters without ranges fall back to one full
 * download, which is exactly what the old path always cost.
 *
 * Selection is first-class: databases via the mapping, directory sources whole or as a
 * subset of paths. Nothing is extracted to disk as a whole - database dumps are staged one
 * at a time (peak disk = largest dump), directory files stream through a per-file stage
 * (peak disk = largest file).
 */

import path from "path";
import { safeRemoteJoin } from "@/lib/archive/remote-paths";
import { formatBytes } from "@/lib/utils";
import fs from "fs/promises";
import { createWriteStream } from "fs";
import crypto from "crypto";
import { pipeline } from "stream/promises";
import prisma from "@/lib/prisma";
import { registry } from "@/lib/core/registry";
import { createHost, resolveTransport } from "@/lib/transport";
import { DatabaseAdapter, StorageAdapter, AdapterConfig } from "@/lib/core/interfaces";
import { resolveAdapterConfig } from "@/lib/adapters/config-resolver";
import { LogLevel, LogType, RESTORE_STAGES } from "@/lib/core/logs";
import { shouldRestoreDatabase, getTargetDatabaseName } from "@/lib/adapters/database/common/tar-utils";
import { openArchiveEntry } from "@/lib/archive/reader";
import { createDestinationSessions } from "./destination-sessions";
import { forEachSnapshotFile, hashingStream } from "@/lib/archive/chain-source";
import { resolveTransferConcurrency } from "@/lib/adapters/transfer-concurrency";
import { resolveSelection } from "@/lib/archive/browse";
import { matchesAnyExcludePattern } from "@/lib/exclude-patterns";
import { summariseExcluded, formatExcludeSummary } from "@/lib/exclude-summary";
import { entryKey, IndexFileLine, metadataFromIndex, partitionSymlinks } from "@/lib/archive/types";
import { getTempDir } from "@/lib/temp-dir";
import { stripTrailingSlashes } from "@/lib/paths";
import { openArchiveForRestore } from "./file-restore";
import type { RestoreInput } from "./types";

/**
 * Names one entry for the error list, as "<source label>/<path>".
 *
 * A directory source's label already ends in its remote path, which for a source rooted at
 * the top is just "/" - so a plain join produced "Scripts: //link" and read like a bug in
 * the path rather than a label followed by a file.
 */
function entryLabel(sourceLabel: string, filePath: string): string {
    return `${stripTrailingSlashes(sourceLabel)}/${filePath}`;
}

export interface ArchiveRestoreCallbacks {
    log: (msg: string, level?: LogLevel, type?: LogType, details?: string) => void;
    updateDetail: (detail: string) => void;
    /** Sets the visible restore stage, so a file-only restore never shows "Restoring Databases". */
    setStage: (stage: string) => void;
}

export interface ArchiveRestoreResult {
    status: "Success" | "Partial" | "Failed";
    restoredDatabases: string[];
    restoredDirectories: string[];
    errors: { entry: string; error: string }[];
}

interface DirectoryTarget {
    adapter: StorageAdapter;
    config: AdapterConfig;
    basePath: string;
    label: string;
}

/**
 * Restores selected databases and/or directory content from a v2 archive.
 *
 * Invoked by the restore pipeline as soon as the backup's metadata identifies a seekable
 * archive - before any download has happened. Mirrors the old combined-restore semantics
 * (selection conventions, per-item error collection, Success/Partial/Failed) so the
 * pipeline's status handling is unchanged.
 */
export async function restoreArchiveSnapshot(
    input: RestoreInput,
    callbacks: ArchiveRestoreCallbacks
): Promise<ArchiveRestoreResult> {
    const { log, updateDetail, setStage } = callbacks;

    // Opens the archive remotely, reads the index (sidecar first), and verifies the chain
    // is complete - a missing sibling archive fails here, by name, before anything runs.
    const archive = await openArchiveForRestore(input.storageConfigId, input.file, input.keyOverride);

    try {
        const index = archive.index;
        log(
            archive.ranged
                ? "Archive opened with ranged reads - only the selected entries will be transferred."
                : "Destination cannot serve byte ranges - the archive is fetched once in full.",
            'info'
        );
        if (index.deps.length > 0) {
            log(`Incremental snapshot - restore reads from ${index.deps.length + 1} archives of its chain.`, 'info');
        }
        log(`Archive contains ${index.databases.length} database(s) and ${index.directories.length} directory source(s).`, 'info');

        // ── Selection (identical conventions to the old path) ────────────────
        // A scope of 'databases' or 'files' means the other half was deliberately left out
        // of this restore. It is not the same as selecting none of its entries: the
        // excluded half is not reported as skipped and does not turn the result Partial,
        // because the request never asked for it.
        const scope = input.scope ?? 'all';
        const wantsDatabases = scope !== 'files';
        const wantsFiles = scope !== 'databases';

        const dbMapping = Array.isArray(input.databaseMapping)
            ? input.databaseMapping as { originalName: string; targetName: string; selected: boolean }[]
            : undefined;
        // No mapping provided at all = restore every database entry, matching every v1
        // adapter's own convention in shouldRestoreDatabase().
        const selectedDbNames = !wantsDatabases
            ? []
            : dbMapping && dbMapping.length > 0
                ? index.databases.map((d) => d.name).filter((name) => shouldRestoreDatabase(name, dbMapping))
                : index.databases.map((d) => d.name);

        const dirMapping = input.directoryMapping ?? [];
        const selectedDirs = !wantsFiles
            ? []
            : dirMapping.length > 0
                ? index.directories.filter((d) => dirMapping.some((m) => m.entryId === d.src && m.selected))
                : index.directories;

        if (selectedDbNames.length === 0 && selectedDirs.length === 0) {
            throw new Error("No entries selected for restore");
        }

        if (scope !== 'all') {
            log(
                scope === 'databases'
                    ? "Scope: databases only - the archive's directory sources are left untouched."
                    : "Scope: files only - the archive's databases are left untouched.",
                'info'
            );
        }

        const restoredDatabases: string[] = [];
        const restoredDirectories: string[] = [];
        /** Sources where some files arrived and some did not - enough to rule out "Failed". */
        const partiallyRestoredDirectories = new Set<string>();
        const errors: { entry: string; error: string }[] = [];

        // ── Databases ─────────────────────────────────────────────────────────
        if (selectedDbNames.length > 0) {
            setStage(RESTORE_STAGES.RESTORING_DATABASES);
            await restoreDatabases(input, archive, selectedDbNames, dbMapping, restoredDatabases, errors, callbacks);
        }

        // ── Directory sources ─────────────────────────────────────────────────
        if (selectedDirs.length > 0) {
            setStage(RESTORE_STAGES.RESTORING_FILES);
            // Resolve every target up front, so a misconfigured source is reported before
            // any bytes move rather than midway through.
            const targets = new Map<string, DirectoryTarget>();
            const excludePatterns = (input.excludePatterns ?? []).filter((p) => p.trim().length > 0);
            const workItems: { src: string; file: IndexFileLine }[] = [];
            const perSourceTotals = new Map<string, number>();
            const labels = new Map(index.directories.map((d) => [d.src, d.label]));

            for (const dir of selectedDirs) {
                const mappingEntry = dirMapping.find((m) => m.entryId === dir.src);
                if (!mappingEntry?.targetConfigId) {
                    errors.push({ entry: `directory:${dir.label}`, error: "No restore target specified" });
                    log(`Skipping directory '${dir.label}': no restore target specified`, 'warning', 'storage');
                    continue;
                }

                try {
                    const targetConfig = await prisma.adapterConfig.findUnique({ where: { id: mappingEntry.targetConfigId } });
                    if (!targetConfig || targetConfig.type !== "storage") {
                        throw new Error("Restore target adapter not found");
                    }
                    const targetAdapter = registry.get(targetConfig.adapterId) as StorageAdapter | undefined;
                    if (!targetAdapter) {
                        throw new Error("Restore target adapter implementation missing");
                    }

                    const basePath = mappingEntry.targetPath || dir.label;
                    targets.set(dir.src, {
                        adapter: targetAdapter,
                        config: await resolveAdapterConfig(targetConfig),
                        basePath,
                        label: `${targetConfig.name}:${basePath}`,
                    });
                } catch (e: unknown) {
                    const message = e instanceof Error ? e.message : String(e);
                    errors.push({ entry: `directory:${dir.label}`, error: message });
                    log(`Failed to resolve restore target for '${dir.label}': ${message}`, 'error', 'storage');
                    continue;
                }

                // A subset of paths when the user picked one, the whole source otherwise.
                const selectedFiles = mappingEntry.paths && mappingEntry.paths.length > 0
                    ? resolveSelection(index, dir.src, mappingEntry.paths)
                    : index.files.filter((f) => f.src === dir.src);

                // Excluded files are dropped here rather than counted as failures: they were
                // never meant to be written, so they must not colour the run's status.
                const files: IndexFileLine[] = [];
                const excluded: { path: string; size: number }[] = [];
                for (const file of selectedFiles) {
                    if (excludePatterns.length > 0 && matchesAnyExcludePattern(file.p, excludePatterns)) {
                        excluded.push({ path: file.p, size: file.s });
                    } else {
                        files.push(file);
                    }
                }

                perSourceTotals.set(dir.src, files.length);
                for (const file of files) workItems.push({ src: dir.src, file });

                log(
                    `Directory '${dir.label}': restoring ${files.length} of ${dir.fileCount} file(s) to ${targets.get(dir.src)!.label}`,
                    'info', 'storage'
                );

                // Which patterns took what, expandable in the log viewer. Grouped per pattern
                // rather than listed per file, so a source with thousands of matches does not
                // put thousands of lines into the execution record.
                if (excluded.length > 0) {
                    const { message, details } = formatExcludeSummary(summariseExcluded(excluded, excludePatterns));
                    log(`${dir.label}: ${message}`, 'info', 'storage', details);
                }
            }

            const perSourceDone = new Map<string, number>();
            const perSourceFailed = new Map<string, number>();
            /**
             * Symbolic links the destination cannot hold, counted apart from failures.
             *
             * They still make the run Partial - something in the snapshot is not there - but
             * calling them failures in the summary would read as "the upload broke", when the
             * truth is that this destination has no such thing as a symbolic link.
             */
            const perSourceSkippedLinks = new Map<string, number>();
            let done = 0;
            // Bytes as well as a file count, so a restore reads like the backup that produced it.
            // The sizes are already in the index, they were simply never added up here - a restore
            // of one huge file otherwise looked frozen at "0/1".
            const totalBytes = workItems.reduce((sum, item) => sum + (item.file.s ?? 0), 0);
            let doneBytes = 0;
            const detailText = () => (totalBytes > 0
                ? `Files: ${done}/${workItems.length} restored, ${formatBytes(doneBytes)}/${formatBytes(totalBytes)}`
                : `Files: ${done}/${workItems.length} restored`);

            // Files stream and stage independently, so several transfer at once - this is the
            // network round-trip win the user sees restoring to S3/R2. An adapter that cannot
            // use parallel writes (Dropbox serialises them) caps it, so the setting never
            // forces a destination into a retry queue.
            // Write-back stages each file independently, so several run at once - the round-trip
            // win when restoring to a network destination. Each target states how many it can take;
            // the files of every target share one pipeline, so the smallest wins. Anything else
            // would push a rate-limited destination past what it said it could handle in order to
            // keep a faster one busy.
            const concurrency = Math.min(
                ...[...targets.values()].map((t) => resolveTransferConcurrency(t.adapter.id, t.config)),
            );
            // Links have no entry to read and are recreated after every file has landed, the
            // same order extractArchiveFrom() uses and for the same security reason.
            const { payloads, symlinks } = partitionSymlinks(workItems);

            const sessions = createDestinationSessions(concurrency, log);
            try {
                await forEachSnapshotFile(archive, payloads, async (file, content) => {
                    const target = targets.get(file.src)!;
                    const stagePath = path.join(getTempDir(), `restore-${process.pid}-${crypto.randomUUID()}`);
                    let digest: string | undefined;

                    try {
                        await pipeline(content, hashingStream((d) => { digest = d; }), createWriteStream(stagePath));

                        // For unencrypted archives this is the only integrity check the file
                        // gets - there is no AEAD tag protecting its bytes.
                        if (file.h && digest && digest !== file.h) {
                            throw new Error(`Checksum mismatch: expected ${file.h}, got ${digest}`);
                        }

                        const remotePath = safeRemoteJoin(target.basePath, file.p);
                        // Forward the adapter's own warnings and errors (a rate-limit retry, a real
                        // rejection) into the restore log; the per-file "started/finished" info is
                        // dropped so a large restore does not bury the history.
                        const uploadOk = await sessions.upload(
                            target, stagePath, remotePath,
                            (msg, level, type, details) => { if (level && level !== 'info') log(`${file.p}: ${msg}`, level, type ?? 'storage', details); },
                            metadataFromIndex(file)
                        );
                        if (!uploadOk) {
                            throw new Error(`Adapter '${target.adapter.id}' rejected the upload`);
                        }

                        perSourceDone.set(file.src, (perSourceDone.get(file.src) ?? 0) + 1);
                    } catch (e: unknown) {
                        const message = e instanceof Error ? e.message : String(e);
                        perSourceFailed.set(file.src, (perSourceFailed.get(file.src) ?? 0) + 1);
                        errors.push({ entry: entryLabel(labels.get(file.src) ?? file.src, file.p), error: message });
                        log(`Failed to restore '${file.p}' to ${target.label}: ${message}`, 'error', 'storage');
                    } finally {
                        await fs.unlink(stagePath).catch(() => { });
                    }

                    done++;

                    doneBytes += file.s ?? 0;
                    updateDetail(detailText());
                }, concurrency);

                // Symbolic links, once every regular file is in place.
                for (const { src, file } of symlinks) {
                    const target = targets.get(src)!;
                    const label = labels.get(src) ?? src;
                    const link = `'${file.p}' -> '${file.lnk}'`;

                    // A destination without symbolic links is a capability limit, not a
                    // transfer that went wrong: retrying it will never behave differently.
                    // Said once, at warning level, and with the destinations that do work -
                    // the run still reports Partial, which is what carries the weight.
                    if (!target.adapter.createSymlink) {
                        const reason = `${target.label} cannot store symbolic links`;
                        perSourceSkippedLinks.set(src, (perSourceSkippedLinks.get(src) ?? 0) + 1);
                        errors.push({ entry: entryLabel(label, file.p), error: reason });
                        log(
                            `Symbolic link ${link} was not restored: ${reason}. Restore to a local path, `
                            + `over SFTP, or as a .tar.gz download to keep symbolic links.`,
                            'warning', 'storage'
                        );
                        done++;
                        doneBytes += file.s ?? 0;
                        updateDetail(detailText());
                        continue;
                    }

                    try {
                        await target.adapter.createSymlink(
                            target.config,
                            safeRemoteJoin(target.basePath, file.p),
                            file.lnk
                        );
                        perSourceDone.set(src, (perSourceDone.get(src) ?? 0) + 1);
                    } catch (e: unknown) {
                        const message = e instanceof Error ? e.message : String(e);
                        perSourceFailed.set(src, (perSourceFailed.get(src) ?? 0) + 1);
                        errors.push({ entry: entryLabel(label, file.p), error: message });
                        log(`Failed to restore symbolic link ${link} to ${target.label}: ${message}`, 'error', 'storage');
                    }

                    done++;

                    doneBytes += file.s ?? 0;
                    updateDetail(detailText());
                }
            } finally {
                await sessions.close();
            }

            for (const dir of selectedDirs) {
                if (!targets.has(dir.src)) continue; // target resolution already failed above
                const failed = perSourceFailed.get(dir.src) ?? 0;
                const skippedLinks = perSourceSkippedLinks.get(dir.src) ?? 0;
                const restored = perSourceDone.get(dir.src) ?? 0;
                if (failed === 0 && skippedLinks === 0) {
                    restoredDirectories.push(dir.src);
                    log(`Directory restored: ${dir.label} (${restored} file(s))`, 'success', 'storage');
                } else {
                    // A source counts as partly restored when some of its files did land, so a
                    // single rejected file cannot make the whole run look like nothing arrived.
                    if (restored > 0) partiallyRestoredDirectories.add(dir.src);

                    // Split apart, because they mean different things to whoever reads this. A
                    // failure is worth investigating; a skipped link is this destination being
                    // what it is, and no amount of retrying changes it.
                    const parts = [`${restored} of ${perSourceTotals.get(dir.src)} entr(ies) restored`];
                    if (failed > 0) parts.push(`${failed} failed`);
                    if (skippedLinks > 0) {
                        parts.push(`${skippedLinks} symbolic link(s) skipped - ${targets.get(dir.src)!.label} cannot store them`);
                    }
                    log(`Directory '${dir.label}': ${parts.join(', ')}`, failed > 0 ? 'error' : 'warning', 'storage');
                }
            }
        }

        const totalSelected = selectedDbNames.length + selectedDirs.length;
        const fullyRestored = restoredDatabases.length + restoredDirectories.length;
        // "Failed" has to mean nothing at all was written. Judging a directory source as all
        // or nothing turned 129 of 130 restored files into a failed run that claimed no entries
        // could be restored - which was both wrong and alarming.
        const anythingRestored = fullyRestored > 0 || partiallyRestoredDirectories.size > 0;
        const status: ArchiveRestoreResult["status"] =
            !anythingRestored ? "Failed" : fullyRestored < totalSelected ? "Partial" : "Success";

        return { status, restoredDatabases, restoredDirectories, errors };
    } finally {
        await archive.dispose();
    }
}

/**
 * Restores the selected database entries.
 *
 * Each dump is pulled by byte range into a temp file, restored, and removed before the
 * next one - peak disk usage is the largest single dump, not the sum. Database entries
 * always live in the snapshot's own archive (incrementals never carry them forward), so
 * no chain sibling is ever opened here.
 */
async function restoreDatabases(
    input: RestoreInput,
    archive: Awaited<ReturnType<typeof openArchiveForRestore>>,
    selectedDbNames: string[],
    dbMapping: { originalName: string; targetName: string; selected: boolean }[] | undefined,
    restoredDatabases: string[],
    errors: { entry: string; error: string }[],
    { log }: ArchiveRestoreCallbacks
): Promise<void> {
    if (!input.targetSourceId) {
        throw new Error("Missing targetSourceId: this archive contains database(s) to restore");
    }
    const sourceConfig = await prisma.adapterConfig.findUnique({ where: { id: input.targetSourceId } });
    if (!sourceConfig || sourceConfig.type !== "database") {
        throw new Error("Target source not found");
    }
    const sourceAdapter = registry.get(sourceConfig.adapterId) as DatabaseAdapter | undefined;
    if (!sourceAdapter) {
        throw new Error("Source impl missing");
    }
    if (!sourceAdapter.restoreOne) {
        throw new Error(`Database adapter '${sourceConfig.adapterId}' does not support combined restores`);
    }

    const dbConf = await resolveAdapterConfig(sourceConfig) as Record<string, unknown>;
    dbConf.type = sourceConfig.adapterId;
    if (input.privilegedAuth) dbConf.privilegedAuth = input.privilegedAuth;

    // One transport for the whole database portion: the version probe, the
    // prepare step and every restoreOne share a single connection.
    const host = createHost(resolveTransport(sourceAdapter, dbConf));
    try {

        if (sourceAdapter.test) {
            try {
                const testResult = await sourceAdapter.test(dbConf, host) as { success: boolean; version?: string };
                if (testResult.success && testResult.version) {
                    dbConf.detectedVersion = testResult.version;
                    log(`Target server version: ${testResult.version}`, 'info');
                }
            } catch { /* ignore - cosmetic binary-selection hint only */ }
        }

        const targetNames = selectedDbNames.map((name) => getTargetDatabaseName(name, dbMapping));
        if (sourceAdapter.prepareRestore) {
            log(`Preparing target database(s): ${targetNames.join(', ')}...`, 'info');
            try {
                await sourceAdapter.prepareRestore(dbConf, targetNames, host);
            } catch (e: unknown) {
                const message = e instanceof Error ? e.message : String(e);
                throw new Error(`Failed to prepare target database(s): ${message}`);
            }
        }

        for (const dbName of selectedDbNames) {
            const dbLine = archive.index.databases.find((d) => d.name === dbName);
            const entry = dbLine ? archive.index.entries.get(entryKey(undefined, dbLine.n)) : undefined;
            if (!dbLine || !entry) {
                errors.push({ entry: `database:${dbName}`, error: "Not found in the archive index" });
                log(`Database '${dbName}' is missing from the archive index`, 'error');
                continue;
            }

            const targetName = getTargetDatabaseName(dbName, dbMapping);
            const dumpPath = path.join(getTempDir(), `restore-db-${process.pid}-${crypto.randomUUID()}`);

            try {
                log(`Fetching dump for '${dbName}' (${archive.ranged ? "ranged read" : "from downloaded archive"})...`, 'info');
                await pipeline(
                    await openArchiveEntry(archive.source, archive.manifest, entry, archive.masterKey),
                    createWriteStream(dumpPath)
                );

                log(`Restoring database: ${dbName} → ${targetName}`, 'info');
                await sourceAdapter.restoreOne(
                    dbConf,
                    dumpPath,
                    targetName,
                    host,
                    (msg, level, type, details) => log(msg, level, type, details),
                    undefined,
                    dbName
                );
                restoredDatabases.push(targetName);
                log(`Database restored: ${targetName}`, 'success');
            } catch (e: unknown) {
                const message = e instanceof Error ? e.message : String(e);
                errors.push({ entry: `database:${dbName}`, error: message });
                log(`Failed to restore database '${dbName}': ${message}`, 'error');
            } finally {
                await fs.unlink(dumpPath).catch(() => { });
            }
        }
    } finally {
        await host.dispose().catch(() => {});
    }
}
