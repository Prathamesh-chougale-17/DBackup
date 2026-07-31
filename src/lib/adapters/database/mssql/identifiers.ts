/**
 * Helpers for handling MSSQL identifiers and T-SQL literals.
 *
 * SQL Server database names are `sysname` (nvarchar(128)). Written as delimited
 * identifiers they may contain hyphens, dots, spaces and non-ASCII characters -
 * `[nax-init]` is just as valid as `[naxinit]`. Injection safety therefore comes
 * from bracket quoting and parameterized queries, not from an allowlist of
 * characters, and the validation below stays as permissive as the server itself.
 */

/** sysname is nvarchar(128), so an identifier never exceeds 128 characters. */
const MAX_IDENTIFIER_LENGTH = 128;

/**
 * Control characters cannot appear in an identifier and would corrupt a query.
 */
function hasControlCharacter(value: string): boolean {
    for (const char of value) {
        const code = char.codePointAt(0) ?? 0;
        if (code < 0x20 || code === 0x7f) {
            return true;
        }
    }
    return false;
}

/**
 * Escapes a string for safe inclusion in a T-SQL N'...' literal.
 * Replaces single quotes with doubled single quotes (SQL standard escaping).
 */
export function escapeTSqlString(value: string): string {
    return value.replace(/'/g, "''");
}

/**
 * Throws when a name cannot be a SQL Server database name.
 * Everything the server accepts as a delimited identifier passes.
 */
export function assertValidDatabaseName(name: string): void {
    if (!name || name.length > MAX_IDENTIFIER_LENGTH) {
        throw new Error(`Invalid database name: name must be 1-${MAX_IDENTIFIER_LENGTH} characters`);
    }
    if (hasControlCharacter(name)) {
        throw new Error(`Invalid database name: name must not contain control characters`);
    }
}

/**
 * Validates a database name and returns it escaped for use inside [brackets].
 * Only the closing bracket needs escaping, as ]].
 */
export function validateDatabaseName(name: string): string {
    assertValidDatabaseName(name);
    return name.replace(/\]/g, "]]");
}

/**
 * Turns a database name into a single safe path component for .mdf/.ldf files.
 *
 * SQL Server does the same when it derives physical file names itself: path
 * separators become underscores, so a database named `a/b` gets `a_b.mdf`. Doing
 * it here keeps relocated files inside the target data directory.
 */
export function toPhysicalFileName(name: string): string {
    return name.replace(/[\\/]/g, "_");
}
