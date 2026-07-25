import { StorageAdapter, StorageSession, FileInfo, DirectoryBrowseEntry } from "@/lib/core/interfaces";
import { normalizeSshPrivateKey } from "@/lib/ssh/pkcs8-compat";
import { SFTPSchema } from "@/lib/adapters/definitions";
import Client from "ssh2-sftp-client";
import { createReadStream } from "fs";
import { Readable } from "stream";
import path from "path";
import { LogLevel, LogType } from "@/lib/core/logs";
import { logger } from "@/lib/logging/logger";
import { wrapError } from "@/lib/logging/errors";

const log = logger.child({ adapter: "sftp" });

interface SFTPConfig {
    host: string;
    port: number;
    username: string;
    password?: string;
    privateKey?: string;
    passphrase?: string;
    pathPrefix?: string;
}

/**
 * Opens an SFTP session.
 *
 * Exported because the Rsync adapter needs it too: rsync here is always carried over SSH
 * with the same credentials, and SFTP is a subsystem of that same SSH server - which is
 * what lets an rsync destination serve byte ranges despite rsync itself having no such
 * concept.
 */
export const connectSFTP = async (config: SFTPConfig): Promise<Client> => {
    // PKCS#8 encrypted keys (BEGIN ENCRYPTED PRIVATE KEY) are not supported by
    // ssh2-sftp-client. Decrypt them in-memory via Node.js crypto first.
    let privateKey = config.privateKey;
    if (privateKey?.includes("BEGIN ENCRYPTED PRIVATE KEY")) {
        if (!config.passphrase) {
            throw new Error("This private key is passphrase-protected. Please provide the passphrase.");
        }
        privateKey = normalizeSshPrivateKey(privateKey, config.passphrase);
    }
    const sftp = new Client();
    await sftp.connect({
        host: config.host,
        port: config.port,
        username: config.username,
        password: config.password,
        privateKey,
        // passphrase only needed for non-PKCS#8-encrypted keys
        passphrase: privateKey !== config.privateKey ? undefined : config.passphrase,
    });
    return sftp;
};

/** How many sibling names to name in a diagnostic - enough to recognise the place, short enough to read. */
const ROOT_HINT_ENTRIES = 12;

/**
 * Rewrites a path that failed because SFTP starts somewhere below the filesystem root.
 *
 * A chrooted SFTP service shows the confinement directory as "/", so a path written from the
 * real filesystem's point of view carries leading segments that do not exist inside it -
 * /volume1/Transfer/restore on a Synology whose SFTP root is /volume1. The give-away is that
 * one of the later segments *is* one of the folders visible at the login directory, which makes
 * the correction computable rather than something for the user to deduce.
 *
 * The outermost match wins, so as much of the original path as possible is kept, and every
 * candidate is confirmed against the server before being offered. A name matching by coincidence
 * would otherwise send the user off to try a path that fails the same way - the check costs one
 * stat and turns the guess into something known to exist.
 */
async function suggestRelativePath(
    sftp: Client,
    prefix: string,
    visibleFolders: readonly string[]
): Promise<string | undefined> {
    const segments = prefix.split('/').filter(Boolean);
    // Only leading segments can be the surplus - a match at 0 means the path was already correct
    // and something else is wrong, so there is nothing to suggest.
    for (let i = 1; i < segments.length; i++) {
        if (!visibleFolders.some((f) => f.toLowerCase() === segments[i].toLowerCase())) continue;
        const candidate = `/${segments.slice(i).join('/')}`;
        if (await sftp.exists(candidate) === 'd') return candidate;
    }
    return undefined;
}

/**
 * Explains where an unreachable path went wrong, from the server's own point of view.
 *
 * "Path not reachable" leaves two very different causes indistinguishable: SFTP may be confined
 * to a directory below the filesystem root (so an absolute path cannot resolve at all), or the
 * account may simply lack access to one segment. Walking the prefix top-down finds the exact
 * segment that stops being visible, and the login directory plus its contents show what the
 * account can see - which is the difference between "type a shorter path" and "grant access to
 * that folder". Where those two halves line up, the corrected path is named outright.
 *
 * Best-effort throughout: a server that refuses these probes must not replace the real error
 * with a diagnostic failure.
 */
async function describeSftpRoot(sftp: Client, prefix: string): Promise<string> {
    const parts: string[] = [];

    try {
        const segments = prefix.split('/').filter(Boolean);
        let walked = prefix.startsWith('/') ? '' : '.';
        let deepest = '';
        let missing = '';
        for (const segment of segments) {
            walked = `${walked}/${segment}`;
            if (await sftp.exists(walked) === 'd') { deepest = walked; continue; }
            missing = walked;
            break;
        }
        if (missing && deepest) {
            parts.push(`"${deepest}" is reachable, but "${missing}" inside it is not.`);
        } else if (missing) {
            parts.push(`The path is already unreachable at "${missing}".`);
        }
    } catch { /* Probing is optional - fall through to the login directory hint. */ }

    try {
        const root = await sftp.cwd();
        const entries = await sftp.list(root);
        const folders = entries.filter((e) => e.type === 'd').map((e) => e.name);
        const suggestion = await suggestRelativePath(sftp, prefix, folders);

        if (suggestion) {
            // The whole diagnosis collapses into one actionable sentence - the folder listing
            // would only be material for a deduction that has already been made here.
            parts.push(
                `This account starts at "${root}", where "${suggestion}" does exist, `
                + `so SFTP appears to be confined to a directory below the filesystem root. `
                + `Use "${suggestion}" as the path instead.`
            );
        } else {
            const names = folders.slice(0, ROOT_HINT_ENTRIES);
            // A truncated list reads as a complete one, and then a folder that is simply below
            // the cut-off looks like a folder that is not there - say how many were left out.
            const omitted = folders.length - names.length;
            const listed = omitted > 0 ? `${names.join(', ')} (and ${omitted} more)` : names.join(', ');
            parts.push(
                `This account starts at "${root}"`
                + (names.length ? ` and sees these folders there: ${listed}.` : ' and sees no folders there.')
            );
            parts.push(
                `If SFTP is confined to that directory, give the path relative to it instead of as an absolute filesystem path.`
            );
        }
    } catch { /* No cwd/list either - the leading sentence already says enough. */ }

    return parts.length ? ` ${parts.join(' ')}` : '';
}

/**
 * Creates a remote directory, never reaching above the adapter's configured path.
 *
 * ssh2-sftp-client's recursive mkdir walks *upwards* until it finds a directory that exists,
 * and it decides that by calling exists() - which reports false for a directory the account
 * may use but not stat. On a NAS that is the normal case: an account can write inside
 * /volume1/Transfer but cannot stat /volume1 itself, so the recursion climbed to the top and
 * tried to create /volume1, failing with "Permission denied /volume1" - a message pointing at
 * a path nobody asked for.
 *
 * The configured prefix is a precondition, not something to create: if it is missing, that is
 * reported as what it is. Only the segments below it are created, one at a time, so the walk
 * can never leave the area the account was given.
 */
async function ensureRemoteDir(
    sftp: Client,
    dir: string,
    pathPrefix: string | undefined,
    onLog?: (msg: string, level?: LogLevel, type?: LogType, details?: string) => void
): Promise<void> {
    if (await sftp.exists(dir) === 'd') return;

    const prefix = pathPrefix ? pathPrefix.replace(/\\/g, '/') : '';
    if (!prefix) {
        // No configured root to anchor to - the whole path is ours to create.
        if (onLog) onLog(`Creating remote directory: ${dir}`, 'info', 'storage');
        await sftp.mkdir(dir, true);
        return;
    }

    if (await sftp.exists(prefix) !== 'd') {
        throw new Error(
            `The configured path "${prefix}" does not exist or is not reachable for this account over SFTP.`
            + await describeSftpRoot(sftp, prefix)
        );
    }

    const relative = path.posix.relative(prefix, dir);
    // Outside the prefix entirely - refuse rather than climb out of the configured area.
    if (relative.startsWith('..')) {
        throw new Error(`Refusing to create '${dir}': it lies outside the configured path "${prefix}".`);
    }

    let current = prefix;
    for (const segment of relative.split('/').filter(Boolean)) {
        current = path.posix.join(current, segment);
        if (await sftp.exists(current) !== 'd') {
            if (onLog) onLog(`Creating remote directory: ${current}`, 'info', 'storage');
            await sftp.mkdir(current);
        }
    }
}

/**
 * Performs a single upload on an already-connected SFTP client. The directory
 * cache prevents redundant mkdir calls when reused across multiple uploads
 * (e.g. metadata sidecar + backup file in the same session).
 */
async function performSftpUpload(
    sftp: Client,
    config: SFTPConfig,
    localPath: string,
    remotePath: string,
    onProgress: ((percent: number) => void) | undefined,
    onLog: ((msg: string, level?: LogLevel, type?: LogType, details?: string) => void) | undefined,
    dirCache: Set<string>
): Promise<boolean> {
    try {
        const destination = config.pathPrefix
            ? path.posix.join(config.pathPrefix, remotePath)
            : remotePath;

        const remoteDir = path.posix.dirname(destination);
        if (!dirCache.has(remoteDir)) {
            await ensureRemoteDir(sftp, remoteDir, config.pathPrefix, onLog);
            dirCache.add(remoteDir);
        }

        if (onLog) onLog(`Starting SFTP upload to: ${destination}`, 'info', 'storage');

        const stats = await import('fs').then(fs => fs.promises.stat(localPath));
        const totalSize = stats.size;

        const fileStream = createReadStream(localPath);
        try {
            await sftp.put(fileStream, destination, {
                step: (total_transferred: any, _chunk: any, _total: any) => {
                    if (onProgress && totalSize > 0) {
                        const percent = Math.round((total_transferred / totalSize) * 100);
                        onProgress(percent);
                    }
                }
            } as any);
        } finally {
            fileStream.destroy();
        }

        if (onLog) onLog(`SFTP upload completed successfully`, 'info', 'storage');
        return true;
    } catch (error: unknown) {
        log.error("SFTP upload failed", { host: config.host, remotePath }, wrapError(error));
        if (onLog && error instanceof Error) onLog(`SFTP upload failed: ${error.message}`, 'error', 'storage', error.stack);
        return false;
    }
}

export const SFTPAdapter: StorageAdapter = {
    id: "sftp",
    type: "storage",
    name: "SFTP (SSH)",
    configSchema: SFTPSchema,
    credentials: { primary: "SSH_KEY" },

    async openSession(config: SFTPConfig, onLog?): Promise<StorageSession> {
        const sftp = await connectSFTP(config);
        if (onLog) onLog(`Connected to SFTP ${config.host}:${config.port}`, 'info', 'storage');
        const dirCache = new Set<string>();
        return {
            upload: (localPath, remotePath, onProgress, uploadLog) =>
                performSftpUpload(sftp, config, localPath, remotePath, onProgress, uploadLog ?? onLog, dirCache),
            close: async () => {
                await sftp.end().catch(() => { });
            },
        };
    },

    async upload(config: SFTPConfig, localPath: string, remotePath: string, onProgress?: (percent: number) => void, onLog?: (msg: string, level?: LogLevel, type?: LogType, details?: string) => void): Promise<boolean> {
        let sftp: Client | null = null;
        try {
            sftp = await connectSFTP(config);
            if (onLog) onLog(`Connected to SFTP ${config.host}:${config.port}`, 'info', 'storage');
            return await performSftpUpload(sftp, config, localPath, remotePath, onProgress, onLog, new Set());
        } catch (error: unknown) {
            log.error("SFTP upload failed", { host: config.host, remotePath }, wrapError(error));
            if (onLog && error instanceof Error) onLog(`SFTP upload failed: ${error.message}`, 'error', 'storage', error.stack);
            return false;
        } finally {
            if (sftp) await sftp.end();
        }
    },

    async list(config: SFTPConfig, dir: string = ""): Promise<FileInfo[]> {
        let sftp: Client | null = null;
        try {
            sftp = await connectSFTP(config);

            // Normalize path helper
            const normalize = (p: string) => p.replace(/\\/g, '/');

            // Determine where to start listing
            const prefix = config.pathPrefix ? normalize(config.pathPrefix) : "";
            const startDir = prefix
                ? path.posix.join(prefix, dir)
                : (dir || ".");

            const files: FileInfo[] = [];

            // Helper for recursive listing
            const walk = async (currentDir: string) => {
                const items = await sftp!.list(currentDir);

                for (const item of items) {
                    const fullPath = path.posix.join(currentDir, item.name);

                    if (item.type === 'd') {
                        await walk(fullPath);
                    } else if (item.type === '-') {
                        // Calculate UI-friendly relative path
                        // e.g. /home/user/backups/Job1/file.sql -> Job1/file.sql (if prefix is /home/user/backups)
                        let relativePath = fullPath;

                        // Strip the prefix part to make it relative to the "root" of the adapter
                        if (prefix && fullPath.startsWith(prefix)) {
                            relativePath = fullPath.substring(prefix.length);
                        }

                        // Remove leading slash
                        if (relativePath.startsWith('/')) relativePath = relativePath.substring(1);

                        files.push({
                            name: item.name,
                            path: relativePath,
                            size: item.size,
                            lastModified: new Date(item.modifyTime),
                        });
                    }
                }
            };

            // Start walking if directory exists
            const type = await sftp.exists(startDir);
            if (type === 'd') {
                await walk(startDir);
            }

            return files;

        } catch (error) {
            log.error("SFTP list failed", { host: config.host, dir }, wrapError(error));
            throw error;
        } finally {
            if (sftp) await sftp.end();
        }
    },

    async browseDirectories(config: SFTPConfig, subPath: string = ""): Promise<DirectoryBrowseEntry[]> {
        let sftp: Client | null = null;
        try {
            sftp = await connectSFTP(config);
            const startDir = config.pathPrefix
                ? path.posix.join(config.pathPrefix, subPath)
                : (subPath || ".");

            const type = await sftp.exists(startDir);
            if (type !== 'd') return [];

            const items = await sftp.list(startDir);
            return items
                .filter((item) => item.type === 'd')
                .map((item) => ({
                    name: item.name,
                    path: subPath ? `${subPath}/${item.name}` : item.name,
                }));
        } catch (error) {
            log.error("SFTP browseDirectories failed", { host: config.host, subPath }, wrapError(error));
            throw error;
        } finally {
            if (sftp) await sftp.end();
        }
    },

    async downloadRange(config: SFTPConfig, remotePath: string, start: number, end: number): Promise<NodeJS.ReadableStream> {
        // An empty range is legal - a zero-length file's archive entry produces one.
        if (end < start) return Readable.from([]);

        const sftp = await connectSFTP(config);
        const source = config.pathPrefix ? path.posix.join(config.pathPrefix, remotePath) : remotePath;

        try {
            // createReadStream's `end` is inclusive, matching the capability's contract.
            const stream = sftp.createReadStream(source, { start, end }) as NodeJS.ReadableStream;
            // The connection has to outlive the stream, so it is closed on completion
            // rather than in a finally block here.
            const close = () => { void sftp.end().catch(() => { }); };
            stream.on("end", close);
            stream.on("error", close);
            stream.on("close", close);
            return stream;
        } catch (error) {
            await sftp.end().catch(() => { });
            log.error("SFTP ranged download failed", { host: config.host, remotePath, start, end }, wrapError(error));
            throw error;
        }
    },

    async download(config: SFTPConfig, remotePath: string, localPath: string, onProgress?: (processed: number, total: number) => void): Promise<boolean> {
        let sftp: Client | null = null;
        try {
            sftp = await connectSFTP(config);

            const source = config.pathPrefix
                ? path.posix.join(config.pathPrefix, remotePath)
                : remotePath;

            if (onProgress) {
                const stat = await sftp.stat(source);
                const total = stat.size;
                let processed = 0;
                await sftp.fastGet(source, localPath, {
                    step: (transferred) => {
                        processed = transferred;
                        onProgress(processed, total);
                    }
                });
            } else {
                await sftp.get(source, localPath);
            }
            return true;
        } catch (error) {
            log.error("SFTP download failed", { host: config.host, remotePath }, wrapError(error));
            return false;
        } finally {
            if (sftp) await sftp.end();
        }
    },

    async read(config: SFTPConfig, remotePath: string): Promise<string | null> {
        let sftp: Client | null = null;
        try {
            sftp = await connectSFTP(config);

            const source = config.pathPrefix
                ? path.posix.join(config.pathPrefix, remotePath)
                : remotePath;

            // get returns Buffer or string depending on options/destination
            // passing undefined as dst makes it return a buffer
            const buffer = await sftp.get(source);
            if (buffer instanceof Buffer) {
                return buffer.toString('utf-8');
            }
            return null;
        } catch (_error) {
            // Quietly fail if file not found (expected for missing .meta.json)
            return null;
        } finally {
            if (sftp) await sftp.end();
        }
    },

    async delete(config: SFTPConfig, remotePath: string): Promise<boolean> {
        let sftp: Client | null = null;
        try {
            sftp = await connectSFTP(config);

            const source = config.pathPrefix
                ? path.posix.join(config.pathPrefix, remotePath)
                : remotePath;

            await sftp.delete(source);
            return true;
        } catch (error) {
            log.error("SFTP delete failed", { host: config.host, remotePath }, wrapError(error));
            return false;
        } finally {
            if (sftp) await sftp.end();
        }
    },

    async ping(config: SFTPConfig): Promise<{ success: boolean; message: string }> {
        let sftp: Client | null = null;
        try {
            sftp = await connectSFTP(config);
            const checkPath = config.pathPrefix || '.';
            await sftp.stat(checkPath);
            return { success: true, message: "Connection successful" };
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            return { success: false, message: `SFTP Connection failed: ${message}` };
        } finally {
            if (sftp) await sftp.end();
        }
    },

    async test(config: SFTPConfig): Promise<{ success: boolean; message: string }> {
        let sftp: Client | null = null;
        const ts = new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
        const testFileName = `.dbackup/test/connection-test-sftp-${ts}`;
        const destination = config.pathPrefix
            ? path.posix.join(config.pathPrefix, testFileName)
            : testFileName;
        const subdir = config.pathPrefix
            ? path.posix.join(config.pathPrefix, '.dbackup/test')
            : '.dbackup/test';
        let remoteFileCreated = false;
        try {
            sftp = await connectSFTP(config);

            await ensureRemoteDir(sftp, subdir, config.pathPrefix);

            // 1. Write Test
            await sftp.put(Buffer.from("Connection Test"), destination);
            remoteFileCreated = true;

            // 2. Delete Test
            await sftp.delete(destination);
            remoteFileCreated = false;

            return { success: true, message: "Connection successful (Write/Delete verified)" };
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            return { success: false, message: `SFTP Connection failed: ${message}` };
        } finally {
            if (remoteFileCreated) await sftp?.delete(destination).catch(() => {});
            if (sftp) await sftp.end();
        }
    }

};
