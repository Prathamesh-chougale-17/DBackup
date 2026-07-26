"use server"

import prisma from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { checkPermission, getCurrentUserWithGroup } from "@/lib/auth/access-control";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { auditService } from "@/services/audit-service";
import { AUDIT_ACTIONS, AUDIT_RESOURCES } from "@/lib/core/audit-types";
import { logger } from "@/lib/logging/logger";
import { wrapError } from "@/lib/logging/errors";
import { runBulk } from "@/lib/core/bulk";
import { BulkIdsSchema } from "@/lib/core/bulk-schema";

const log = logger.child({ action: "group" });

const groupSchema = z.object({
    name: z.string().min(1, "Name is required"),
    permissions: z.array(z.string()),
});

export type GroupFormValues = z.infer<typeof groupSchema>;

export async function getGroups() {
    await checkPermission(PERMISSIONS.GROUPS.READ);

    const groups = await prisma.group.findMany({
        orderBy: {
            createdAt: 'desc'
        },
        include: {
            _count: {
                select: { users: true }
            }
        }
    });

    // Parse permissions JSON
    return groups.map(group => ({
        ...group,
        permissions: JSON.parse(group.permissions) as string[]
    }));
}

export async function createGroup(data: GroupFormValues) {
    await checkPermission(PERMISSIONS.GROUPS.WRITE);
    const currentUser = await getCurrentUserWithGroup();

    try {
        const validated = groupSchema.parse(data);

        // Check name uniqueness
        const existingByName = await prisma.group.findUnique({ where: { name: validated.name } });
        if (existingByName) {
            return { success: false, error: `A group with the name "${validated.name}" already exists.` };
        }

        const newGroup = await prisma.group.create({
            data: {
                name: validated.name,
                permissions: JSON.stringify(validated.permissions),
            }
        });

        revalidatePath("/dashboard/users");

        if (currentUser) {
            await auditService.log(
                currentUser.id,
                AUDIT_ACTIONS.CREATE,
                AUDIT_RESOURCES.GROUP,
                validated,
                newGroup.id
            );
        }

        return { success: true };
    } catch (error: unknown) {
        log.error("Failed to create group", {}, wrapError(error));
        return { success: false, error: "Failed to create group" };
    }
}

export async function updateGroup(id: string, data: GroupFormValues) {
    await checkPermission(PERMISSIONS.GROUPS.WRITE);
    const currentUser = await getCurrentUserWithGroup();

    try {
        const validated = groupSchema.parse(data);

        // Check if group is SuperAdmin
        const existingGroup = await prisma.group.findUnique({
            where: { id }
        });

        if (existingGroup?.name === "SuperAdmin") {
             return { success: false, error: "The SuperAdmin group cannot be edited manually." };
        }

        // Check name uniqueness (excluding current group)
        const existingByName = await prisma.group.findUnique({ where: { name: validated.name } });
        if (existingByName && existingByName.id !== id) {
            return { success: false, error: `A group with the name "${validated.name}" already exists.` };
        }

        await prisma.group.update({
            where: { id },
            data: {
                name: validated.name,
                permissions: JSON.stringify(validated.permissions),
            }
        });

        revalidatePath("/dashboard/users");

        if (currentUser) {
            await auditService.log(
                currentUser.id,
                AUDIT_ACTIONS.UPDATE,
                AUDIT_RESOURCES.GROUP,
                validated,
                id
            );
        }

        return { success: true };
    } catch (error: unknown) {
        log.error("Failed to update group", { groupId: id }, wrapError(error));
        return { success: false, error: "Failed to update group" };
    }
}

export async function deleteGroup(id: string) {
    await checkPermission(PERMISSIONS.GROUPS.WRITE);
    const currentUser = await getCurrentUserWithGroup();

    try {
        const group = await prisma.group.findUnique({
            where: { id }
        });

        if (group?.name === "SuperAdmin") {
            return { success: false, error: "The SuperAdmin group cannot be deleted." };
        }

        await prisma.group.delete({
            where: { id }
        });

        revalidatePath("/dashboard/users");

        if (currentUser) {
            await auditService.log(
                currentUser.id,
                AUDIT_ACTIONS.DELETE,
                AUDIT_RESOURCES.GROUP,
                { name: group?.name },
                id
            );
        }

        return { success: true };
    } catch (error: unknown) {
        log.error("Failed to delete group", { groupId: id }, wrapError(error));
        return { success: false, error: "Failed to delete group. Ensure no users are assigned to it." };
    }
}

/**
 * Deletes several groups.
 *
 * SuperAdmin is refused here as well as in the UI, since hiding a checkbox is not a
 * guarantee. A group with users still in it surfaces as a per-group failure.
 */
export async function bulkDeleteGroups(ids: string[]) {
    await checkPermission(PERMISSIONS.GROUPS.WRITE);
    const currentUser = await getCurrentUserWithGroup();

    const parsed = BulkIdsSchema.safeParse(ids);
    if (!parsed.success) {
        return { success: false as const, error: "Invalid request" };
    }

    try {
        const groups = await prisma.group.findMany({
            where: { id: { in: parsed.data } },
            select: { id: true, name: true },
        });
        const names = new Map(groups.map((group) => [group.id, group.name]));

        const result = await runBulk(
            parsed.data,
            async (id) => {
                if (names.get(id) === "SuperAdmin") {
                    throw new Error("The SuperAdmin group cannot be deleted.");
                }
                await prisma.group.delete({ where: { id } });
            },
            (id) => names.get(id)
        );

        revalidatePath("/dashboard/users");

        if (currentUser) {
            await auditService.log(
                currentUser.id,
                AUDIT_ACTIONS.DELETE,
                AUDIT_RESOURCES.GROUP,
                { bulk: true, requested: parsed.data.length, succeeded: result.succeeded.length, failed: result.failed.length }
            );
        }

        return { success: true as const, data: result };
    } catch (error: unknown) {
        log.error("Failed to bulk delete groups", {}, wrapError(error));
        return { success: false as const, error: "Failed to delete groups" };
    }
}
