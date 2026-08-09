/**
 * How a single archive is split across parallel connections on the way to an object store.
 *
 * This is a different question from `transfer-concurrency.ts`, which counts whole *files* and
 * only ever applies to a directory source. A backup destination receives one archive per run,
 * so there are no files to interleave - the parallelism has to happen inside the one upload,
 * across the parts of a multipart request.
 *
 * Measured against Cloudflare R2 over a 10 Gbit link on 2026-08-09: a 1.39 GB archive took 51s,
 * which is 27 MB/s across the four parts the AWS SDK runs by default, so 6.8 MB/s per
 * connection. Everything local in the same run moved at 230 to 460 MB/s, and the link was at
 * 2% of capacity. The limit is the number of connections, not the line and not the disk.
 */
import type { AdapterConfig } from "@/lib/core/interfaces";
import { ADAPTER_DEFINITIONS, DEFAULT_S3_UPLOAD_TUNING } from "@/lib/adapters/definitions";

export { DEFAULT_S3_UPLOAD_TUNING };

const MB = 1024 * 1024;

/** S3 refuses a part below this, except for the last one. */
export const S3_MIN_PART_SIZE_MB = 5;

/** S3 refuses a multipart upload with more parts than this. */
export const S3_MAX_PARTS = 10_000;

/** The config keys a connection stores its chosen values under. */
export const S3_UPLOAD_CONCURRENCY_KEY = "uploadConcurrency";
export const S3_UPLOAD_PART_SIZE_KEY = "uploadPartSizeMb";

export type S3UploadTuningRange = {
    concurrency: { default: number; max: number };
    partSizeMb: { default: number; max: number };
};

/**
 * The range a given adapter allows, for the form and for clamping.
 *
 * Looked up by id from the definitions rather than from a runtime adapter, for the same reason
 * `transferConcurrencyRange` is: the connection form calls this in the browser, and importing
 * the runtime adapters there would pull the AWS SDK into the client bundle.
 */
export function s3UploadTuningRange(adapterId: string): S3UploadTuningRange | undefined {
    return ADAPTER_DEFINITIONS.find((d) => d.id === adapterId)?.multipartUpload;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
    const parsed = typeof value === "number" ? value : parseInt(String(value ?? ""), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(parsed)));
}

export type ResolvedS3UploadTuning = {
    /** Parts uploaded at the same time. Maps to the SDK's `queueSize`. */
    queueSize: number;
    /** Bytes per part. Maps to the SDK's `partSize`. */
    partSize: number;
    /** Why the part size differs from the one the connection asked for, if it does. */
    adjustment: PartSizeAdjustment;
};

export type PartSizeAdjustment =
    /** The connection's own value was usable as-is. */
    | 'none'
    /** The archive would otherwise need more than S3 accepts, so parts had to grow. */
    | 'raised-for-part-limit'
    /** The archive would not have produced enough parts to keep every connection busy. */
    | 'lowered-to-fill-parallelism';

/**
 * How many rounds of work every connection should get.
 *
 * One would technically keep them all busy, but it makes the upload finish when its *slowest*
 * part does, with nothing behind it to absorb a connection that stalls. Two is the cheapest
 * number that restores that cushion.
 */
const TARGET_WAVES = 2;

/**
 * Turns a connection's stored values into what `new Upload()` takes.
 *
 * The stored part size is a ceiling rather than a fixed value, because the number that actually
 * performs depends on the archive and the archive differs every run. Both directions are real:
 *
 * - **Down**, when the archive would not split into enough parts to keep every connection busy.
 *   Effective parallelism is `min(queueSize, fileSize / partSize)`, so a part size set too high
 *   silently discards connections. Measured against R2: a 1.39 GB archive at 32 by 64 MB is only
 *   21 parts, so 11 connections never received one and the upload took as long as a single part,
 *   123 MB/s. The same archive at 32 by 16 MB is 83 parts and ran at 187 MB/s.
 * - **Up**, when the archive needs more than the 10.000 parts S3 accepts. Passing an explicit
 *   `partSize` switches off the SDK's own `max(5 MB, size / 10000)`, and with it the only thing
 *   keeping a large upload legal. A 500 GB backup at 8 MB parts is 62.500 parts, which S3
 *   rejects outright.
 *
 * The limit wins over the ceiling where they disagree, because the alternative is an upload the
 * service refuses. Everything else stays at or below what the connection asked for, so the
 * memory figure the form shows is never exceeded.
 *
 * Leaving `fileSize` undefined skips both, which is correct for a stat that failed: a wrong
 * guess about the archive is worse than the configured value.
 *
 * Stored values are clamped rather than trusted: they arrive from JSON that a restored export
 * or a hand-edited database can put anything into, and a ceiling only the form enforces is not
 * a ceiling.
 */
export function resolveS3UploadTuning(
    adapterId: string,
    config: AdapterConfig | undefined,
    fileSize?: number
): ResolvedS3UploadTuning {
    const range = s3UploadTuningRange(adapterId) ?? DEFAULT_S3_UPLOAD_TUNING;
    const stored = config as Record<string, unknown> | undefined;

    const queueSize = clampInt(
        stored?.[S3_UPLOAD_CONCURRENCY_KEY],
        1,
        range.concurrency.max,
        range.concurrency.default
    );
    const partSizeMb = clampInt(
        stored?.[S3_UPLOAD_PART_SIZE_KEY],
        S3_MIN_PART_SIZE_MB,
        range.partSizeMb.max,
        range.partSizeMb.default
    );

    const ceiling = partSizeMb * MB;
    if (!fileSize || fileSize <= 0) {
        return { queueSize, partSize: ceiling, adjustment: 'none' };
    }

    // Never below the 5 MB S3 refuses: a small archive simply cannot fill every connection, and
    // splitting it further would trade a legal upload for parallelism it can never reach.
    const fillsEveryConnection = Math.max(
        S3_MIN_PART_SIZE_MB * MB,
        Math.floor(fileSize / (queueSize * TARGET_WAVES))
    );
    const withinLimit = Math.ceil(fileSize / S3_MAX_PARTS);

    const partSize = Math.max(Math.min(ceiling, fillsEveryConnection), withinLimit);

    return {
        queueSize,
        partSize,
        adjustment:
            partSize > ceiling ? 'raised-for-part-limit'
                : partSize < ceiling ? 'lowered-to-fill-parallelism'
                    : 'none',
    };
}

/**
 * Peak bytes held in memory for one upload at these settings.
 *
 * One part per connection in flight, plus the one the chunker is filling behind them. The form
 * shows this because the two fields are meaningless apart: raising parallelism on 64 MB parts
 * costs eight times what the same step costs on 8 MB ones, and nobody should have to work that
 * out from two spinboxes.
 */
export function s3UploadMemoryBudget(queueSize: number, partSizeMb: number): number {
    return (queueSize + 1) * partSizeMb * MB;
}
