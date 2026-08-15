import { describe, it, expect } from "vitest";
import {
    resolveS3UploadTuning,
    s3UploadTuningRange,
    s3UploadMemoryBudget,
    DEFAULT_S3_UPLOAD_TUNING,
    S3_MIN_PART_SIZE_MB,
    S3_MAX_PARTS,
} from "@/lib/adapters/s3-upload-tuning";
import { ADAPTER_DEFINITIONS } from "@/lib/adapters/definitions";

const MB = 1024 * 1024;
const S3_ADAPTERS = ["s3-aws", "s3-generic", "s3-r2", "s3-hetzner"];

describe("S3 upload tuning on the config schemas", () => {
    it.each(S3_ADAPTERS)("keeps both tuning values through validation: %s", (id) => {
        // The connection form validates with zodResolver, and Zod drops keys the schema does not
        // declare. A field missing here is not a typing detail: the value is discarded in the
        // browser before the request is sent, so saving 16 silently stores nothing and the form
        // shows the default again when reopened.
        const def = ADAPTER_DEFINITIONS.find((d) => d.id === id)!;
        const parsed = def.configSchema.partial().parse({
            uploadConcurrency: 16,
            uploadPartSizeMb: 32,
        }) as Record<string, unknown>;
        expect(parsed.uploadConcurrency).toBe(16);
        expect(parsed.uploadPartSizeMb).toBe(32);
    });

    it("does not put the fields on an adapter that uploads as a single stream", () => {
        // Stored on a WebDAV or SFTP connection they would never be read, which reads to the
        // user as a setting that does nothing.
        const def = ADAPTER_DEFINITIONS.find((d) => d.id === "webdav")!;
        const parsed = def.configSchema.partial().parse({ uploadConcurrency: 16 }) as Record<string, unknown>;
        expect(parsed.uploadConcurrency).toBeUndefined();
    });
});

describe("s3UploadTuningRange", () => {
    it("gives every S3 adapter the shared range", () => {
        for (const id of S3_ADAPTERS) {
            expect(s3UploadTuningRange(id)).toEqual(DEFAULT_S3_UPLOAD_TUNING);
        }
    });

    it("returns nothing for an adapter that does not upload in parts", () => {
        // The form hides the field on this rather than showing a disabled 1.
        expect(s3UploadTuningRange("sftp")).toBeUndefined();
        expect(s3UploadTuningRange("does-not-exist")).toBeUndefined();
    });
});

describe("resolveS3UploadTuning", () => {
    it("beats the AWS SDK's own defaults, which is the entire point", () => {
        // The SDK uses 4 parts of 5 MB when neither is given. Measured against R2 over a
        // 10 Gbit link that is 27 MB/s, while the same run hashed the file locally at 460 MB/s.
        const { queueSize, partSize } = resolveS3UploadTuning("s3-r2", {});
        expect(queueSize).toBeGreaterThan(4);
        expect(partSize).toBeGreaterThan(5 * MB);
    });

    it("uses the adapter default when the connection names no value", () => {
        expect(resolveS3UploadTuning("s3-aws", {})).toEqual({
            queueSize: DEFAULT_S3_UPLOAD_TUNING.concurrency.default,
            partSize: DEFAULT_S3_UPLOAD_TUNING.partSizeMb.default * MB,
            adjustment: 'none',
        });
        expect(resolveS3UploadTuning("s3-aws", undefined).queueSize).toBe(
            DEFAULT_S3_UPLOAD_TUNING.concurrency.default
        );
    });

    it("uses the values the connection stored", () => {
        const { queueSize, partSize } = resolveS3UploadTuning("s3-r2", {
            uploadConcurrency: 24,
            uploadPartSizeMb: 32,
        });
        expect(queueSize).toBe(24);
        expect(partSize).toBe(32 * MB);
    });

    it("accepts the values as strings, as a form or an imported config can store them", () => {
        const { queueSize, partSize } = resolveS3UploadTuning("s3-r2", {
            uploadConcurrency: "16",
            uploadPartSizeMb: "16",
        });
        expect(queueSize).toBe(16);
        expect(partSize).toBe(16 * MB);
    });

    it("clamps values above the ceiling", () => {
        // These arrive from JSON that a restored export or a hand-edited database can put
        // anything into, and unbounded they multiply straight into memory.
        const { queueSize, partSize } = resolveS3UploadTuning("s3-aws", {
            uploadConcurrency: 5000,
            uploadPartSizeMb: 5000,
        });
        expect(queueSize).toBe(DEFAULT_S3_UPLOAD_TUNING.concurrency.max);
        expect(partSize).toBe(DEFAULT_S3_UPLOAD_TUNING.partSizeMb.max * MB);
    });

    it("never produces a part S3 would refuse", () => {
        // S3 rejects any part below 5 MB except the last, so a stored 1 fails the upload
        // outright rather than making it slower.
        const { partSize } = resolveS3UploadTuning("s3-aws", { uploadPartSizeMb: 1 });
        expect(partSize).toBe(S3_MIN_PART_SIZE_MB * MB);
    });

    it("never resolves below one part in flight", () => {
        expect(resolveS3UploadTuning("s3-aws", { uploadConcurrency: 0 }).queueSize).toBe(1);
        expect(resolveS3UploadTuning("s3-aws", { uploadConcurrency: -5 }).queueSize).toBe(1);
    });

    it("falls back rather than guessing when a stored value is not a number", () => {
        const { queueSize, partSize } = resolveS3UploadTuning("s3-aws", {
            uploadConcurrency: "lots",
            uploadPartSizeMb: null,
        });
        expect(queueSize).toBe(DEFAULT_S3_UPLOAD_TUNING.concurrency.default);
        expect(partSize).toBe(DEFAULT_S3_UPLOAD_TUNING.partSizeMb.default * MB);
    });

    it("raises the part size so a large archive stays under S3's part limit", () => {
        // Passing an explicit partSize switches off the SDK's own max(5 MB, size / 10000), and
        // with it the only thing keeping this upload legal. A 500 GB backup at the default 8 MB
        // would be 64.000 parts, which S3 rejects outright.
        const fiveHundredGb = 500 * 1024 * MB;
        const { partSize, adjustment } = resolveS3UploadTuning("s3-aws", {}, fiveHundredGb);

        expect(adjustment).toBe('raised-for-part-limit');
        expect(partSize).toBeGreaterThan(DEFAULT_S3_UPLOAD_TUNING.partSizeMb.default * MB);
        expect(Math.ceil(fiveHundredGb / partSize)).toBeLessThanOrEqual(S3_MAX_PARTS);
    });

    it("leaves the configured part size alone for an archive that fits", () => {
        const { partSize, adjustment } = resolveS3UploadTuning("s3-aws", {}, 2 * 1024 * MB);
        expect(adjustment).toBe('none');
        expect(partSize).toBe(DEFAULT_S3_UPLOAD_TUNING.partSizeMb.default * MB);
    });

    it("keeps the configured size when the archive size is unknown", () => {
        // The metadata sidecars upload through the same path, and a stat can fail.
        expect(resolveS3UploadTuning("s3-aws", {}, undefined).partSize).toBe(
            DEFAULT_S3_UPLOAD_TUNING.partSizeMb.default * MB
        );
        expect(resolveS3UploadTuning("s3-aws", {}, 0).partSize).toBe(
            DEFAULT_S3_UPLOAD_TUNING.partSizeMb.default * MB
        );
    });
});

describe("resolveS3UploadTuning keeps every connection fed", () => {
    it("lowers the part size when the archive would not split into enough parts", () => {
        // The case measured against R2: a 1.39 GB archive at 32 parts of 64 MB is only 21 parts,
        // so 11 connections never received one and the upload took as long as a single part.
        // 123 MB/s that way, 187 MB/s once every connection had work.
        const archive = 1_387_008_512;
        const { partSize, adjustment } = resolveS3UploadTuning(
            "s3-r2",
            { uploadConcurrency: 32, uploadPartSizeMb: 64 },
            archive
        );

        expect(adjustment).toBe('lowered-to-fill-parallelism');
        expect(partSize).toBeLessThan(64 * MB);
        expect(Math.ceil(archive / partSize)).toBeGreaterThanOrEqual(32);
    });

    it("gives every connection more than one part, so a slow one does not set the pace", () => {
        // At exactly one round the upload finishes when its slowest part does, with nothing
        // behind it to absorb a connection that stalls.
        const archive = 1_387_008_512;
        const { partSize } = resolveS3UploadTuning(
            "s3-r2",
            { uploadConcurrency: 32, uploadPartSizeMb: 64 },
            archive
        );
        expect(Math.ceil(archive / partSize)).toBeGreaterThanOrEqual(64);
    });

    it("never raises the part size to fill connections, only lowers it", () => {
        // The stored value is a memory ceiling. Growing past it to reach some ideal part count
        // would spend memory the user did not agree to.
        const { partSize, adjustment } = resolveS3UploadTuning(
            "s3-r2",
            { uploadConcurrency: 4, uploadPartSizeMb: 8 },
            500 * 1024 * MB
        );
        expect(adjustment).not.toBe('lowered-to-fill-parallelism');
        expect(partSize).toBeGreaterThanOrEqual(8 * MB);
    });

    it("stops at S3's 5 MB minimum for an archive too small to fill every connection", () => {
        // A 20 MB backup cannot keep 32 connections busy at any legal part size. Splitting
        // further would trade a valid upload for parallelism it can never reach.
        const { partSize } = resolveS3UploadTuning(
            "s3-r2",
            { uploadConcurrency: 32, uploadPartSizeMb: 64 },
            20 * MB
        );
        expect(partSize).toBe(S3_MIN_PART_SIZE_MB * MB);
    });

    it("lets the part limit win over the ceiling, because the alternative is a rejected upload", () => {
        const eightHundredGb = 800 * 1024 * MB;
        const { partSize, adjustment } = resolveS3UploadTuning(
            "s3-aws",
            { uploadConcurrency: 32, uploadPartSizeMb: 16 },
            eightHundredGb
        );

        expect(adjustment).toBe('raised-for-part-limit');
        expect(partSize).toBeGreaterThan(16 * MB);
        expect(Math.ceil(eightHundredGb / partSize)).toBeLessThanOrEqual(S3_MAX_PARTS);
    });

    it("leaves a ceiling alone that already fits the archive", () => {
        // Manu's measured optimum: 32 parts of 16 MB on a 1.39 GB archive, 187 MB/s.
        const { partSize, adjustment } = resolveS3UploadTuning(
            "s3-r2",
            { uploadConcurrency: 32, uploadPartSizeMb: 16 },
            1_387_008_512
        );
        expect(adjustment).toBe('none');
        expect(partSize).toBe(16 * MB);
    });
});

describe("s3UploadMemoryBudget", () => {
    it("counts the parts in flight plus the one being filled", () => {
        expect(s3UploadMemoryBudget(8, 8)).toBe(9 * 8 * MB);
    });

    it("keeps the shipped default inside what a small container can spare", () => {
        // The default has to work in a 512 MB container, which is where most self-hosted
        // installations run. The ceiling is opt-in and the form states its cost.
        const shipped = s3UploadMemoryBudget(
            DEFAULT_S3_UPLOAD_TUNING.concurrency.default,
            DEFAULT_S3_UPLOAD_TUNING.partSizeMb.default
        );
        expect(shipped).toBeLessThan(128 * MB);
    });
});
