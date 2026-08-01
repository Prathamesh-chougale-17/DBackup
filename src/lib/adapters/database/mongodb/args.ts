import type { MongoDBConfig } from "@/lib/adapters/definitions";

/**
 * Connection arguments and URIs for the MongoDB tools.
 *
 * Raw argv only. Quoting belongs to the transport, and escaping here would
 * double-escape over SSH.
 */

type AnyMongoConfig = MongoDBConfig & {
    uri?: string;
    user?: string;
    password?: string;
    authenticationDatabase?: string;
};

/** Connection flags for mongosh, mongodump and mongorestore. */
export function buildConnectionArgs(config: AnyMongoConfig): string[] {
    if (config.uri) {
        return [`--uri=${config.uri}`];
    }

    const args = [
        "--host", config.host || "127.0.0.1",
        "--port", String(config.port || 27017),
    ];

    if (config.user && config.password) {
        args.push("--username", config.user);
        args.push("--password", config.password);
        args.push("--authenticationDatabase", config.authenticationDatabase || "admin");
    }

    return args;
}

/**
 * Connection URI for the native driver.
 *
 * A stored inline `uri` is honoured for sources created before that field was
 * deprecated. The UI no longer exposes it; new sources arrive with host/port
 * plus credentials resolved from the vault profile.
 */
export function buildConnectionUri(config: AnyMongoConfig): string {
    if (config.uri) return config.uri;

    const auth = config.user && config.password
        ? `${encodeURIComponent(config.user)}:${encodeURIComponent(config.password)}@`
        : "";
    const authDb = config.authenticationDatabase || "admin";
    const authParam = config.user ? `?authSource=${authDb}` : "";

    return `mongodb://${auth}${config.host}:${config.port}/${authParam}`;
}

/** Databases MongoDB manages itself, which are never backup targets. */
export const SYSTEM_DATABASES = ["admin", "config", "local"];

export const MONGOSH = ["mongosh", "mongo"] as const;
export const MONGODUMP = ["mongodump"] as const;
export const MONGORESTORE = ["mongorestore"] as const;
