import prisma from "@/lib/prisma";
import { AUDIT_ACTIONS } from "@/lib/core/audit-types";
import { runBulk, type BulkResult } from "@/lib/core/bulk";

export const userService = {
  /**
   * Get all users with their associated group and last login time.
   * ordered by creation date desc
   */
  async getUsers() {
    const users = await prisma.user.findMany({
      orderBy: {
        createdAt: "desc",
      },
      include: {
        group: true,
        auditLogs: {
          where: { action: AUDIT_ACTIONS.LOGIN },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { createdAt: true }
        }
      },
    });

    return users.map(user => {
      const { auditLogs, ...rest } = user;
      return {
        ...rest,
        lastLogin: auditLogs[0]?.createdAt || null
      };
    });
  },

  /**
   * Update a user's group.
   * Prevents removing the last SuperAdmin.
   */
  async updateUserGroup(userId: string, groupId: string | null) {
    const targetGroupId = groupId === "none" ? null : groupId;

    // Security check: Prevent removing the last SuperAdmin
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { group: true },
    });

    if (!user) {
      throw new Error("User not found");
    }

    if (user.group?.name === "SuperAdmin" && targetGroupId !== user.groupId) {
      const superAdminCount = await prisma.user.count({
        where: {
          group: {
            name: "SuperAdmin",
          },
        },
      });

      if (superAdminCount <= 1) {
        throw new Error("Cannot remove the last user from the SuperAdmin group.");
      }
    }

    return await prisma.user.update({
      where: {
        id: userId,
      },
      data: {
        groupId: targetGroupId,
      },
    });
  },

  /**
   * Reset a user's two-factor authentication.
   */
  async resetTwoFactor(userId: string) {
    return await prisma.$transaction([
      prisma.user.update({
        where: { id: userId },
        data: {
          twoFactorEnabled: false,
          passkeyTwoFactor: false,
        },
      }),
      // Use deleteMany in case no record exists - safer than delete
      prisma.twoFactor.deleteMany({
        where: { userId },
      }),
    ]);
  },

  /**
   * Delete a user.
   * Prevents deleting the last SuperAdmin or the last user.
   */
  async deleteUser(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { group: true },
    });

    if (!user) {
      throw new Error("User not found");
    }

    // Check if user is the last SuperAdmin
    if (user.group?.name === "SuperAdmin") {
      const superAdminCount = await prisma.user.count({
        where: {
          group: {
            name: "SuperAdmin",
          },
        },
      });
      if (superAdminCount <= 1) {
        throw new Error("Cannot delete the last SuperAdmin user.");
      }
    }

    // Check if user is the last one
    const userCount = await prisma.user.count();
    if (userCount <= 1) {
      throw new Error("Cannot delete the last user.");
    }

    return await prisma.user.delete({
      where: {
        id: userId,
      },
    });
  },

  /**
   * Deletes several users, reporting per-user outcomes.
   *
   * Every user goes through `deleteUser`, so the last-SuperAdmin and last-user guards are
   * re-evaluated after each deletion rather than against the state the batch started in.
   * That is what keeps "delete everyone" from emptying the instance: the guard trips on
   * whoever is left, not on who was there when the request arrived.
   */
  async deleteUsers(userIds: string[]): Promise<BulkResult> {
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true, email: true },
    });
    const names = new Map(users.map((user) => [user.id, user.name || user.email]));

    return runBulk(userIds, (id) => this.deleteUser(id).then(() => undefined), (id) => names.get(id));
  },

  /**
   * Toggle passkey two-factor authentication for a user.
   */
  async togglePasskeyTwoFactor(userId: string, enabled: boolean) {
    return await prisma.user.update({
      where: {
        id: userId,
      },
      data: {
        passkeyTwoFactor: enabled,
        twoFactorEnabled: enabled, // Force enable native 2FA flag to trigger 2FA flow
      },
    });
  },

  /**
   * Update user profile details.
   */
  async updateUser(
    userId: string,
    data: {
      name?: string;
      email?: string;
      timezone?: string;
      dateFormat?: string;
      timeFormat?: string;
    }
  ) {
    return await prisma.user.update({
      where: {
        id: userId,
      },
      data: {
        name: data.name,
        email: data.email,
        timezone: data.timezone,
        dateFormat: data.dateFormat,
        timeFormat: data.timeFormat,
      },
    });
  },
};
