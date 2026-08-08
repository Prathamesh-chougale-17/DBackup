/**
 * Seeding a form with an adapter schema's declared defaults.
 *
 * This had been doing nothing at all since the upgrade to Zod 4 - it looked for a Zod 3
 * property name that no longer exists, so no adapter form has been prefilled since. The
 * failure was silent because a missing default looks exactly like a field the user has not
 * filled in yet, and every one of them has a placeholder showing the same value.
 */

import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { seedSchemaDefaults } from "@/components/adapter/schema-defaults";
import { ADAPTER_DEFINITIONS } from "@/lib/adapters/definitions";

function fakeForm(existing: Record<string, unknown> = {}) {
    const set = vi.fn();
    return {
        set,
        form: {
            getValues: (name: string) => existing[name.replace(/^config\./, "")],
            setValue: set,
        } as never,
    };
}

describe("seedSchemaDefaults", () => {
    it("seeds a plain default", () => {
        const { form, set } = fakeForm();

        seedSchemaDefaults(z.object({ port: z.coerce.number().default(22) }), form);

        expect(set).toHaveBeenCalledWith("config.port", 22);
    });

    it("finds a default wrapped in optional", () => {
        // `sshPort: z.coerce.number().default(22).optional()` is the shape half the SSH
        // fields use, so a walker that only checks the outermost node finds nothing.
        const { form, set } = fakeForm();

        seedSchemaDefaults(z.object({ sshPort: z.coerce.number().default(22).optional() }), form);

        expect(set).toHaveBeenCalledWith("config.sshPort", 22);
    });

    it("seeds enums and booleans", () => {
        const { form, set } = fakeForm();

        seedSchemaDefaults(z.object({
            authType: z.enum(["password", "privateKey"]).default("password"),
            tls: z.boolean().default(false),
        }), form);

        expect(set).toHaveBeenCalledWith("config.authType", "password");
        expect(set).toHaveBeenCalledWith("config.tls", false);
    });

    it("never overwrites something already in the form", () => {
        const { form, set } = fakeForm({ port: 2222 });

        seedSchemaDefaults(z.object({ port: z.coerce.number().default(22) }), form);

        expect(set).not.toHaveBeenCalled();
    });

    it("leaves a field with no default alone", () => {
        const { form, set } = fakeForm();

        seedSchemaDefaults(z.object({ host: z.string() }), form);

        expect(set).not.toHaveBeenCalled();
    });

    it("does not seed the keys that choose the form's layout", () => {
        // Both forms deliberately show nothing until a mode is picked, because the two modes
        // ask for different things. Seeding one would answer a question nobody was asked and
        // drop the user straight into a form for the wrong mode.
        const { form, set } = fakeForm();

        seedSchemaDefaults(z.object({
            connectionMode: z.enum(["direct", "ssh"]).default("direct"),
            mode: z.enum(["local", "ssh"]).default("local"),
            port: z.coerce.number().default(22),
        }), form);

        expect(set).toHaveBeenCalledWith("config.port", 22);
        expect(set).not.toHaveBeenCalledWith("config.connectionMode", expect.anything());
        expect(set).not.toHaveBeenCalledWith("config.mode", expect.anything());
    });

    it("survives a schema that is not an object", () => {
        const { form, set } = fakeForm();

        expect(() => seedSchemaDefaults(undefined, form)).not.toThrow();
        expect(() => seedSchemaDefaults(z.string(), form)).not.toThrow();
        expect(set).not.toHaveBeenCalled();
    });

    it("actually seeds something for a real adapter", () => {
        // The regression guard. Against a fixture the old code would have failed too, but
        // this pins that it works on the schemas the app ships.
        const sftp = ADAPTER_DEFINITIONS.find((d) => d.id === "sftp")!;
        const { form, set } = fakeForm();

        seedSchemaDefaults(sftp.configSchema, form);

        expect(set).toHaveBeenCalledWith("config.port", 22);
        expect(set).toHaveBeenCalledWith("config.authType", "password");
    });

    it("leaves a Docker volume's own fields to their runtime defaults", () => {
        // They are preprocess pipes rather than plain defaults, so nothing is seeded and the
        // placeholder does the talking. Leaving them empty produces the same value anyway.
        const docker = ADAPTER_DEFINITIONS.find((d) => d.id === "docker-volume")!;
        const { form, set } = fakeForm();

        seedSchemaDefaults(docker.configSchema, form);

        expect(set).not.toHaveBeenCalledWith("config.connectionMode", expect.anything());
    });
});
