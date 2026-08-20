
import { NextRequest, NextResponse } from "next/server";
import { restoreService } from "@/services/restore/restore-service";
import { headers } from "next/headers";
import { getAuthContext, checkPermissionWithContext } from "@/lib/auth/access-control";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { logger } from "@/lib/logging/logger";
import { wrapError, getErrorMessage } from "@/lib/logging/errors";
import prisma from "@/lib/prisma";
import { MongoDBBackupScopeSchema } from "@/lib/core/mongodb-backup-scope";

const log = logger.child({ route: "storage/restore" });

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
    const ctx = await getAuthContext(await headers());

    if (!ctx) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const params = await props.params;

    try {
        checkPermissionWithContext(ctx, PERMISSIONS.STORAGE.RESTORE);

        const body = await req.json();
        const { file, scope, backupScope, targetSourceId, targetDatabaseName, databaseMapping, directoryMapping, excludePatterns, privilegedAuth, profileIdOverride } = body;

        if (!file || typeof file !== 'string' || file.includes('..') || file.startsWith('/')) {
            return NextResponse.json({ error: "Invalid file path" }, { status: 400 });
        }

        const parsedBackupScope = backupScope === undefined
            ? undefined
            : MongoDBBackupScopeSchema.safeParse(backupScope);
        if (parsedBackupScope && !parsedBackupScope.success) {
            return NextResponse.json({ error: "Invalid MongoDB backup scope" }, { status: 400 });
        }

        const user = await prisma.user.findUnique({ where: { id: ctx.userId }, select: { name: true } });

        const result = await restoreService.restore({
            storageConfigId: params.id,
            file,
            backupScope: parsedBackupScope?.data,
            // Anything unrecognised restores everything, same as omitting it.
            scope: scope === 'databases' || scope === 'files' ? scope : undefined,
            targetSourceId: targetSourceId || undefined,
            targetDatabaseName,
            databaseMapping,
            directoryMapping: Array.isArray(directoryMapping) ? directoryMapping : undefined,
            // Patterns whose matching files are skipped; anything not a string list is ignored.
            excludePatterns: Array.isArray(excludePatterns)
                ? excludePatterns.filter((p: unknown): p is string => typeof p === 'string')
                : undefined,
            privilegedAuth,
            // The run happens in the background, so a key it cannot resolve has nobody to
            // ask. Whatever the user answered on the restore page is carried into it.
            ...(typeof profileIdOverride === "string" && profileIdOverride
                ? { keyOverride: { profileId: profileIdOverride } }
                : {}),
            triggerInfo: { type: "Manual", label: user?.name ?? "Unknown" },
        });

        // result contains { success: true, executionId: string, message: "Restore started" }
        return NextResponse.json(result, { status: 202 });

    } catch (error: unknown) {
        log.error("Restore error", { storageId: params.id }, wrapError(error));
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}
