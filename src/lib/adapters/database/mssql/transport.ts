import { PREFIXED_SSH_KEYS, readSshConfig } from "@/lib/transport";
import type { TransportResolver, TransportSpec } from "@/lib/transport";

/**
 * MSSQL's transport convention.
 *
 * MSSQL is the only adapter with two independent settings, because SQL Server
 * writes its own .bak files: `connectionMode` decides how DBackup reaches the
 * server, and the older `fileTransferMode` decides how the .bak file travels.
 *
 *   connectionMode  fileTransferMode  commands / TDS        files
 *   --------------  ----------------  --------------------  ------------------
 *   "ssh"           ignored           SSH (TDS tunnelled)   same SSH connection
 *   direct          "ssh"             direct                SSH  (legacy)
 *   direct          "local"           direct                shared mount
 *
 * Stored rows predate `connectionMode` and simply do not have it. Since
 * resolveAdapterConfig returns decrypted JSON without ever running the Zod
 * schema, the `.default("direct")` never applies at runtime, so the fallback
 * lives here in code. That is what keeps existing setups on their current row.
 */

/** Legacy SFTP file transfer, kept working exactly as before. */
function usesLegacyFileTransfer(config: Record<string, unknown>): boolean {
    return config.fileTransferMode === "ssh" && Boolean(config.sshUsername);
}

function readMssqlSsh(config: Record<string, unknown>) {
    // MssqlSshTransfer fell back to the database host when sshHost was blank,
    // on the assumption that SQL Server and the SSH server are the same machine.
    return readSshConfig(config, PREFIXED_SSH_KEYS, { hostFallbackKey: "host" });
}

export const mssqlTransport: TransportResolver = (config): TransportSpec => {
    if (config.connectionMode === "ssh") {
        const ssh = readMssqlSsh(config);
        if (!ssh) {
            throw new Error(
                "Connection mode is set to SSH but the SSH username is missing. " +
                    "Check the source's SSH settings and its assigned SSH credential profile.",
            );
        }
        return { kind: "ssh", ssh };
    }

    if (usesLegacyFileTransfer(config)) {
        const ssh = readMssqlSsh(config);
        if (!ssh) {
            throw new Error(
                "File transfer is set to SSH but the SSH username is missing. " +
                    "Check the source's SSH settings and its assigned SSH credential profile.",
            );
        }
        return { kind: "composite", exec: { kind: "direct" }, files: { kind: "ssh", ssh } };
    }

    return { kind: "direct" };
};
