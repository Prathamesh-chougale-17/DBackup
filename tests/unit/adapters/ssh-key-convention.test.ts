/**
 * Which names an SSH credential profile writes into a config.
 *
 * Two conventions exist and both are legitimate, so the danger is not picking the wrong one
 * in the abstract - it is the overlay writing one set of names while the transport reads the
 * other. That produces a config which looks complete, saves without complaint, and fails at
 * connect time with an error pointing at the user's settings.
 *
 * The invariant below is checked against the real adapter definitions rather than fixtures,
 * so a future adapter cannot introduce the mismatch without this failing.
 */

import { describe, it, expect } from "vitest";
import { ADAPTER_DEFINITIONS } from "@/lib/adapters/definitions";
import {
    PREFIXED_SSH_KEYS,
    UNPREFIXED_SSH_KEYS,
    sshManagedKeys,
    usesPrefixedSshKeys,
} from "@/lib/adapters/ssh-key-convention";

const sshAdapters = ADAPTER_DEFINITIONS.filter((d) => d.credentials?.ssh === "SSH_KEY");

describe("ssh key convention", () => {
    it("covers at least the adapters this was written for", () => {
        // Guards against the filter silently matching nothing, which would make every
        // assertion below vacuously true.
        expect(sshAdapters.map((d) => d.id)).toEqual(expect.arrayContaining(["mysql", "sqlite", "docker-volume"]));
    });

    it.each(sshAdapters.map((d) => [d.id, d] as const))(
        "%s declares every key its credential profile would write",
        (_id, definition) => {
            // The invariant that matters: what the overlay writes has to exist in the schema
            // it writes into. Anything else is a value nothing will ever read.
            const shape = (definition.configSchema as unknown as { shape: Record<string, unknown> }).shape;
            for (const key of sshManagedKeys(definition.configSchema as never)) {
                expect(Object.keys(shape)).toContain(key);
            }
        }
    );

    it("puts an adapter that spreads sshFields on the prefixed convention", () => {
        // Including the two with no primary credential slot at all, which is the case the
        // old primary-slot heuristic got wrong.
        for (const id of ["mysql", "mssql", "docker-volume"]) {
            const definition = ADAPTER_DEFINITIONS.find((d) => d.id === id)!;
            expect(usesPrefixedSshKeys(definition.configSchema as never)).toBe(true);
            expect(sshManagedKeys(definition.configSchema as never)).toBe(PREFIXED_SSH_KEYS);
        }
    });

    it("leaves SQLite on the unprefixed convention", () => {
        // It has no database login, so its schema reuses the plain names - and changing that
        // would silently break every existing SQLite-over-SSH config.
        const sqlite = ADAPTER_DEFINITIONS.find((d) => d.id === "sqlite")!;

        expect(usesPrefixedSshKeys(sqlite.configSchema as never)).toBe(false);
        expect(sshManagedKeys(sqlite.configSchema as never)).toBe(UNPREFIXED_SSH_KEYS);
    });

    it("treats a missing schema as the unprefixed default rather than throwing", () => {
        expect(usesPrefixedSshKeys(undefined)).toBe(false);
        expect(sshManagedKeys(undefined)).toBe(UNPREFIXED_SSH_KEYS);
    });
});
