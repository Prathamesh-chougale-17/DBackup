/**
 * Identifier handling, shared with the MSSQL adapter.
 *
 * Azure SQL Database is the same engine as far as identifiers are concerned:
 * `sysname` is still nvarchar(128), bracket quoting still escapes `]` as `]]`,
 * and a delimited identifier still accepts hyphens, dots and spaces. Copying the
 * rules would mean two places to get them wrong, so they are shared on purpose.
 *
 * Re-exported through this file rather than imported directly at each call site,
 * so the deliberate coupling to the MSSQL adapter is stated once and stays
 * visible if either engine ever diverges.
 */
export {
    assertValidDatabaseName,
    validateDatabaseName,
    escapeTSqlString,
} from "../mssql/identifiers";
