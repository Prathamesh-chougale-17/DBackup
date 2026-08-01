import type { ExecutionHost } from "@/lib/transport";
import { MongoDBConfig } from "@/lib/adapters/definitions";
import { DatabaseInfo } from "@/lib/core/interfaces";
import { withMongoMeta } from "./meta";

const NO_HOST_MESSAGE = "MongoDB adapter requires an execution host. Call it through withHost().";

export async function test(
    config: MongoDBConfig,
    host?: ExecutionHost,
): Promise<{ success: boolean; message: string; version?: string }> {
    if (!host) {
        return { success: false, message: NO_HOST_MESSAGE };
    }

    const via = host.kind === "ssh" ? " (via SSH)" : "";

    try {
        const version = await withMongoMeta(config, host, (meta) => meta.serverVersion());
        return { success: true, message: `Connection successful${via}`, version };
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, message: `Connection failed: ${message}` };
    }
}

export async function getDatabases(config: MongoDBConfig, host: ExecutionHost): Promise<string[]> {
    if (!host) throw new Error(NO_HOST_MESSAGE);

    try {
        return await withMongoMeta(config, host, (meta) => meta.listDatabaseNames());
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to list databases: ${message}`);
    }
}

export async function getDatabasesWithStats(config: MongoDBConfig, host: ExecutionHost): Promise<DatabaseInfo[]> {
    if (!host) throw new Error(NO_HOST_MESSAGE);

    try {
        const stats = await withMongoMeta(config, host, (meta) => meta.databaseStats());
        return stats.map((entry) => ({
            name: entry.name,
            sizeInBytes: entry.sizeOnDisk,
            tableCount: entry.collectionCount,
        }));
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to list databases with stats: ${message}`);
    }
}
