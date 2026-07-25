import { describe, it, expect } from "vitest";
import {
    resolveTransferConcurrency,
    transferConcurrencyRange,
    DEFAULT_TRANSFER_CONCURRENCY,
} from "@/lib/adapters/transfer-concurrency";
import { ADAPTER_DEFINITIONS } from "@/lib/adapters/definitions";

describe("storage config schemas", () => {
    it.each(ADAPTER_DEFINITIONS.filter((d) => d.type === "storage").map((d) => d.id))(
        "keeps a parallel-transfer value through validation: %s",
        (id) => {
            // The connection form validates with zodResolver, and Zod drops keys the schema does
            // not declare. A field missing here is not a typing detail: the value is discarded in
            // the browser before the request is sent, so saving 8 silently stores nothing and the
            // form shows the default again when reopened.
            const def = ADAPTER_DEFINITIONS.find((d) => d.id === id)!;
            const parsed = def.configSchema.partial().parse({ maxConcurrentFiles: 8 }) as Record<string, unknown>;
            expect(parsed.maxConcurrentFiles).toBe(8);
        }
    );
});

describe("transferConcurrencyRange", () => {
    it("uses the shared default for an adapter that states no range", () => {
        expect(transferConcurrencyRange("s3-aws")).toEqual(DEFAULT_TRANSFER_CONCURRENCY);
    });

    it("keeps SSH-based adapters below OpenSSH's default connection-rate threshold", () => {
        // Every transfer is a fresh login, and sshd refuses connections past MaxStartups
        // (ten unauthenticated by default). A backup must not be able to take every slot.
        expect(transferConcurrencyRange("sftp").max).toBeLessThan(10);
        expect(transferConcurrencyRange("rsync").max).toBeLessThan(10);
    });

    it("uses the adapter's own range where it declares one", () => {
        // Dropbox throttles concurrent writes per account, so its ceiling is not the user's to
        // raise - the range is the adapter's statement about the provider, not a preference.
        expect(transferConcurrencyRange("dropbox")).toEqual({ default: 4, max: 4 });
    });

    it("falls back to the default for an unknown adapter id", () => {
        expect(transferConcurrencyRange("does-not-exist")).toEqual(DEFAULT_TRANSFER_CONCURRENCY);
    });
});

describe("resolveTransferConcurrency", () => {
    it("uses the adapter default when the connection names no value", () => {
        expect(resolveTransferConcurrency("s3-aws", {})).toBe(DEFAULT_TRANSFER_CONCURRENCY.default);
        expect(resolveTransferConcurrency("s3-aws", undefined)).toBe(DEFAULT_TRANSFER_CONCURRENCY.default);
    });

    it("uses the value the connection stored", () => {
        expect(resolveTransferConcurrency("s3-aws", { maxConcurrentFiles: 12 })).toBe(12);
    });

    it("accepts the value as a string, as a form or an imported config can store it", () => {
        expect(resolveTransferConcurrency("s3-aws", { maxConcurrentFiles: "8" })).toBe(8);
    });

    it("clamps a value above the adapter's ceiling", () => {
        // The stored value arrives from JSON that a restored export or a hand-edited database
        // can put anything into - a ceiling that only the form enforces is not a ceiling.
        expect(resolveTransferConcurrency("s3-aws", { maxConcurrentFiles: 500 })).toBe(16);
        expect(resolveTransferConcurrency("dropbox", { maxConcurrentFiles: 16 })).toBe(4);
        expect(resolveTransferConcurrency("sftp", { maxConcurrentFiles: 16 })).toBe(8);
    });

    it("never resolves below one, whatever is stored", () => {
        // Zero or a negative would stall the transfer loop outright rather than slow it down.
        expect(resolveTransferConcurrency("s3-aws", { maxConcurrentFiles: 0 })).toBe(1);
        expect(resolveTransferConcurrency("s3-aws", { maxConcurrentFiles: -5 })).toBe(1);
    });

    it("falls back rather than guessing when the stored value is not a number", () => {
        expect(resolveTransferConcurrency("s3-aws", { maxConcurrentFiles: "many" })).toBe(DEFAULT_TRANSFER_CONCURRENCY.default);
        expect(resolveTransferConcurrency("s3-aws", { maxConcurrentFiles: null })).toBe(DEFAULT_TRANSFER_CONCURRENCY.default);
    });

    it("rounds a fractional value down instead of handing on a fraction", () => {
        expect(resolveTransferConcurrency("s3-aws", { maxConcurrentFiles: 4.9 })).toBe(4);
    });
});
