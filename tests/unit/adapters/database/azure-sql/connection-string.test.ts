import { describe, it, expect } from "vitest";
import {
    buildConnectionString,
    describeConnection,
} from "@/lib/adapters/database/azure-sql/exporter/connection-string";

const base = {
    host: "myserver.database.windows.net",
    port: 1433,
    user: "backupadmin",
    password: "s3cret",
    database: "",
    requestTimeout: 300000,
};

describe("Azure SQL connection string", () => {
    it("targets the requested database on the configured server", () => {
        const cs = buildConnectionString(base as never, "shop");

        expect(cs).toContain('Server="tcp:myserver.database.windows.net,1433"');
        expect(cs).toContain('Initial Catalog="shop"');
        expect(cs).toContain('User ID="backupadmin"');
    });

    it("never relaxes transport security", () => {
        // Both pinned rather than configurable. Azure presents a real certificate
        // on every connection, so trusting an unverified one is always either a
        // mistake or an interception.
        const cs = buildConnectionString(base as never, "shop");

        expect(cs).toContain('Encrypt="True"');
        expect(cs).toContain('TrustServerCertificate="False"');
    });

    it("survives a password containing a semicolon", () => {
        // The failure this prevents is silent: an unquoted `;` ends the pair, and
        // the driver then reports a missing or malformed keyword rather than a bad
        // password, sending people to look at the wrong thing.
        const cs = buildConnectionString({ ...base, password: "pa;ss" } as never, "shop");

        expect(cs).toContain('Password="pa;ss"');
    });

    it("survives a password containing a double quote", () => {
        const cs = buildConnectionString({ ...base, password: 'pa"ss' } as never, "shop");

        // Doubled, which is how ADO.NET escapes the delimiter it is using.
        expect(cs).toContain('Password="pa""ss"');
    });

    it("survives a database name containing an equals sign", () => {
        const cs = buildConnectionString(base as never, "a=b");

        expect(cs).toContain('Initial Catalog="a=b"');
    });

    it("preserves leading and trailing spaces in a password", () => {
        // Unquoted, ADO.NET strips them, and the login then fails for a password
        // the user can see is correct.
        const cs = buildConnectionString({ ...base, password: "  pw  " } as never, "shop");

        expect(cs).toContain('Password="  pw  "');
    });

    it("falls back to port 1433 when none is configured", () => {
        const cs = buildConnectionString({ ...base, port: undefined } as never, "shop");

        expect(cs).toContain('Server="tcp:myserver.database.windows.net,1433"');
    });

    it("describes a connection without leaking the password", () => {
        const description = describeConnection(base as never, "shop");

        expect(description).toBe("myserver.database.windows.net:1433/shop as backupadmin");
        expect(description).not.toContain("s3cret");
    });
});
