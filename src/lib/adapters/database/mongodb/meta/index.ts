import type { ExecutionHost } from "@/lib/transport";
import type { MongoDBConfig } from "@/lib/adapters/definitions";
import { DriverMongoMeta } from "./driver-meta";
import { ShellMongoMeta } from "./shell-meta";
import type { MongoMeta } from "./types";

export type { MongoMeta } from "./types";

/**
 * Pick the metadata implementation for a transport.
 *
 * This is the only place in the codebase that branches on `host.kind`, and it
 * is allow-listed in the transport lint guard for that reason. The branch is
 * not a leftover fork: the two modes genuinely cannot share an implementation.
 * `mongosh` is not part of the DBackup image, so direct mode cannot use it, and
 * there is no MongoDB tunnel yet, so SSH mode cannot reach the wire protocol.
 *
 * Once ExecutionHost.forwardPort is wired up for MongoDB the driver can serve
 * both and ShellMongoMeta can go away, along with this branch.
 */
export function openMongoMeta(config: MongoDBConfig, host: ExecutionHost): MongoMeta {
    return host.kind === "ssh"
        ? new ShellMongoMeta(config, host)
        : new DriverMongoMeta(config);
}

/** Run `fn` with a metadata client and close it afterwards. */
export async function withMongoMeta<T>(
    config: MongoDBConfig,
    host: ExecutionHost,
    fn: (meta: MongoMeta) => Promise<T>,
): Promise<T> {
    const meta = openMongoMeta(config, host);
    try {
        return await fn(meta);
    } finally {
        await meta.close().catch(() => {});
    }
}
