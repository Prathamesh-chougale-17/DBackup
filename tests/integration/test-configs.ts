import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import path from 'path';

// Shared configuration for Integration Tests and Seeding
const TEST_HOST = process.env.TEST_DB_HOST || 'localhost';

// Check if a CLI tool is available on the system
function isCliAvailable(command: string): boolean {
    try {
        execSync(`which ${command}`, { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

// CLI tools required for each database type
const CLI_REQUIREMENTS: Record<string, string> = {
    mysql: 'mysqldump',
    mariadb: 'mysqldump',
    postgres: 'pg_dump',
    mongodb: 'mongodump',
    mssql: 'sqlcmd',
    redis: 'redis-cli',
    firebird: 'gbak',
};

// Check which CLI tools are missing
const missingCli = Object.entries(CLI_REQUIREMENTS)
    .filter(([, cli]) => !isCliAvailable(cli))
    .map(([type]) => type);

if (missingCli.length > 0) {
    console.log(`⚠️  Missing CLI tools for: ${missingCli.join(', ')} - these tests will be skipped`);
}

// Test database: testdb (use pnpm run test:stress:generate to populate with ~1.5GB of data)
export const testDatabases = [
    // --- MySQL ---
    {
        name: 'Test MySQL 5.7',
        config: { type: 'mysql', host: TEST_HOST, port: 33357, user: 'root', password: 'rootpassword', database: 'testdb' }
    },
    // { name: 'Test MySQL 8.0', config: { type: 'mysql', host: TEST_HOST, port: 33380, user: 'root', password: 'rootpassword', database: 'testdb' } }, // disabled to reduce RAM
    {
        name: 'Test MySQL 9.x',
        config: { type: 'mysql', host: TEST_HOST, port: 33390, user: 'root', password: 'rootpassword', database: 'testdb' }
    },
    // --- MariaDB ---
    {
        name: 'Test MariaDB 10',
        config: { type: 'mariadb', host: TEST_HOST, port: 33310, user: 'root', password: 'rootpassword', database: 'testdb' }
    },
    {
        name: 'Test MariaDB 11',
        config: { type: 'mariadb', host: TEST_HOST, port: 33311, user: 'root', password: 'rootpassword', database: 'testdb' }
    },
    // --- PostgreSQL ---
    {
        name: 'Test PostgreSQL 12',
        config: { type: 'postgres', host: TEST_HOST, port: 54412, user: 'testuser', password: 'testpassword', database: 'testdb' }
    },
    // { name: 'Test PostgreSQL 13', config: { type: 'postgres', host: TEST_HOST, port: 54413, user: 'testuser', password: 'testpassword', database: 'testdb' } }, // disabled to reduce RAM
    // { name: 'Test PostgreSQL 14', config: { type: 'postgres', host: TEST_HOST, port: 54414, user: 'testuser', password: 'testpassword', database: 'testdb' } }, // disabled to reduce RAM
    // { name: 'Test PostgreSQL 15', config: { type: 'postgres', host: TEST_HOST, port: 54415, user: 'testuser', password: 'testpassword', database: 'testdb' } }, // disabled to reduce RAM
    // { name: 'Test PostgreSQL 16', config: { type: 'postgres', host: TEST_HOST, port: 54416, user: 'testuser', password: 'testpassword', database: 'testdb' } }, // disabled to reduce RAM
    {
        name: 'Test PostgreSQL 17',
        config: { type: 'postgres', host: TEST_HOST, port: 54417, user: 'testuser', password: 'testpassword', database: 'testdb' }
    },
    // --- MongoDB ---
    {
        name: 'Test MongoDB 4.4',
        config: { type: 'mongodb', host: TEST_HOST, port: 27704, user: 'root', password: 'rootpassword', database: 'testdb' }
    },
    // { name: 'Test MongoDB 5.0', config: { type: 'mongodb', host: TEST_HOST, port: 27705, user: 'root', password: 'rootpassword', database: 'testdb' } }, // disabled to reduce RAM
    // { name: 'Test MongoDB 6.0', config: { type: 'mongodb', host: TEST_HOST, port: 27706, user: 'root', password: 'rootpassword', database: 'testdb' } }, // disabled to reduce RAM
    // { name: 'Test MongoDB 7.0', config: { type: 'mongodb', host: TEST_HOST, port: 27707, user: 'root', password: 'rootpassword', database: 'testdb' } }, // disabled to reduce RAM
    {
        name: 'Test MongoDB 8.0',
        config: { type: 'mongodb', host: TEST_HOST, port: 27708, user: 'root', password: 'rootpassword', database: 'testdb' }
    },
    // --- Microsoft SQL Server ---
    // MSSQL backups are created on the server filesystem via T-SQL BACKUP DATABASE.
    // We mount /tmp to /var/opt/mssql/backup so backups are directly accessible.
    {
        name: 'Test MSSQL 2019',
        config: {
            type: 'mssql',
            host: TEST_HOST,
            port: 14339,
            user: 'sa',
            password: 'YourStrong!Passw0rd',
            database: 'testdb',
            encrypt: true,
            trustServerCertificate: true,
            backupPath: '/var/opt/mssql/backup',
            localBackupPath: '/tmp'
        }
    },
    {
        name: 'Test MSSQL 2022',
        config: {
            type: 'mssql',
            host: TEST_HOST,
            port: 14342,
            user: 'sa',
            password: 'YourStrong!Passw0rd',
            database: 'testdb',
            encrypt: true,
            trustServerCertificate: true,
            backupPath: '/var/opt/mssql/backup',
            localBackupPath: '/tmp'
        }
    },
    // Test Azure SQL Edge - disabled to reduce RAM usage (also has ARM64 limitations)
    // {
    //     name: 'Test Azure SQL Edge',
    //     config: {
    //         type: 'mssql',
    //         host: TEST_HOST,
    //         port: 14350,
    //         user: 'sa',
    //         password: 'YourStrong!Passw0rd',
    //         database: 'testdb',
    //         encrypt: true,
    //         trustServerCertificate: true,
    //         backupPath: '/var/opt/mssql/backup',
    //         localBackupPath: '/tmp'
    //     }
    // },
    // --- Redis ---
    {
        name: 'Test Redis 6',
        config: {
            type: 'redis',
            host: TEST_HOST,
            port: 63796,
            password: 'testpassword',
            database: 0
        }
    },
    // { name: 'Test Redis 7', config: { type: 'redis', host: TEST_HOST, port: 63797, password: 'testpassword', database: 0 } }, // disabled to reduce RAM
    {
        name: 'Test Redis 8',
        config: {
            type: 'redis',
            host: TEST_HOST,
            port: 63798,
            password: 'testpassword',
            database: 0
        }
    },
    // --- Valkey ---
    {
        name: 'Test Valkey 8',
        config: {
            type: 'valkey',
            host: TEST_HOST,
            port: 63780,
            password: 'testpassword',
            database: 0
        }
    },
    // --- Firebird ---
    // Note config shape differs from other adapters: `databases` is the admin-defined
    // alias registry ({name, path}), `database` is the job-selected alias name(s).
    {
        name: 'Test Firebird 3.0',
        config: {
            type: 'firebird',
            host: TEST_HOST,
            port: 31530,
            user: 'SYSDBA',
            password: 'masterkey',
            databases: [{ name: 'testdb', path: '/var/lib/firebird/data/testdb.fdb' }],
            database: 'testdb',
            connectionMode: 'direct',
        }
    },
    {
        name: 'Test Firebird 4.0',
        config: {
            type: 'firebird',
            host: TEST_HOST,
            port: 31540,
            user: 'SYSDBA',
            password: 'masterkey',
            databases: [{ name: 'testdb', path: '/var/lib/firebird/data/testdb.fdb' }],
            database: 'testdb',
            connectionMode: 'direct',
        }
    },
    {
        name: 'Test Firebird 5.0',
        config: {
            type: 'firebird',
            host: TEST_HOST,
            port: 31550,
            user: 'SYSDBA',
            password: 'masterkey',
            databases: [{ name: 'testdb', path: '/var/lib/firebird/data/testdb.fdb' }],
            database: 'testdb',
            connectionMode: 'direct',
        }
    }
];

// Multi-Database test configurations
// These test the TAR-based multi-DB backup/restore functionality
export const multiDbTestConfigs = [
    {
        name: 'MySQL 9 Multi-DB',
        config: {
            type: 'mysql',
            host: TEST_HOST,
            port: 33390,
            user: 'root',
            password: 'rootpassword',
            database: ['testdb', 'mysql'] // Multiple databases
        }
    },
    {
        name: 'PostgreSQL 17 Multi-DB',
        config: {
            type: 'postgres',
            host: TEST_HOST,
            port: 54417,
            user: 'testuser',
            password: 'testpassword',
            database: ['testdb', 'postgres'] // Multiple databases
        }
    },
    {
        name: 'MongoDB 8 Multi-DB',
        config: {
            type: 'mongodb',
            host: TEST_HOST,
            port: 27708,
            user: 'root',
            password: 'rootpassword',
            database: ['testdb', 'admin'] // Multiple databases
        }
    }
];

// Databases that are known to have limitations (container currently disabled - re-enable mssql-edge in docker-compose.test.yml if needed)
export const limitedDatabases: string[] = [];

// Get list of databases to skip based on missing CLI tools
export function shouldSkipDatabase(name: string, type: string): boolean {
    // Skip known limited databases
    if (limitedDatabases.includes(name)) return true;

    // Skip if required CLI tool is not installed
    if (missingCli.includes(type)) return true;

    return false;
}

// ---------------------------------------------------------------------------
// SSH mode
//
// These sources reach their database through the `ssh-host` container from
// docker-compose.test.yml. The `host` field names a compose service, which
// only resolves from inside that container - so a test that passes proves the
// command really ran on the remote host and not in the test process.
//
// Note the CLI requirements above do NOT apply here. In SSH mode the dump and
// restore tools live on the target, so these tests run on a machine with no
// database client installed at all.
// ---------------------------------------------------------------------------

const SSH_KEY_PATH = path.resolve(__dirname, '../../.ssh-test/id_ed25519');
const SSH_PORT = 22022;

function readSshTestKey(): string | null {
    try {
        return readFileSync(SSH_KEY_PATH, 'utf8');
    } catch {
        return null;
    }
}

const sshPrivateKey = readSshTestKey();

/**
 * Probe the sshd port in a child process, since a collection-time check cannot
 * await anything. The key existing only proves someone ran the generator once,
 * not that the container is up, so both have to hold.
 */
function isPortOpen(host: string, port: number): boolean {
    const probe = [
        'const net=require("net");',
        `const s=net.connect(${port},process.argv[1]);`,
        's.on("connect",()=>{s.destroy();process.exit(0)});',
        's.on("error",()=>process.exit(1));',
        's.setTimeout(1500,()=>{s.destroy();process.exit(1)});',
    ].join('');
    try {
        execSync(`node -e '${probe}' ${host}`, { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

export const sshHostAvailable = sshPrivateKey !== null && isPortOpen(TEST_HOST, SSH_PORT);

if (!sshHostAvailable) {
    console.log('⚠️  ssh-host container not reachable - SSH mode tests will be skipped');
}

/** The prefixed convention every adapter but SQLite uses. */
/** The ssh-host container, as a config `standardTransport` can resolve. */
export const sshHostConfig = {
    connectionMode: 'ssh',
    sshHost: TEST_HOST,
    sshPort: SSH_PORT,
    sshUsername: 'root',
    sshAuthType: 'privateKey',
    sshPrivateKey: sshPrivateKey ?? '',
};

/**
 * Reaching the test environment's own Docker daemon over SSH.
 *
 * The ssh-host container has the host's socket mounted, so connecting to it and opening
 * `/var/run/docker.sock` there drives the same daemon the tests run on - which is exactly
 * the topology of a user whose Docker host is a different machine. It is the only way to
 * exercise `connectSocket` over SSH against a real server instead of a mocked ssh2.
 */
export const dockerSshConfig = {
    ...sshHostConfig,
    socketPath: '/var/run/docker.sock',
    helperImage: 'alpine:3',
};

export const sshTestDatabases = [
    // MariaDB is the native match for Debian's mariadb-client.
    //
    // mysql-9 is deliberately absent: MySQL 9 removed mysql_native_password,
    // and Debian 12's MariaDB client cannot authenticate with what replaced it.
    // mysql-57 covers the `mysql` adapter type instead.
    {
        name: 'MariaDB 11 over SSH',
        config: {
            type: 'mariadb', host: 'mariadb-11', port: 3306,
            user: 'root', password: 'rootpassword', database: 'testdb',
            ...sshHostConfig,
        },
    },
    {
        name: 'MySQL 5.7 over SSH',
        config: {
            type: 'mysql', host: 'mysql-57', port: 3306,
            user: 'root', password: 'rootpassword', database: 'testdb',
            ...sshHostConfig,
        },
    },
    // postgres-17 is absent for the mirror-image reason: pg_dump refuses to
    // read a server newer than itself, and Debian 12 ships client 15.
    {
        name: 'PostgreSQL 12 over SSH',
        config: {
            type: 'postgres', host: 'postgres-12', port: 5432,
            user: 'testuser', password: 'testpassword', database: 'testdb',
            ...sshHostConfig,
        },
    },
    {
        name: 'Redis 8 over SSH',
        config: {
            type: 'redis', host: 'redis-8', port: 6379,
            password: 'testpassword', database: 0,
            ...sshHostConfig,
        },
    },
    {
        name: 'Valkey 8 over SSH',
        config: {
            type: 'valkey', host: 'valkey-8', port: 6379,
            password: 'testpassword', database: 0,
            ...sshHostConfig,
        },
    },
    // SQLite stores `mode` plus unprefixed SSH keys, see sqlite/transport.ts.
    // The file is seeded by the container's entrypoint.
    {
        name: 'SQLite over SSH',
        config: {
            type: 'sqlite',
            mode: 'ssh',
            path: '/data/testdb.sqlite',
            host: TEST_HOST,
            port: SSH_PORT,
            username: 'root',
            authType: 'privateKey',
            privateKey: sshPrivateKey ?? '',
        },
    },
];

/**
 * Engines whose dump is a point-in-time snapshot the server writes itself,
 * with no restore counterpart to feed it back through.
 */
export const sshRestoreUnsupported = ['redis', 'valkey'];
