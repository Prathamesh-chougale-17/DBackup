import path from "path";
import os from "os";
import fs from "fs/promises";
import { RunnerContext } from "../types";
import { createHost, resolveTransport, type ExecutionHost } from "@/lib/transport";
import { resolveAdapterConfig } from "@/lib/adapters/config-resolver";
import { createTempDir, cleanupTempDir } from "@/lib/adapters/database/common/tar-utils";
import { createArchive } from "@/lib/archive/writer";
import { ArchiveSourceEntry, DumpFormat, FileMetadata } from "@/lib/archive/types";
import { DIRECTORY_ONLY_SOURCE_TYPE, INDEX_SIDECAR_SUFFIX } from "@/lib/archive/format";
import { getProfileMasterKey } from "@/services/backup/encryption-service";
import { planChain } from "@/services/backup/chain-planner";
import { carryForward } from "@/lib/archive/chain";
import { resolveBackupFilename, parseJobDatabases } from "./dump-helpers";
import { collectDirectories } from "./collect-directories";
import { formatBytes } from "@/lib/utils";
import { logger } from "@/lib/logging/logger";
import { wrapError } from "@/lib/logging/errors";
import { PIPELINE_STAGES } from "@/lib/core/logs";

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
 * Combined dump path for jobs that have directory sources (JobSource), used instead of the
 * unchanged single-adapter path in 02-dump.ts. Dumps every selected database individually via
 * dumpOne() (no limit on count - Multi-DB is fully supported here, exactly as in a DB-only job),
 * hands the directory sources to collect-directories.ts, then combines everything into ONE
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
    // Only consulted for carried files - a re-stored one gets its metadata from the
    // SourceFileEntry the writer sees. Filled for every file anyway, because whether a file
    // ends up carried is not decided until its checksum is known.
    const freshMetadata = new Map<string, FileMetadata>();
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
    // One transport for the whole combined dump. An N-database job used to open
    // N+2 SSH connections against the same server, one per adapter call.
    let host: ExecutionHost | null = null;

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
            host = createHost(resolveTransport(ctx.sourceAdapter, sourceConfig));

            dbNames = parseJobDatabases(job.databases);
            if (dbNames.length === 0 && ctx.sourceAdapter.getDatabases) {
                ctx.log("No databases selected - auto-discovering all databases...");
                try {
                    dbNames = await ctx.sourceAdapter.getDatabases(sourceConfig, host!);
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
                    const testRes = await ctx.sourceAdapter.test(sourceConfig, host!) as { success: boolean; version?: string; edition?: string };
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
            await ctx.sourceAdapter!.dumpOne!(dumpConfigWithVersion, dbName, dest, host!, (msg, level, type, details) => ctx.log(msg, level, type, details));

            entries.push({ kind: "database", dbName, path: dest, format, nativeCompression: nativeCompressionActive });
            dbDone++;
            setPhaseProgress(dbDone, dbTotal);
            ctx.log(`Completed dump for: ${dbName}`, 'success');
        }

        // ── Directory sources ──────────────────────────────────────────────────────
        // Collected in groups, which for every adapter that does not plan them means one
        // source per group and the same sequence as before. Files within a source are
        // downloaded in parallel; over a network source the per-file round trip dominates,
        // so that is where most of the collection time is won.
        const collected = await collectDirectories({
            ctx,
            plan,
            verifyByHash: job.verifyByHash,
            workDir,
            previousBySource,
            setPhaseProgress,
        });
        entries.push(...collected.entries);
        collected.carriedKeys.forEach((key) => carriedKeys.add(key));
        collected.freshMetadata.forEach((value, key) => freshMetadata.set(key, value));

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
                    ? { carried: carryForward(plan.previousIndex, plan.baseArchive, carriedKeys, freshMetadata) }
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
        await host?.dispose().catch(() => {});
        await cleanupTempDir(workDir).catch((e) => log.warn("Failed to clean up combined-dump work directory", { workDir }, wrapError(e)));
    }
}

