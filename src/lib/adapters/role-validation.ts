import { ADAPTER_DEFINITIONS } from "@/lib/adapters/definitions";
import { ValidationError } from "@/lib/logging/errors";
import { storageRoleLabel, supportsStorageRole, type StorageRole } from "@/lib/core/storage-roles";

/**
 * Refuses a role the adapter cannot serve.
 *
 * For most storage the role is genuinely the user's choice - a folder on an SFTP server is
 * as good a backup destination as it is a directory source. Some adapters only work one way
 * round: a container runtime is somewhere to read data out of, never somewhere to put
 * archives, and accepting it as a destination would only let someone build a job that fails
 * on its first upload.
 *
 * Enforced here rather than only in the form, for the same reason the snapshot check is:
 * the form is a convenience, the API is the boundary, and a direct call would otherwise
 * create a config that cannot work. All three write paths consult it - create, update, and
 * clone, the last of which exists specifically to produce a config with the opposite role.
 *
 * Reads the definition rather than the runtime adapter, because that is where a capability
 * the form also needs is declared. An unknown adapter id is left alone: it fails its own
 * validation further along, and inventing a second error for it here would only bury that.
 */
export function validateStorageRole(adapterId: string, storageRole: StorageRole): void {
    const definition = ADAPTER_DEFINITIONS.find((d) => d.id === adapterId);
    const allowed = definition?.supportedRoles;
    // The same predicate the picker uses, so a config the UI would never offer is also one
    // the boundary refuses - and neither can drift from the other.
    if (!definition || !allowed || supportsStorageRole(allowed, storageRole)) return;

    throw new ValidationError(
        `'${definition.name}' cannot be used as a ${storageRoleLabel(storageRole)}. `
        + `It supports: ${allowed.map(storageRoleLabel).join(", ")}.`
    );
}
