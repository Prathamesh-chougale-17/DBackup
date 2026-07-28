import path from "path";
import os from "os";
import fs from "fs/promises";
import { RunnerContext } from "../types";
import { resolveAdapterConfig } from "@/lib/adapters/config-resolver";
import { downloadDirectory } from "@/lib/adapters/storage/common/download-directory";
import { createTempDir, cleanupTempDir } from "@/lib/adapters/database/common/tar-utils";
import { createArchive } from "@/lib/archive/writer";
import { ArchiveSourceEntry, DumpFormat, SourceFileEntry } from "@/lib/archive/types";
import { DIRECTORY_ONLY_SOURCE_TYPE, INDEX_SIDECAR_SUFFIX } from "@/lib/archive/format";
import { getProfileMasterKey } from "@/services/backup/encryption-service";
import { planChain } from "@/services/backup/chain-planner";
import { carryForward, fileKey } from "@/lib/archive/chain";
import { resolveBackupFilename, parseJobDatabases } from "./dump-helpers";
import { formatBytes } from "@/lib/utils";
import { calculateFileChecksum } from "@/lib/crypto/checksum";
import { logger } from "@/lib/logging/logger";
import { wrapError } from "@/lib/logging/errors";
import { PIPELINE_STAGES } from "@/lib/core/logs";
import { resolveTransferConcurrency } from "@/lib/adapters/transfer-concurrency";
import { mapWithConcurrency } from "@/lib/concurrency";

const log = logger.child({ step: "combined-dump" });

/** Per-adapter dump format, matching what each adapter's own multi-DB path already uses internally. */
const DB_FORMAT_BY_ADAPTER: Record<string, DumpFormat> = {
    mysql: "sql",
    mariadb: "sql",
    postgres: "custom",
    mongodb: "archive",
    firebird: "fbk",
};

/** Adapters whose dump() already applies its own native compression - per-entry external compression is skipped for their dumps to avoid double-compressing already-compressed bytes. */
const NATIVE_COMPRESSION_ADAPTERS = new Set(["postgres"]);

/**
 * How many collected files are hashed at once.
 *
 * A mix of disk reads and SHA-256, so it scales with cores, and it is capped for the same
 * reason the archive writer caps its own: the work is bursty and the machine is also serving
 * the application.
 */
const HASH_CONCURRENCY = Math.max(2, Math.min(8, os.cpus().length || 4));

/** How often the hashing phase refreshes its progress text. */
const HASH_PROGRESS_EVERY = 25;

/**
 * Combined dump path for jobs that have directory sources (JobSource), used instead of the
 * unchanged single-adapter path in 02-dump.ts. Dumps every selected database individually via
 * dumpOne() (no limit on count - Multi-DB is fully supported here, exactly as in a DB-only job),
 * downloads every directory source via downloadDirectory(), then combines everything into ONE
 * archive via createCombinedTar() (manifest v2). Only ever invoked when ctx.sources.length > 0 -
 * see the guard clause in 02-dump.ts.
 */
export async function executeCombinedDump(ctx: RunnerContext): Promise<void> {
    if (!ctx.job) throw new Error("Context not initialized");
    const job = ctx.job;

    const sourceLabel = job.source ? `${job.source.name} (${job.source.type})` : "no database source";
    ctx.log(`Starting combined dump: ${sourceLabel} + ${ctx.sources.length} directory source(s)...`);

    // Decide full vs incremental before anything is collected - it changes what has to be
    // transferred at all, and the naming template may want to place the chain position in
    // the filename, so the plan has to exist before the name is resolved.
    const plan = await planChain({
        job: {
            id: job.id,
            name: job.name,
            backupMode: (job as { backupMode?: string }).backupMode ?? "FULL",
            fullEveryDays: (job as { fullEveryDays?: number }).fullEveryDays ?? 7,
            encryptionProfileId: job.encryptionProfileId ?? null,
        },
        sources: ctx.sources.map((s) => ({ jobSourceId: s.jobSourceId, excludePatterns: s.excludePatterns })),
        destinationConfigIds: ctx.destinations.map((d) => d.configId),
        now: new Date(),
    });

    if (plan.type === "incremental") {
        ctx.log(`Incremental backup, continuing the chain started on ${plan.chainDir.replace("chain-", "")} (position ${plan.index})`);
    } else if (plan.reason) {
        ctx.log(`Full backup: ${plan.reason}`, 'warning');
    }
    ctx.chain = plan;

    // The chain position is only part of the name for a job that actually builds chains; a
    // full-mode job resolves {chain} to nothing.
    const isChained = ((job as { backupMode?: string }).backupMode ?? "FULL") === "INCREMENTAL";
    const { tempFile, chainInFileName } = await resolveBackupFilename(
        job,
        isChained ? { type: plan.type, index: plan.index } : undefined
    );
    ctx.tempFile = tempFile;
    ctx.chainInFileName = chainInFileName;
    ctx.log(`Prepared temporary path: ${tempFile}`);

    // Files whose bytes already live in an earlier archive of the chain. Collected while
    // walking the sources, then turned into carried index lines below.
    const carriedKeys = new Set<string>();
    const previousBySource = new Map(
        (plan.previousIndex?.directories ?? []).map((d) => [
            d.src,
            new Map((plan.previousIndex!.files.filter((f) => f.src === d.src)).map((f) => [f.p, f])),
        ])
    );

    const workDir = await createTempDir("combined-dump-");
    const entries: ArchiveSourceEntry[] = [];
    let dbNames: string[] = [];
    let engineVersion: string | undefined;
    let engineEdition: string | undefined;
    let sourceConfig: Record<string, unknown> | undefined;

    try {
        // ── Database portion (only if the job has a database source) ──────────────
        if (ctx.sourceAdapter && job.source) {
            if (!ctx.sourceAdapter.dumpOne) {
                // Should already be blocked at job-create/update time (JobService); defensive check.
                throw new Error(`Database adapter '${job.source.adapterId}' does not support combined backups with directory sources`);
            }

            sourceConfig = await resolveAdapterConfig(job.source) as Record<string, unknown>;
            sourceConfig.type = job.source.adapterId;
            if (job.pgCompression !== undefined) {
                sourceConfig.pgCompression = job.pgCompression;
            }

            dbNames = parseJobDatabases(job.databases);
            if (dbNames.length === 0 && ctx.sourceAdapter.getDatabases) {
                ctx.log("No databases selected - auto-discovering all databases...");
                try {
                    dbNames = await ctx.sourceAdapter.getDatabases(sourceConfig);
                } catch (e: unknown) {
                    const message = e instanceof Error ? e.message : String(e);
                    ctx.log(`Warning: Could not auto-discover databases: ${message}`, 'warning');
                }
            }
            if (dbNames.length === 0) {
                throw new Error("No databases found to back up");
            }
            ctx.log(`Databases to dump: ${dbNames.join(', ')}`);

            if (ctx.sourceAdapter.test) {
                try {
                    const testRes = await ctx.sourceAdapter.test(sourceConfig) as { success: boolean; version?: string; edition?: string };
                    if (testRes.success && testRes.version) {
                        engineVersion = testRes.version;
                        ctx.log(`Detected engine version: ${engineVersion}`);
                    }
                    if (testRes.edition) engineEdition = testRes.edition;
                } catch { /* ignore - cosmetic metadata only */ }
            }
        }

        // Two visible phases, so a file-only backup never reports "Dumping Databases" and a
        // db-only one never reports "Collecting Files". Each phase's progress is relative to
        // its own work, filling its stage bar independently.
        const dbTotal = dbNames.length;
        const dirTotal = ctx.sources.length;
        const setPhaseProgress = (done: number, total: number) => {
            if (total === 0) return;
            ctx.updateStageProgress(Math.min(100, Math.max(0, Math.round((done / total) * 100))));
        };

        // Postgres applies its own native compression (pg_dump -Z) unless explicitly disabled via
        // pgCompression "NONE" - per-entry external compression is skipped for its dumps below to
        // avoid double-compressing already-compressed bytes.
        const nativeCompressionActive = job.source
            ? NATIVE_COMPRESSION_ADAPTERS.has(job.source.adapterId) && job.pgCompression !== "NONE"
            : false;

        // ── Database dumps (one per selected database - Multi-DB fully supported) ──
        if (dbTotal > 0) ctx.setStage(PIPELINE_STAGES.DUMPING);
        let dbDone = 0;
        for (const dbName of dbNames) {
            // Between databases rather than only between steps, so cancelling a multi-DB job
            // does not have to wait out every remaining dump first.
            ctx.abortSignal?.throwIfAborted();
            const format = DB_FORMAT_BY_ADAPTER[job.source!.adapterId] ?? "sql";
            const dest = path.join(workDir, "databases", `${dbName}.${format}`);
            await fs.mkdir(path.dirname(dest), { recursive: true });

            ctx.log(`Dumping database: ${dbName}`, 'info');
            const dumpConfigWithVersion = { ...sourceConfig, detectedVersion: engineVersion };
            await ctx.sourceAdapter!.dumpOne!(dumpConfigWithVersion, dbName, dest, (msg, level, type, details) => ctx.log(msg, level, type, details));

            entries.push({ kind: "database", dbName, path: dest, format, nativeCompression: nativeCompressionActive });
            dbDone++;
            setPhaseProgress(dbDone, dbTotal);
            ctx.log(`Completed dump for: ${dbName}`, 'success');
        }

        // ── Directory sources (each entirely independent - order doesn't matter) ──
        if (dirTotal > 0) ctx.setStage(PIPELINE_STAGES.COLLECTING);
        // Files within a source are downloaded in parallel; over a network source the
        // per-file round trip dominates, so this is where most of the collection time is won.
        // How many is decided per source: what one server welcomes another answers with rate
        // limits, and the sources of a single job can be both.
        let dirDone = 0;
        for (const source of ctx.sources) {
            // Checked before acquireSnapshot below, so a cancelled run never creates a shadow
            // copy it then has to release.
            ctx.abortSignal?.throwIfAborted();
            const displayPath = source.remotePath || "/";
            const label = `${source.configName}: ${displayPath}`;
            const logPrefix = `[Directory: ${displayPath} via ${source.configName}]`;
            ctx.log(`${logPrefix} Starting collection...`, 'info', 'storage');
            // Said before anything slow starts. The detail text is otherwise still the
            // previous source's final count, and a run that has moved on looks like a run
            // that has stopped.
            ctx.updateDetail(`${label}: preparing...`);

            const localDir = path.join(workDir, "sources", source.jobSourceId);
            const unitBase = dirDone;

            // A snapshot, when the source is configured for one. Everything below reads
            // through `readConfig`, which is either the plain config or the one overlaid
            // onto the exposed snapshot - the collection itself does not know the difference.
            const readConfig = await acquireSnapshot(ctx, source, logPrefix);

            // Incremental runs skip files the chain already holds. The decision uses the
            // listing (size and mtime), so an unchanged file is never transferred - which
            // is where the bandwidth saving comes from, on top of the storage saving.
            //
            // Any difference in the timestamp counts, not just a newer one: a file whose
            // mtime moves backwards has still been replaced - restoring an older copy or a
            // corrected clock on the source both do that - and treating it as unchanged
            // would silently keep the stale version. Erring this way costs one needless
            // transfer at worst, which is the direction to err in. Matches rsync's quick
            // check, which compares size and mtime for inequality.
            //
            // A full backup sets no predicate at all, so everything is transferred and
            // hashed. That bounds how long a missed change can survive: at most until the
            // next full, which is what "Full backup every N days" controls.
            const previousFiles = previousBySource.get(source.jobSourceId);
            const shouldDownload = plan.type === "incremental" && previousFiles && !job.verifyByHash
                ? (entry: { relativePath: string; size: number; lastModified: Date }) => {
                    const before = previousFiles.get(entry.relativePath);
                    if (!before) return true;
                    if (before.s !== entry.size) return true;
                    return entry.lastModified.getTime() !== new Date(before.m).getTime();
                }
                : undefined;

            const result = await downloadDirectory(
                source.adapter,
                readConfig,
                source.remotePath,
                localDir,
                source.excludePatterns,
                (processedBytes, totalBytes, processedFiles, totalFiles) => {
                    const localFraction = totalBytes > 0
                        ? processedBytes / totalBytes
                        : (totalFiles > 0 ? processedFiles / totalFiles : 0);
                    setPhaseProgress(unitBase + localFraction, dirTotal);
                    ctx.updateDetail(`${label}: ${processedFiles}/${totalFiles} files, ${formatBytes(processedBytes)}/${formatBytes(totalBytes)}`);
                },
                (msg, level, type, details) => ctx.log(`${logPrefix} ${msg}`, level, type ?? 'storage', details),
                {
                    concurrency: resolveTransferConcurrency(source.adapter.id, readConfig),
                    ...(shouldDownload ? { shouldDownload } : {}),
                    ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
                    // Only the detail text, deliberately. During listing there is no
                    // denominator yet, so the stage bar has nothing honest to say and stays
                    // where the previous source left it.
                    onListProgress: ({ files, directories, prunedDirectories }) => ctx.updateDetail(
                        `${label}: scanning, ${files} file(s) in ${directories} director(ies)`
                        + (prunedDirectories > 0 ? `, ${prunedDirectories} skipped` : '')
                    ),
                }
            );

            // A file the source would not hand over is missing from this backup. Naming each
            // one and refusing to call the run a success is the whole point - a silently
            // incomplete backup is the failure mode that only shows up when it is needed.
            if (result.failures.length > 0) {
                for (const failure of result.failures) {
                    ctx.log(`${logPrefix} MISSING from this backup: ${failure.path} (${failure.error})`, 'error', 'storage');
                }
                ctx.log(
                    `${logPrefix} ${result.failures.length} file(s) could not be collected and are not in this backup`,
                    'error', 'storage'
                );
                ctx.status = "Partial";
            }

            for (const e of result.entries) {
                // Not transferred, so its bytes stay where they already are.
                if (e.unchanged) carriedKeys.add(fileKey(source.jobSourceId, e.relativePath));
            }

            // Content hash of the raw (pre-compression, pre-encryption) file. Lands in the
            // archive index, which is itself sealed when the job is encrypted - a plaintext
            // hash sitting in the clear would be a confirmation oracle against known files.
            //
            // Hashing is a second full read of everything just collected. Done one file at a
            // time with nothing reported, it left the run looking finished-but-frozen for as
            // long as the source was large - the last silent stretch of the collect phase.
            const toHash = result.entries.filter((e) => !e.unchanged);
            let hashed = 0;
            ctx.updateDetail(`${label}: hashing ${toHash.length} file(s)...`);
            const checksums = await mapWithConcurrency(toHash, HASH_CONCURRENCY, async (e) => {
                ctx.abortSignal?.throwIfAborted();
                const checksum = await calculateFileChecksum(path.join(localDir, e.relativePath));
                hashed++;
                if (hashed % HASH_PROGRESS_EVERY === 0) {
                    ctx.updateDetail(`${label}: hashing ${hashed}/${toHash.length} file(s)`);
                }
                return checksum;
            });

            // Rebuilt in listing order, which mapWithConcurrency preserves - the index is
            // compared against the previous snapshot's, so its layout has to stay stable.
            const fileIndex: SourceFileEntry[] = [];
            toHash.forEach((e, i) => {
                const before = previousFiles?.get(e.relativePath);
                const checksum = checksums[i];

                // The file was transferred, but its content is identical to what the chain
                // already holds - mtime moved without the bytes changing, which happens on
                // every deploy and every `touch`. Carrying it forward avoids storing a
                // second copy of the same content.
                if (before?.h && before.h === checksum) {
                    carriedKeys.add(fileKey(source.jobSourceId, e.relativePath));
                    return;
                }

                fileIndex.push({
                    path: e.relativePath,
                    size: e.size,
                    mtime: e.lastModified.toISOString(),
                    checksum,
                });
            });

            if (plan.type === "incremental") {
                const carriedHere = result.entries.length - fileIndex.length;
                ctx.log(
                    `${logPrefix} ${fileIndex.length} changed file(s) stored, ${carriedHere} unchanged file(s) referenced from earlier backups`,
                    'info', 'storage'
                );
            }

            entries.push({
                kind: "directory",
                jobSourceId: source.jobSourceId,
                label,
                localPath: localDir,
                excludePatterns: source.excludePatterns,
                files: fileIndex,
            });

            dirDone++;
            setPhaseProgress(dirDone, dirTotal);
            ctx.log(`${logPrefix} Collected ${result.files} file(s), ${formatBytes(result.bytes)}`, 'success', 'storage');
        }

        // ── Combine everything into one archive ────────────────────────────────────
        // Compression AND encryption are applied per entry inside the archive rather than as
        // whole-file passes in 03-upload.ts. That is what keeps the archive seekable: a single
        // file can later be fetched by byte range and opened on its own, which a
        // compressed-or-encrypted outer stream would make impossible. 03-upload.ts skips both
        // of its own passes for this archive - see the isCombinedArchive guard there.
        const encryptionProfileId = job.encryptionProfileId ?? undefined;
        if (encryptionProfileId) {
            ctx.log(`Per-entry encryption enabled. Profile ID: ${encryptionProfileId}`);
        }

        // Packing compresses and encrypts every entry, which on a large source takes real
        // time. Without its own stage the run looked stuck at "Collecting Files" at 100%,
        // so it reports as its own step - the slot 03-upload leaves unused for this archive,
        // because both passes already happened here.
        ctx.setStage(PIPELINE_STAGES.PROCESSING);
        ctx.log(`Creating combined archive with ${dbNames.length} database(s) and ${ctx.sources.length} directory source(s)...`);
        const { manifest, index, indexBytes, skippedCompression } = await createArchive(entries, tempFile, {
            sourceType: job.source ? job.source.adapterId : DIRECTORY_ONLY_SOURCE_TYPE,
            engineVersion,
            compression: (job.compression as "NONE" | "GZIP" | "BROTLI" | undefined) ?? "NONE",
            // Entries compress and encrypt ahead of the sequential tar write. This is local CPU
            // work, so it scales with cores rather than with anything a storage adapter allows -
            // and it is capped because the work is bursty and the machine is also running the
            // application. Falls back to 4 where the core count is unavailable.
            concurrency: Math.max(2, Math.min(8, os.cpus().length || 4)),
            onProgress: (done, total, label) => {
                ctx.updateStageProgress(Math.min(100, Math.round((done / total) * 100)));
                ctx.updateDetail(`Packing ${done}/${total}: ${label}`);
            },
            ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
            ...(encryptionProfileId
                ? { encryption: { masterKey: await getProfileMasterKey(encryptionProfileId), profileId: encryptionProfileId } }
                : {}),
            chain: {
                id: plan.chainId,
                type: plan.type,
                ...(plan.baseArchive ? { base: plan.baseArchive } : {}),
                index: plan.index,
                ...(plan.previousIndex && plan.baseArchive
                    ? { carried: carryForward(plan.previousIndex, plan.baseArchive, carriedKeys) }
                    : {}),
            },
        });

        // Said out loud, because otherwise a job configured for compression that produces an
        // archive roughly the size of its input reads like a setting that did not apply.
        if (skippedCompression.files > 0) {
            ctx.log(
                `${skippedCompression.files} file(s) stored uncompressed (${formatBytes(skippedCompression.bytes)}) - their format is already compressed`
            );
        }

        // The sidecar is a byte-identical copy of the archive's own index member. Uploading
        // it separately is what lets browsing and file-level restore read a file list
        // without pulling the archive down.
        ctx.indexFile = tempFile + INDEX_SIDECAR_SUFFIX;
        await fs.writeFile(ctx.indexFile, indexBytes);
        ctx.log(`Wrote archive index sidecar (${formatBytes(indexBytes.length)}, ${manifest.counts.files} file(s))`);

        // The complete snapshot size, including files whose bytes live in earlier
        // archives of the chain. manifest.totalSize only covers what this archive stores.
        const logicalSize =
            index.files.reduce((sum, f) => sum + f.s, 0) +
            index.databases.reduce((sum, d) => sum + d.s, 0);

        ctx.dumpSize = manifest.totalSize;
        ctx.metadata = {
            ...ctx.metadata,
            jobName: job.name,
            sourceName: job.source?.name,
            sourceType: job.source?.adapterId,
            adapterId: job.source?.adapterId,
            engineVersion,
            engineEdition,
            count: dbNames.length,
            names: dbNames,
            label: dbNames.length > 0 ? `${dbNames.length} DB(s) + ${ctx.sources.length} directory source(s)` : `${ctx.sources.length} directory source(s)`,
            combined: {
                databases: dbNames.length,
                directorySources: ctx.sources.length,
            },
            logicalSize,
            archive: {
                formatVersion: 2 as const,
                indexFile: INDEX_SIDECAR_SUFFIX,
                encrypted: !!manifest.encryption,
                ...(manifest.encryption
                    ? {
                        profileId: manifest.encryption.profileId,
                        kdfSalt: manifest.encryption.kdfSalt,
                        noncePrefix: manifest.encryption.noncePrefix,
                    }
                    : {}),
                ...(manifest.compression !== "NONE" ? { compression: manifest.compression } : {}),
                ...(manifest.bundled ? { bundled: true } : {}),
                files: manifest.counts.files,
            },
        };

        const sizeStr = formatBytes(manifest.totalSize);
        ctx.log(`Combined archive created successfully. Size: ${sizeStr}`, 'success');
    } finally {
        await cleanupTempDir(workDir).catch((e) => log.warn("Failed to clean up combined-dump work directory", { workDir }, wrapError(e)));
    }
}

/**
 * Creates a snapshot for a directory source that asks for one, and returns the config the
 * collection should read through.
 *
 * Throws when a source is configured for snapshots but cannot get one. That is deliberate:
 * a job that promises point-in-time consistency must not quietly produce a backup without
 * it. The failure is loud, and the job's failure notification carries it.
 *
 * The handle is parked on the context immediately, before anything else can fail, so
 * `stepCleanup` releases it no matter how the run ends.
 */
async function acquireSnapshot(
    ctx: RunnerContext,
    source: RunnerContext["sources"][number],
    logPrefix: string
): Promise<Record<string, unknown>> {
    if (source.config?.useVss !== true) return source.config;

    const { adapter, config, remotePath } = source;
    if (!adapter.createSnapshot || !adapter.supportsSnapshot || !adapter.releaseSnapshot) {
        throw new Error(`${source.configName}: shadow copies are enabled but adapter '${adapter.id}' cannot create them`);
    }

    const support = await adapter.supportsSnapshot(config, remotePath);
    if (!support.supported) {
        throw new Error(`${source.configName}: shadow copies are enabled but unavailable - ${support.message}`);
    }

    // A run killed before cleanup leaves its snapshot behind, and the server refuses a new
    // one while the old set is open. Clear those first or every later backup fails.
    if (adapter.findOrphanedSnapshots) {
        const orphans = await adapter.findOrphanedSnapshots(config, remotePath).catch(() => []);
        for (const orphan of orphans) {
            ctx.log(`${logPrefix} Removing a shadow copy left over from an earlier run (${orphan.label})`, 'warning', 'storage');
            await adapter.releaseSnapshot(config, orphan).catch((e: unknown) => {
                ctx.log(`${logPrefix} Could not remove the leftover shadow copy: ${e instanceof Error ? e.message : String(e)}`, 'warning', 'storage');
            });
        }
    }

    const handle = await adapter.createSnapshot(config, remotePath);
    ctx.shadowCopies = ctx.shadowCopies ?? [];
    ctx.shadowCopies.push({ configId: source.configId, configName: source.configName, adapter, config, handle });
    ctx.log(`${logPrefix} Reading from shadow copy ${handle.label}`, 'info', 'storage');

    return { ...config, ...handle.configOverride };
}
