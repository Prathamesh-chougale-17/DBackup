import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { headers } from "next/headers";
import { getAuthContext, checkPermissionWithContext } from "@/lib/auth/access-control";
import { PERMISSIONS } from "@/lib/auth/permissions";

export async function GET(_req: NextRequest) {
    const ctx = await getAuthContext(await headers());
    if (!ctx) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        checkPermissionWithContext(ctx, PERMISSIONS.HISTORY.READ);

        const [executions, tzSetting] = await Promise.all([
            prisma.execution.findMany({
                // Explicit, and deliberately without `logs`. That column holds the entire log
                // of a run as JSON, and this endpoint is polled every two seconds while a job
                // is running - returning a hundred of them made each poll take long enough
                // that the client dropped the next tick, so the live view updated slower the
                // more history an instance had. The open dialog fetches the one log it needs
                // from /api/executions/[id].
                select: {
                    id: true,
                    jobId: true,
                    type: true,
                    status: true,
                    startedAt: true,
                    endedAt: true,
                    path: true,
                    metadata: true,
                    triggerType: true,
                    triggerLabel: true,
                    job: { select: { name: true } },
                },
                orderBy: { startedAt: 'desc' },
                take: 100
            }),
            prisma.systemSetting.findUnique({ where: { key: "system.timezone" } })
        ]);

        const systemTimezone = tzSetting?.value || "UTC";

        return NextResponse.json({
            executions,
            systemTimezone
        });
    } catch (_error) {
        return NextResponse.json({ error: "Failed to fetch history" }, { status: 500 });
    }
}
