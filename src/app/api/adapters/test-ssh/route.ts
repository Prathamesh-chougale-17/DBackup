import { NextRequest, NextResponse } from "next/server";
import { registry } from "@/lib/core/registry";
import { SshHost, createHost, resolveTransport, type TransportSpec, type SshConnectionConfig } from "@/lib/transport";
import type { DatabaseAdapter } from "@/lib/core/interfaces";
import { headers } from "next/headers";
import { getAuthContext, checkPermissionWithContext } from "@/lib/auth/access-control";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { checkBackupPath } from "@/lib/adapters/database/mssql/preflight";
import { MSSQLConfig } from "@/lib/adapters/definitions";
import { overlayCredentialsOnConfig } from "@/lib/adapters/config-resolver";
import { registerAdapters } from "@/lib/adapters";
import { logger } from "@/lib/logging/logger";
import { wrapError } from "@/lib/logging/errors";

registerAdapters();

const log = logger.child({ route: "adapters/test-ssh" });

export async function POST(req: NextRequest) {
    const ctx = await getAuthContext(await headers());

    if (!ctx) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    checkPermissionWithContext(ctx, PERMISSIONS.SOURCES.VIEW);

    try {
        const body = await req.json();
        const { config, adapterId, sshCredentialId } = body as { config: Record<string, any>; adapterId?: string; sshCredentialId?: string | null };

        if (!config) {
            return NextResponse.json(
                { success: false, message: "Missing config" },
                { status: 400 }
            );
        }

        // Resolve SSH credential profile if provided. This overlays sshUsername,
        // sshAuthType, sshPassword, sshPrivateKey, and sshPassphrase from the
        // stored credential record onto the config, so callers using a credential
        // profile do not need to include these fields inline.
        let resolvedConfig = { ...config };
        if (adapterId && sshCredentialId) {
            try {
                resolvedConfig = await overlayCredentialsOnConfig(
                    adapterId,
                    resolvedConfig,
                    null,
                    sshCredentialId
                ) as Record<string, any>;
            } catch (overlayError: unknown) {
                log.warn("Failed to overlay SSH credential", { adapterId, sshCredentialId }, wrapError(overlayError));
                return NextResponse.json(
                    { success: false, message: "Failed to resolve SSH credential profile" },
                    { status: 400 }
                );
            }
        }

        // Which SSH parameters a config carries is the adapter's own business:
        // SQLite stores mode/host/username where everyone else stores
        // connectionMode/sshHost/sshUsername. Asking the adapter's resolver
        // replaces the hand-rolled field lifting that used to live here.
        const adapter = adapterId ? registry.get(adapterId) : undefined;
        let spec: TransportSpec;
        try {
            spec = resolveTransport(
                { id: adapterId ?? "ssh", transport: (adapter as DatabaseAdapter | undefined)?.transport },
                { ...resolvedConfig, connectionMode: "ssh" },
            );
        } catch (resolveError: unknown) {
            return NextResponse.json(
                { success: false, message: resolveError instanceof Error ? resolveError.message : "Invalid SSH configuration" },
                { status: 400 },
            );
        }

        if (spec.kind !== "ssh") {
            return NextResponse.json(
                { success: false, message: "SSH username is required" },
                { status: 400 },
            );
        }

        const sshHost = spec.ssh.host;
        const sshPort = spec.ssh.port ?? 22;

        // Only SQL Server has a backup directory that both the server and the
        // SSH account have to reach. Testing that here used to key off
        // `connectionMode === "ssh"` alone, which is true for every adapter in
        // SSH mode, so a MySQL or PostgreSQL source was told its SQL Server
        // backup path was missing.
        if (adapterId === "mssql") {
            return testMssqlSsh(resolvedConfig as MSSQLConfig, spec, sshHost, sshPort);
        }

        // Generic SSH connection test for all other adapters
        return testGenericSsh(spec.ssh, sshHost, sshPort);
    } catch (error: unknown) {
        log.error("SSH test route error", {}, wrapError(error));
        const message =
            error instanceof Error ? error.message : "Unknown error";
        return NextResponse.json(
            { success: false, message },
            { status: 500 }
        );
    }
}

/**
 * Generic SSH test: connect and run a simple echo command.
 */
async function testGenericSsh(sshConfig: SshConnectionConfig, sshHost: string, sshPort: number) {
    const host = new SshHost(sshConfig);
    try {
        const result = await host.exec(["echo", "connected"]);

        if (result.code === 0) {
            return NextResponse.json({
                success: true,
                message: `SSH connection to ${sshHost}:${sshPort} successful`,
            });
        }

        return NextResponse.json({
            success: false,
            message: `SSH connected but test command failed: ${result.stderr.trim()}`,
        });
    } catch (connectError: unknown) {
        const message = connectError instanceof Error ? connectError.message : "SSH connection failed";
        log.warn("SSH test failed", { sshHost }, wrapError(connectError));
        return NextResponse.json({ success: false, message });
    } finally {
        await host.dispose().catch(() => {});
    }
}

/**
 * MSSQL SSH test: connect and verify the backup directory is usable, since a
 * problem there only surfaces as a missing .bak in the middle of a backup.
 */
async function testMssqlSsh(
    config: MSSQLConfig,
    spec: TransportSpec,
    sshHost: string,
    sshPort: number,
) {
    const backupPath = config.backupPath || "/var/opt/mssql/backup";
    const host = createHost(spec);

    try {
        const result = await checkBackupPath(host, backupPath);

        if (!result.readable) {
            return NextResponse.json({
                success: false,
                message: `SSH connection to ${sshHost}:${sshPort} successful, but backup path is not accessible: ${backupPath}${result.error ? ` (${result.error})` : ""}`,
            });
        }

        if (!result.writable) {
            return NextResponse.json({
                success: false,
                message: `SSH connection to ${sshHost}:${sshPort} successful, but backup path is read-only: ${backupPath}`,
            });
        }

        return NextResponse.json({
            success: true,
            message: `SSH connection to ${sshHost}:${sshPort} successful - backup path ${backupPath} is readable and writable`,
        });
    } catch (connectError: unknown) {
        const message = connectError instanceof Error ? connectError.message : "SSH connection failed";
        log.warn("SSH test failed", { sshHost }, wrapError(connectError));
        return NextResponse.json({ success: false, message });
    } finally {
        await host.dispose().catch(() => {});
    }
}
