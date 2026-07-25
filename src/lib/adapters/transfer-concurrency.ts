import type { AdapterConfig } from "@/lib/core/interfaces";
import { ADAPTER_DEFINITIONS } from "@/lib/adapters/definitions";

/**
 * Applies to adapters that do not state their own range.
 *
 * Four is a deliberately modest starting point: it is a clear win over transferring one file at
 * a time, and it is low enough that a server nobody has measured - a small VPS, a shared host -
 * does not get sixteen simultaneous logins on the first run. Sixteen is the ceiling because
 * beyond it the limit stops being the transfer and starts being the server's connection
 * handling, which is a worse problem than a slow backup.
 */
export const DEFAULT_TRANSFER_CONCURRENCY = { default: 4, max: 16 } as const;

/** The config key a connection stores its chosen value under. */
export const TRANSFER_CONCURRENCY_KEY = "maxConcurrentFiles";

/**
 * The range a given adapter allows, for the form and for clamping.
 *
 * Looked up by id from the definitions rather than taken from a runtime adapter, so the
 * connection form can call it in the browser without pulling ssh2 and the cloud SDKs into the
 * client bundle.
 */
export function transferConcurrencyRange(adapterId: string): { default: number; max: number } {
    return ADAPTER_DEFINITIONS.find((d) => d.id === adapterId)?.transferConcurrency
        ?? DEFAULT_TRANSFER_CONCURRENCY;
}

/**
 * How many files to transfer at once for one connection.
 *
 * This lives on the connection rather than in a global setting because the right number is a
 * property of the server at the other end: the same installation may back up from a NAS that
 * welcomes sixteen parallel transfers and from a rate-limited cloud drive that does not. One
 * number cannot serve both, and the one that is safe for the slower destination wastes the
 * faster one.
 *
 * The stored value is clamped rather than trusted: it reaches here from a JSON config that a
 * restored export or a hand-edited database can put anything into, and a value above the
 * adapter's ceiling is exactly what that ceiling exists to prevent.
 */
export function resolveTransferConcurrency(
    adapterId: string,
    config: AdapterConfig | undefined
): number {
    const { default: fallback, max } = transferConcurrencyRange(adapterId);
    const stored = (config as Record<string, unknown> | undefined)?.[TRANSFER_CONCURRENCY_KEY];
    const parsed = typeof stored === "number" ? stored : parseInt(String(stored ?? ""), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(1, Math.floor(parsed)));
}
