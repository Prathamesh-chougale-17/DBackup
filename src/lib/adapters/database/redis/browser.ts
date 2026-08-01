import type { ExecutionHost } from "@/lib/transport";
import { RedisConfig } from "@/lib/adapters/definitions";
import { TableInfo, ColumnInfo, TableDataOptions, TableDataResult } from "@/lib/core/interfaces";
import { REDIS_CLI, buildConnectionArgs } from "./args";

const SCAN_LIMIT = 200;

const COLUMNS: ColumnInfo[] = [
    { name: "key", dataType: "string", nullable: false, primaryKey: true },
    { name: "type", dataType: "string", nullable: false },
    { name: "ttl", dataType: "integer", nullable: false },
];

/**
 * Connection args pinned to one database index.
 *
 * buildConnectionArgs omits -n for database 0 because that is redis-cli's
 * default. The browser is always looking at a specific database, so index 0 is
 * stated explicitly here.
 */
function buildArgs(config: RedisConfig, dbIndex: number): string[] {
    const args = buildConnectionArgs({ ...config, database: dbIndex });
    return dbIndex === 0 ? [...args, "-n", "0"] : args;
}

/** Lua script: returns {type}\t{ttl} for each key passed as KEYS array. */
const luaTypesTtl = `local r={} for i,k in ipairs(KEYS) do local t=redis.call('TYPE',k)['ok'] local ttl=redis.call('TTL',k) r[i]=t..'\\t'..tostring(ttl) end return r`;

function parseLuaArray(stdout: string): string[] {
    return stdout
        .split("\n")
        .map(l => l.trim())
        .filter(Boolean)
        .map(l => l.replace(/^\d+\)\s*"?/, "").replace(/"$/, ""))
        .filter(Boolean);
}

async function getKeyInfo(
    host: ExecutionHost,
    redisCli: string,
    keys: string[],
    cliArgs: string[],
): Promise<Array<{ key: string; type: string; ttl: number }>> {
    if (keys.length === 0) return [];

    // The keys go through as separate arguments, so a key containing a quote or
    // a space cannot break out of the command. The SSH path used to paste them
    // into a shell string.
    const result = await host.exec([
        redisCli, ...cliArgs, "EVAL", luaTypesTtl, String(keys.length), ...keys,
    ]);
    if (result.code !== 0) {
        return keys.map(key => ({ key, type: "unknown", ttl: -1 }));
    }

    const results = parseLuaArray(result.stdout);
    return keys.map((key, i) => {
        const parts = (results[i] ?? "").split("\t");
        return { key, type: parts[0] ?? "unknown", ttl: parseInt(parts[1] ?? "-1", 10) };
    });
}

export async function getTables(config: RedisConfig, database: string, host: ExecutionHost): Promise<TableInfo[]> {
    const dbIndex = parseInt(database, 10);
    const redisCli = await host.which(...REDIS_CLI);
    const cliArgs = buildArgs(config, dbIndex);

    const result = await host.exec([redisCli, ...cliArgs, "DBSIZE"]);
    const rowCount = result.code === 0 ? parseInt(result.stdout.trim(), 10) || 0 : 0;
    return [{ name: "Keys", type: "table", rowCount }];
}

export async function getTableData(
    config: RedisConfig,
    options: TableDataOptions,
    host: ExecutionHost,
): Promise<TableDataResult> {
    const dbIndex = parseInt(options.database, 10);
    const redisCli = await host.which(...REDIS_CLI);
    const cliArgs = buildArgs(config, dbIndex);

    const [dbsize, scan] = await Promise.all([
        host.exec([redisCli, ...cliArgs, "DBSIZE"]),
        host.exec([redisCli, ...cliArgs, "SCAN", "0", "COUNT", String(SCAN_LIMIT)]),
    ]);

    const totalCount = dbsize.code === 0 ? parseInt(dbsize.stdout.trim(), 10) || 0 : 0;
    const scanLines = scan.stdout.split("\n").map(l => l.trim()).filter(Boolean);
    const keys = scanLines.slice(1); // The first line is the cursor.

    const keyInfo = await getKeyInfo(host, redisCli, keys, cliArgs);
    const rows: Record<string, unknown>[] = keyInfo.map(({ key, type, ttl }) => ({
        key,
        type,
        ttl: ttl === -1 ? "no expiry" : ttl === -2 ? "expired" : `${ttl}s`,
    }));

    return { rows, totalCount, columns: COLUMNS };
}
