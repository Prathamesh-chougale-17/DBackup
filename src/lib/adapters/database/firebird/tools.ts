import type { ExecutionHost } from "@/lib/transport";

/**
 * Locating Firebird's command line tools on whichever machine will run them.
 *
 * This is more than a PATH lookup, which is why it does not simply call
 * `host.which()`: several distributions ship an unrelated `isql` from unixODBC
 * with a completely different CLI and no Firebird connectivity at all. Every
 * candidate is therefore verified before it is accepted.
 */

/** Well-known install locations for when the tools are not on PATH. */
const FALLBACK_DIRS = [
    "/opt/firebird/bin", // Linux (Docker image, manual client extraction)
    "/opt/homebrew/firebird-client/bin", // macOS, Apple Silicon (setup-dev-macos.sh)
    "/usr/local/firebird-client/bin", // macOS, Intel (setup-dev-macos.sh)
    "/Library/Frameworks/Firebird.framework/Resources/bin", // macOS, official installer
];

/** Some distributions rename Firebird's isql to avoid the unixODBC clash. */
const ISQL_NAMES = ["isql", "isql-fb"];
const GBAK_NAMES = ["gbak"];

const VERIFY_TIMEOUT_MS = 3_000;

/** Resolved binaries per host, so the probing runs once per connection scope. */
const cache = new WeakMap<ExecutionHost, Map<string, Promise<string>>>();

/**
 * Check that a path really is a Firebird tool.
 *
 * `-z` prints a "... Firebird X.Y" banner even when the process then exits
 * non-zero for missing arguments, which is gbak's case. Firebird's isql prints
 * the banner and then waits for input on stdin, so stdin is closed immediately
 * and the process is killed after a short grace period. Whatever was already
 * buffered is what gets inspected, which is all this needs.
 */
async function isFirebirdBinary(host: ExecutionHost, path: string): Promise<boolean> {
    try {
        const proc = await host.spawn([path, "-z"], { stdin: true });
        proc.stdin?.end();

        let output = "";
        proc.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
        proc.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });

        const timer = setTimeout(() => proc.kill(), VERIFY_TIMEOUT_MS);
        try {
            await proc.exit();
        } finally {
            clearTimeout(timer);
        }

        return /firebird/i.test(output);
    } catch {
        return false;
    }
}

async function resolve(host: ExecutionHost, names: string[]): Promise<string> {
    // 1. Names on PATH, but only once verified as Firebird's own.
    for (const name of names) {
        const found = await host.which(name).catch(() => null);
        if (found && (await isFirebirdBinary(host, found))) {
            return name;
        }
    }

    // 2. Well-known absolute locations, for hosts where PATH is not set up.
    for (const dir of FALLBACK_DIRS) {
        for (const name of names) {
            const fullPath = `${dir}/${name}`;
            if (await isFirebirdBinary(host, fullPath)) {
                return fullPath;
            }
        }
    }

    // 3. Nothing verified. Return the first candidate and let the actual command
    //    fail with a readable "command not found".
    return names[0];
}

function memoized(host: ExecutionHost, key: string, names: string[]): Promise<string> {
    let perHost = cache.get(host);
    if (!perHost) {
        perHost = new Map();
        cache.set(host, perHost);
    }

    let pending = perHost.get(key);
    if (!pending) {
        pending = resolve(host, names);
        perHost.set(key, pending);
        pending.catch(() => perHost.delete(key));
    }
    return pending;
}

export function getGbakCommand(host: ExecutionHost): Promise<string> {
    return memoized(host, "gbak", GBAK_NAMES);
}

export function getIsqlCommand(host: ExecutionHost): Promise<string> {
    return memoized(host, "isql", ISQL_NAMES);
}
