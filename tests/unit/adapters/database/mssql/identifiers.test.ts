import { describe, it, expect } from "vitest";
import {
    assertValidDatabaseName,
    escapeTSqlString,
    toPhysicalFileName,
    validateDatabaseName,
} from "@/lib/adapters/database/mssql/identifiers";

// ---------------------------------------------------------------------------
// assertValidDatabaseName
// ---------------------------------------------------------------------------

describe("assertValidDatabaseName", () => {
    // Regression for #133: these were rejected by an allowlist that only
    // permitted letters, digits and underscore, which blocked restores onto
    // perfectly valid databases such as nax-init.
    it.each([
        "nax-init",
        "test-test",
        "with.dot",
        "with space",
        "üml-äut",
        "db;DROP TABLE",
        "a".repeat(128),
    ])("accepts %j, which SQL Server accepts as a delimited identifier", (name) => {
        expect(() => assertValidDatabaseName(name)).not.toThrow();
    });

    it("rejects an empty name", () => {
        expect(() => assertValidDatabaseName("")).toThrow("Invalid database name");
    });

    it("rejects a name longer than 128 characters", () => {
        expect(() => assertValidDatabaseName("a".repeat(129))).toThrow("Invalid database name");
    });

    it("rejects control characters", () => {
        expect(() => assertValidDatabaseName("db\u0000name")).toThrow("control characters");
        expect(() => assertValidDatabaseName("db\nname")).toThrow("control characters");
        expect(() => assertValidDatabaseName("db\u007Fname")).toThrow("control characters");
    });
});

// ---------------------------------------------------------------------------
// validateDatabaseName
// ---------------------------------------------------------------------------

describe("validateDatabaseName", () => {
    it("returns hyphenated names unchanged", () => {
        expect(validateDatabaseName("nax-init")).toBe("nax-init");
    });

    it("doubles closing brackets so the name cannot escape [quoting]", () => {
        expect(validateDatabaseName("My]DB")).toBe("My]]DB");
    });

    it("propagates validation failures", () => {
        expect(() => validateDatabaseName("")).toThrow("Invalid database name");
    });
});

// ---------------------------------------------------------------------------
// escapeTSqlString
// ---------------------------------------------------------------------------

describe("escapeTSqlString", () => {
    it("doubles single quotes", () => {
        expect(escapeTSqlString("O'Brien")).toBe("O''Brien");
    });

    it("leaves a plain string untouched", () => {
        expect(escapeTSqlString("/backup/db.bak")).toBe("/backup/db.bak");
    });
});

// ---------------------------------------------------------------------------
// toPhysicalFileName
// ---------------------------------------------------------------------------

describe("toPhysicalFileName", () => {
    it("keeps hyphens, dots and spaces, which are legal in a filename", () => {
        expect(toPhysicalFileName("nax-init")).toBe("nax-init");
        expect(toPhysicalFileName("with.dot")).toBe("with.dot");
        expect(toPhysicalFileName("with space")).toBe("with space");
    });

    it("replaces path separators so relocated files stay in the data directory", () => {
        expect(toPhysicalFileName("with/slash")).toBe("with_slash");
        expect(toPhysicalFileName("with\\backslash")).toBe("with_backslash");
        expect(toPhysicalFileName("../../etc/passwd")).toBe(".._.._etc_passwd");
    });
});
