import { NextRequest, NextResponse } from "next/server";
import { registry } from "@/lib/core/registry";
import { withHost } from "@/lib/transport";
import type { DatabaseAdapter } from "@/lib/core/interfaces";
import { registerAdapters } from "@/lib/adapters";
import { headers } from "next/headers";
import { getAuthContext, checkPermissionWithContext } from "@/lib/auth/access-control";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { DatabaseInfo } from "@/lib/core/interfaces";
import prisma from "@/lib/prisma";
import { resolveAdapterConfig } from "@/lib/adapters/config-resolver";

// Ensure adapters are registered
registerAdapters();

/**
 * POST /api/adapters/database-stats
 *
 * Returns databases with size and table count information for a given source.
 * Accepts either raw config (adapterId + config) or a saved source ID (sourceId).
 */
export async function POST(req: NextRequest) {
    const ctx = await getAuthContext(await headers());

    if (!ctx) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    checkPermissionWithContext(ctx, PERMISSIONS.SOURCES.VIEW);

    try {
        const body = await req.json();
        const { adapterId, config, sourceId } = body;

        let resolvedAdapterId = adapterId;
        let resolvedConfig = config;

        // If sourceId is provided, look up the adapter config from DB
        if (sourceId && !config) {
            const source = await prisma.adapterConfig.findUnique({
                where: { id: sourceId }
            });

            if (!source) {
                return NextResponse.json({ success: false, message: "Source not found" }, { status: 404 });
            }

            resolvedAdapterId = source.adapterId;
            resolvedConfig = await resolveAdapterConfig(source);
        }

        if (!resolvedAdapterId || !resolvedConfig) {
            return NextResponse.json({ success: false, message: "Missing adapterId/config or sourceId" }, { status: 400 });
        }

        const adapter = registry.get(resolvedAdapterId) as DatabaseAdapter | undefined;

        if (!adapter) {
            return NextResponse.json({ success: false, message: "Adapter not found" }, { status: 404 });
        }

        const withStats = adapter.getDatabasesWithStats;
        const listNames = adapter.getDatabases;
        if (!withStats && !listNames) {
            return NextResponse.json({ success: false, message: "This adapter does not support listing databases." });
        }

        const statsConfig = resolvedConfig;
        let serverVersion: string | undefined;
        let serverEdition: string | undefined;

        // One host for the whole request: listing databases and probing the
        // server version used to open two connections against the same machine.
        const databases: DatabaseInfo[] = await withHost(adapter, statsConfig, async (host) => {
            const listed = withStats
                ? await withStats(statsConfig, host)
                : (await listNames!(statsConfig, host)).map(name => ({ name }));

            if (adapter.test) {
                try {
                    const testResult = await adapter.test(statsConfig, host) as { success: boolean; version?: string; edition?: string };
                    if (testResult.success) {
                        serverVersion = testResult.version;
                        serverEdition = testResult.edition;
                    }
                } catch {
                    // Non-critical - version info is optional
                }
            }

            return listed;
        });

        return NextResponse.json({ success: true, databases, serverVersion, serverEdition });

    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return NextResponse.json({ success: false, message }, { status: 500 });
    }
}
