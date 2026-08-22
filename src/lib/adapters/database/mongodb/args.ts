import type { MongoDBConfig } from "@/lib/adapters/definitions";
import type { ExecutionHost } from "@/lib/transport"

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

/**
 * DNS zones that publish an SRV record and no A record.
 *
 * An Atlas cluster is reached as `cluster0.xxxxx.mongodb.net`, but that name
 * resolves to nothing. Only `_mongodb._tcp.cluster0.xxxxx.mongodb.net` exists,
 * and it points at the shard hostnames. A plain `mongodb://host:port` therefore
 * fails with ENOTFOUND before a connection is ever attempted, which is why the
 * same cluster works in Compass (it connects with `mongodb+srv://`) and not here.
 */
const SRV_ZONES = [".mongodb.net", ".mongodb-dev.net", ".mongodb-qa.net"];

/** Where the client should connect, once the Host field has been made sense of. */
interface MongoTarget {
    /** Authority for a connection string: `host:port`, a bare host for SRV, or a comma-separated list. */
    authority: string;
    /** First host, for the `--host` flag path. */
    host: string;
    /** Port belonging to that first host, for the `--port` flag path. */
    port: number;
    /** Connect with `mongodb+srv://`, which resolves the SRV record and implies TLS. */
    srv: boolean;
    /** Several hosts were given, which only a connection string can express. */
    multiHost: boolean;
}

/**
 * Reads the Host field the way a user actually fills it in.
 *
 * The field asks for a hostname, but people paste what their provider gave them:
 * a full connection string, a host with a trailing slash, a host with the port
 * already attached, or the seed list of a replica set. Every one of those
 * produces a broken URI when concatenated blindly, so the host is reduced to its
 * authority component first.
 *
 * An explicit `mongodb+srv://` scheme selects SRV. Otherwise the zone decides,
 * which is what makes an Atlas cluster work with nothing but its hostname typed in.
 */
export function parseMongoTarget(config: AnyMongoConfig): MongoTarget {
    let raw = (config.host || "127.0.0.1").trim();
    let srv = false;

    const scheme = /^(mongodb(?:\+srv)?):\/\//i.exec(raw);
    if (scheme) {
        srv = scheme[1].toLowerCase() === "mongodb+srv";
        raw = raw.slice(scheme[0].length);
    }

    // A pasted connection string carries its own credentials. They are dropped:
    // the login comes from the credential profile, and keeping both would produce
    // two userinfo sections in one URI.
    const at = raw.lastIndexOf("@");
    if (at !== -1) raw = raw.slice(at + 1);

    // Path, query and fragment are not part of the host.
    raw = raw.split(/[/?#]/)[0];

    const defaultPort = Number(config.port) || 27017;
    const entries = raw
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => {
            // A port typed into the Host field is the more specific answer, so it
            // wins over the Port field. The bracket alternative keeps IPv6 literals intact.
            const withPort = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(entry);
            return withPort
                ? { host: withPort[1], port: Number(withPort[2]) }
                : { host: entry, port: defaultPort };
        });

    const hosts = entries.length > 0 ? entries : [{ host: "127.0.0.1", port: defaultPort }];

    if (!srv) {
        const lower = hosts[0].host.toLowerCase();
        srv = SRV_ZONES.some((zone) => lower.endsWith(zone));
    }

    // An SRV record carries a port per host, so naming one alongside it is
    // rejected as an invalid connection string.
    const authority = srv
        ? hosts[0].host
        : hosts.map((entry) => `${entry.host}:${entry.port}`).join(",");

    return {
        authority,
        host: hosts[0].host,
        port: hosts[0].port,
        srv,
        multiHost: !srv && hosts.length > 1,
    };
}

/** Connection flags for mongosh, mongodump and mongorestore. */
export function buildConnectionArgs(config: AnyMongoConfig): string[] {
    if (config.uri) {
        return [`--uri=${config.uri}`];
    }

    const { host, port, srv, multiHost } = parseMongoTarget(config);

    // An SRV hostname has no address record, so --host cannot resolve it, and a
    // seed list does not fit into one --host either. The database tools take the
    // same URI the driver does, so hand them that instead.
    if (srv || multiHost) {
        return [`--uri=${buildConnectionUri(config)}`];
    }

    const args = ["--host", host, "--port", String(port)];

    if (config.user && config.password) {
        args.push("--username", config.user);
        args.push("--password", config.password);
        args.push("--authenticationDatabase", config.authenticationDatabase || "admin");
    }

    return args;
}

/**
 * Connection flags for an operation that must cover the whole MongoDB instance.
 *
 * A database in a legacy inline URI acts like a database selection for
 * the MongoDB database tools. Remove that path while keeping its authentication
 * meaning and every existing URI option intact.
 */
export function buildFullInstanceConnectionArgs(config: AnyMongoConfig): string[] {
    if (!config.uri) return buildConnectionArgs(config);

    const match = /^(mongodb(?:\+srv)?:\/\/)([^/?#]+)(?:\/([^?#]*))?(\?[^#]*)?(#.*)?$/i.exec(config.uri);
    if (!match) return buildConnectionArgs(config);

    const [, scheme, authority, database = "", query = "", fragment = ""] = match;
    const queryBody = query.startsWith("?") ? query.slice(1) : query;
    const normalizedQuery = queryBody ? `?${queryBody}` : "";
    const hasAuthSource = /(?:^|[&;])authSource=/i.test(queryBody);
    const authSource = database && !hasAuthSource
        ? `${queryBody ? "&" : "?"}authSource=${database}`
        : "";

    return [`--uri=${scheme}${authority}/${normalizedQuery}${authSource}${fragment}`];
}

/**
 * Run a MongoDB database tool without exposing URI credentials or passwords in argv.
 *
 * MongoDB Database Tools 100.3 and newer support a 0600 YAML config file for
 * sensitive connection values. The execution host creates that file beside the
 * tool, including over SSH, and removes it after the process exits.
 */
export async function withMongoToolConnectionArgs<T>(
    host: ExecutionHost,
    connectionArgs: string[],
    fn: (args: string[]) => Promise<T>,
): Promise<T> {
    const safeArgs: string[] = []
    let uri: string | undefined
    let password: string | undefined

    let index = 0
    while (index < connectionArgs.length) {
        const arg = connectionArgs[index]

        if (arg.startsWith("--uri=")) {
            uri = arg.slice("--uri=".length)
            index++
            continue
        }
        if (arg === "--uri" && connectionArgs[index + 1] !== undefined) {
            uri = connectionArgs[index + 1]
            index += 2
            continue
        }
        if (arg.startsWith("--password=")) {
            password = arg.slice("--password=".length)
            index++
            continue
        }
        if (arg === "--password" && connectionArgs[index + 1] !== undefined) {
            password = connectionArgs[index + 1]
            index += 2
            continue
        }

        safeArgs.push(arg)
        index++
    }

    if (uri === undefined && password === undefined) {
        return fn(safeArgs)
    }

    const configContent = [
        uri === undefined ? undefined : `uri: ${JSON.stringify(uri)}`,
        password === undefined ? undefined : `password: ${JSON.stringify(password)}`,
    ].filter((line): line is string => line !== undefined).join("\n") + "\n"

    return host.withTempFile(
        { content: configContent, mode: 0o600, suffix: ".yaml" },
        (configPath) => fn([`--config=${configPath}`, ...safeArgs]),
    )
}

/**
 * Connection arguments for mongosh.
 *
 * mongosh takes a connection string as a positional argument and has no `--uri`
 * flag, so the two builders cannot be the same function.
 */
export function buildShellConnectionArgs(config: AnyMongoConfig): string[] {
    if (config.uri) {
        return [config.uri];
    }

    const { srv, multiHost } = parseMongoTarget(config);
    if (srv || multiHost) {
        return [buildConnectionUri(config)];
    }
    return buildConnectionArgs(config);
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

    const { authority, srv } = parseMongoTarget(config);

    const auth = config.user && config.password
        ? `${encodeURIComponent(config.user)}:${encodeURIComponent(config.password)}@`
        : "";
    const authDb = config.authenticationDatabase || "admin";
    const authParam = config.user ? `?authSource=${encodeURIComponent(authDb)}` : "";
    const scheme = srv ? "mongodb+srv" : "mongodb";

    return `${scheme}://${auth}${authority}/${authParam}`;
}

/**
 * Replace secrets with stars for anything that gets logged.
 *
 * Covers both shapes the password can take: its own argument, and the userinfo
 * section of a connection string that is passed as one argument.
 */
export function maskSecrets(argv: string[], password?: string): string {
    return argv
        .map((arg) => (password && arg === password ? "******" : arg))
        .map((arg) => arg.replace(/(mongodb(?:\+srv)?:\/\/[^:/@\s]+:)[^@\s]+@/gi, "$1******@"))
        .join(" ");
}

/** Databases MongoDB manages itself, which are never backup targets. */
export const SYSTEM_DATABASES = ["admin", "config", "local"];

export const MONGOSH = ["mongosh", "mongo"] as const;
export const MONGODUMP = ["mongodump"] as const;
export const MONGORESTORE = ["mongorestore"] as const;
