import { MySQLBaseDialect } from "./mysql-base";
import { MySQL80Dialect } from "./mysql-8";
import { MySQL57Dialect } from "./mysql-5-7";
import { MariaDBDialect } from "./mariadb";

export function getDialect(adapterId: string, version?: string): MySQLBaseDialect {
    // 1. Explicit MariaDB Adapter Check
    if (adapterId === 'mariadb') {
        return new MariaDBDialect(); // Could be extended for MariaDB 10 vs 11
    }

    // 2. MySQL Version Check
    if (version) {
        const lowerV = version.toLowerCase();

        // Check for MariaDB even if adapterId is 'mysql' (e.g. user selected wrong type)
        if (lowerV.includes('mariadb')) {
            return new MariaDBDialect();
        }

        // MySQL 5.7
        if (lowerV.includes('5.7.')) {
            return new MySQL57Dialect();
        }

        // MySQL 8+
        // Fallthrough to default
    }

    // Default for 'mysql' adapter is MySQL 8
    // Default fallback is Base/8
    return new MySQL80Dialect();
}
