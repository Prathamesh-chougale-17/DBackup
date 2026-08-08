/**
 * Which adapters may be offered for which role.
 *
 * Checked against the real `ADAPTER_DEFINITIONS` on purpose. The existing role-validation
 * test mocks the definitions to exercise the message text, which means it cannot notice a
 * source-only adapter still being offered as a destination - and that is exactly the bug
 * this guards.
 */

import { describe, it, expect } from "vitest";
import { ADAPTER_DEFINITIONS } from "@/lib/adapters/definitions";
import { STORAGE_ROLES, canOfferCounterpart, counterpartStorageRole, supportsStorageRole } from "@/lib/core/storage-roles";

const storageAdapters = ADAPTER_DEFINITIONS.filter((d) => d.type === "storage");
const offeredFor = (role: typeof STORAGE_ROLES[keyof typeof STORAGE_ROLES]) =>
    storageAdapters.filter((d) => supportsStorageRole(d.supportedRoles, role)).map((d) => d.id);

describe("supportsStorageRole", () => {
    it("treats an adapter that declares nothing as usable for both roles", () => {
        // Which is every storage adapter but one, so this is also the guard against the
        // filter quietly hiding something it should not.
        expect(supportsStorageRole(undefined, STORAGE_ROLES.SOURCE)).toBe(true);
        expect(supportsStorageRole(undefined, STORAGE_ROLES.DESTINATION)).toBe(true);
    });

    it("keeps Docker volumes out of the destination list", () => {
        // A container runtime is somewhere to read data out of, never somewhere to put
        // archives. Offering it would only let someone build a job failing on first upload.
        expect(offeredFor(STORAGE_ROLES.DESTINATION)).not.toContain("docker-volume");
        expect(offeredFor(STORAGE_ROLES.SOURCE)).toContain("docker-volume");
    });

    it("leaves every other storage adapter in both lists", () => {
        const others = storageAdapters.filter((d) => d.id !== "docker-volume").map((d) => d.id);

        expect(offeredFor(STORAGE_ROLES.DESTINATION).sort()).toEqual([...others].sort());
        expect(offeredFor(STORAGE_ROLES.SOURCE).sort()).toEqual([...others, "docker-volume"].sort());
    });

    it("offers no counterpart for a Docker volume, in either direction", () => {
        // The "create as the opposite role" action in the connections table. Docker volumes
        // are always a source, so the counterpart would be a destination the API refuses -
        // the button would only ever produce a rejected save.
        const docker = storageAdapters.find((d) => d.id === "docker-volume")!;

        expect(canOfferCounterpart(docker.supportedRoles, STORAGE_ROLES.SOURCE)).toBe(false);
        // And the reverse, in case a stored row ever carries the wrong role.
        expect(canOfferCounterpart(docker.supportedRoles, STORAGE_ROLES.DESTINATION)).toBe(true);
        expect(counterpartStorageRole(STORAGE_ROLES.SOURCE)).toBe(STORAGE_ROLES.DESTINATION);
    });

    it("still offers the counterpart for every other storage adapter", () => {
        // The action exists because the same NAS is often wanted as both, so it must not
        // disappear from the adapters that can do both.
        for (const adapter of storageAdapters.filter((d) => d.id !== "docker-volume")) {
            expect(canOfferCounterpart(adapter.supportedRoles, STORAGE_ROLES.SOURCE)).toBe(true);
            expect(canOfferCounterpart(adapter.supportedRoles, STORAGE_ROLES.DESTINATION)).toBe(true);
        }
    });

    it("offers something for both roles at all", () => {
        // Guards against a filter mistake that empties a picker outright, which would look
        // like "no adapters installed" rather than like a bug.
        expect(offeredFor(STORAGE_ROLES.DESTINATION).length).toBeGreaterThan(5);
        expect(offeredFor(STORAGE_ROLES.SOURCE).length).toBeGreaterThan(5);
    });
});
