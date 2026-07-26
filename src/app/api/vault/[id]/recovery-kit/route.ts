import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { getAuthContext, checkPermissionWithContext } from "@/lib/auth/access-control";
import { PERMISSIONS } from "@/lib/auth/permissions";
import * as encryptionService from "@/services/backup/encryption-service";
import { buildRecoveryKit } from "@/services/backup/recovery-kit";
import { auditService } from "@/services/audit-service";
import { AUDIT_ACTIONS, AUDIT_RESOURCES } from "@/lib/core/audit-types";
import { logger } from "@/lib/logging/logger";
import { wrapError } from "@/lib/logging/errors";

const log = logger.child({ route: "vault/recovery-kit" });

export async function GET(
    request: NextRequest,
    props: { params: Promise<{ id: string }> }
) {
    const params = await props.params;
    const { id } = params;

    const headersList = await headers();
    const ctx = await getAuthContext(headersList);
    if (!ctx) {
        return new NextResponse("Unauthorized", { status: 401 });
    }

    // Security: Require VAULT.WRITE for master key export (sensitive operation)
    checkPermissionWithContext(ctx, PERMISSIONS.VAULT.WRITE);

    // Audit log: Track master key export
    await auditService.log(
        ctx.userId,
        AUDIT_ACTIONS.EXPORT,
        AUDIT_RESOURCES.VAULT,
        { action: 'recovery_kit_download', profileId: id },
        id
    );

    try {
        const profile = await encryptionService.getEncryptionProfile(id);
        if (!profile) {
            return new NextResponse("Profile not found", { status: 404 });
        }

        const zipBuffer = await buildRecoveryKit({
            profileName: profile.name,
            masterKeyHex: await encryptionService.getDecryptedMasterKey(id),
        });

        const sanitizedName = profile.name.replace(/[^a-z0-9]/gi, '_').toLowerCase();

        return new NextResponse(zipBuffer as unknown as BodyInit, {
            status: 200,
            headers: {
                "Content-Type": "application/zip",
                "Content-Disposition": `attachment; filename="recovery_kit_${sanitizedName}.zip"`
            }
        });

    } catch (error: unknown) {
        log.error("Recovery kit generation error", { profileId: id }, wrapError(error));
        return new NextResponse("Internal Server Error", { status: 500 });
    }
}
