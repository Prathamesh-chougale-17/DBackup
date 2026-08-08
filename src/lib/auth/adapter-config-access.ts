import { hasPermissionWithContext, type AuthContext } from "@/lib/auth/access-control";
import { getManagePermissionForAdapter } from "@/lib/auth/adapter-permissions";

/**
 * Whether this caller may edit saved configs of this adapter.
 *
 * Used by the form-driven endpoints (connection test, database listing) to
 * decide whether they may fill a submitted config back up with the secrets the
 * saved one holds. Everyone else is answered on exactly what they submitted, so
 * a stored secret can never be aimed at a host of the caller's choosing.
 */
export function canEditStoredConfig(ctx: AuthContext, adapterId: string): boolean {
    const permission = getManagePermissionForAdapter(adapterId);
    return permission !== null && hasPermissionWithContext(ctx, permission);
}
