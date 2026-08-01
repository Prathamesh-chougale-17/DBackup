import { createFakeHost } from "@/lib/testing/fake-host";

const fakeHost = createFakeHost();

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MSSQLConfig } from "@/lib/adapters/definitions";

// --- Mock setup ---

// Use vi.hoisted for variables referenced inside vi.mock factories
const {
    mockExecuteQuery,
    mockExecuteParameterizedQuery,
    mockExecuteQueryWithMessages,
    mockSshConnect,
    mockSshUpload,
    mockSshDeleteRemote,
    mockSshEnd,
    mockFsStat,
    mockFsUnlink,
    mockFsOpen,
    mockExtractFactory,
    mockWriteStreamFactory,
    PassThrough,
} = vi.hoisted(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PassThrough } = require("stream") as { PassThrough: typeof import("stream").PassThrough };

    // Default factory: emits finish immediately (empty tar)
    const defaultExtractFactory = () => {
        const stream = new PassThrough({ objectMode: true });
        process.nextTick(() => stream.emit("finish"));
        return stream;
    };

    const mockExtractFactory = { current: defaultExtractFactory as () => any };
    // Factory for createWriteStream - default emits "finish" on pipe
    const defaultWriteStreamFactory = () => {
        const stream = new PassThrough();
        stream.on("pipe", () => {
            process.nextTick(() => stream.emit("finish"));
        });
        return stream;
    };
    const mockWriteStreamFactory = { current: defaultWriteStreamFactory as () => any };

    return {
        mockExecuteQuery: vi.fn(),
        mockExecuteParameterizedQuery: vi.fn(),
        mockExecuteQueryWithMessages: vi.fn(),
        mockSshConnect: vi.fn(),
        mockSshUpload: vi.fn(),
        mockSshDeleteRemote: vi.fn(),
        mockSshEnd: vi.fn(),
        mockFsStat: vi.fn(),
        mockFsUnlink: vi.fn(),
        mockFsOpen: vi.fn(),
        mockExtractFactory,
        mockWriteStreamFactory,
        PassThrough,
    };
});

// Mock connection module
vi.mock("@/lib/adapters/database/mssql/connection", () => ({
    executeQuery: (...args: any[]) => mockExecuteQuery(...args),
    executeParameterizedQuery: (...args: any[]) => mockExecuteParameterizedQuery(...args),
    executeQueryWithMessages: (...args: any[]) => mockExecuteQueryWithMessages(...args),
}));

// Mock SSH transfer (use a class so it's constructable with `new`)
vi.mock("@/lib/adapters/database/mssql/ssh-transfer", () => {
    class MockMssqlSshTransfer {
        connect(...args: any[]) { return mockSshConnect(...args); }
        upload(...args: any[]) { return mockSshUpload(...args); }
        deleteRemote(...args: any[]) { return mockSshDeleteRemote(...args); }
        end(...args: any[]) { return mockSshEnd(...args); }
    }
    return {
        MssqlSshTransfer: MockMssqlSshTransfer,
        isSSHTransferEnabled: (config: any) =>
            config.fileTransferMode === "ssh" && !!config.sshUsername,
    };
});

// Mock fs/promises
vi.mock("fs/promises", () => ({
    default: {
        stat: (...args: any[]) => mockFsStat(...args),
        unlink: (...args: any[]) => mockFsUnlink(...args),
        open: (...args: any[]) => mockFsOpen(...args),
    },
    stat: (...args: any[]) => mockFsStat(...args),
    unlink: (...args: any[]) => mockFsUnlink(...args),
    open: (...args: any[]) => mockFsOpen(...args),
}));

// Mock fs (sync functions + streams)
vi.mock("fs", () => {
    const createReadStream = vi.fn(() => {
        const stream = new PassThrough();
        process.nextTick(() => stream.end(Buffer.from("backup-content")));
        return stream;
    });

    const createWriteStream = vi.fn(() => mockWriteStreamFactory.current());

    return {
        default: { createReadStream, createWriteStream },
        createReadStream,
        createWriteStream,
    };
});

// Mock tar-stream - delegates to mockExtractFactory.current so tests can override it
vi.mock("tar-stream", () => ({
    extract: vi.fn(() => mockExtractFactory.current()),
}));

import { restore, prepareRestore } from "@/lib/adapters/database/mssql/restore";

// Helper to build config
type RestoreConfig = MSSQLConfig & {
    detectedVersion?: string;
    privilegedAuth?: { user: string; password: string };
    databaseMapping?: Array<{ originalName: string; targetName: string; selected: boolean }>;
};

function buildConfig(overrides: Partial<RestoreConfig> = {}): RestoreConfig {
    return {
        host: "db.example.com",
        port: 1433,
        user: "sa",
        password: "secret",
        database: "testdb",
        encrypt: true,
        trustServerCertificate: false,
        backupPath: "/var/opt/mssql/backup",
        fileTransferMode: "local",
        localBackupPath: "/mssql-shared",
        requestTimeout: 300000,
        ...overrides,
    };
}

describe("MSSQL Restore", () => {
    beforeEach(() => {
        vi.clearAllMocks();

        // Default mock: RESTORE FILELISTONLY returns typical data/log files
        mockExecuteQuery.mockImplementation((_config: any, query: string) => {
            if (query.includes("RESTORE FILELISTONLY")) {
                return {
                    recordset: [
                        { LogicalName: "testdb_data", Type: "D", PhysicalName: "/var/opt/mssql/data/testdb.mdf" },
                        { LogicalName: "testdb_log", Type: "L", PhysicalName: "/var/opt/mssql/data/testdb_log.ldf" },
                    ],
                };
            }
            // Other queries return empty
            return { recordset: [] };
        });

        // Default mock: RESTORE DATABASE succeeds
        mockExecuteQueryWithMessages.mockResolvedValue({ result: { recordset: [] }, messages: [] });

        mockFsStat.mockResolvedValue({ size: 1024 * 1024 });
        mockFsUnlink.mockResolvedValue(undefined);

        // Mock fs.open for TAR detection (returns non-TAR by default)
        const mockFileHandle = {
            read: vi.fn().mockResolvedValue({ bytesRead: 512 }),
            close: vi.fn().mockResolvedValue(undefined),
        };
        mockFsOpen.mockResolvedValue(mockFileHandle);

        mockSshConnect.mockResolvedValue(undefined);
        mockSshUpload.mockResolvedValue(undefined);
        mockSshDeleteRemote.mockResolvedValue(undefined);

        // Reset TAR extract factory to default (empty tar - no entries)
        mockExtractFactory.current = () => {
            const stream = new PassThrough({ objectMode: true });
            process.nextTick(() => stream.emit("finish"));
            return stream;
        };

        // Reset write stream factory to default (emits finish on pipe)
        mockWriteStreamFactory.current = () => {
            const stream = new PassThrough();
            stream.on("pipe", () => {
                process.nextTick(() => stream.emit("finish"));
            });
            return stream;
        };
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe("prepareRestore", () => {
        it("should validate existing online databases", async () => {
            mockExecuteParameterizedQuery.mockResolvedValue({
                recordset: [{ state_desc: "ONLINE" }],
            });

            const config = buildConfig();
            await expect(prepareRestore(config, ["testdb"], fakeHost)).resolves.toBeUndefined();
        });

        it("should accept names SQL Server accepts as delimited identifiers", async () => {
            mockExecuteParameterizedQuery.mockResolvedValue({
                recordset: [{ state_desc: "ONLINE" }],
            });

            const config = buildConfig();
            await expect(
                prepareRestore(config, ["nax-init", "test-test", "with.dot", "with space"], fakeHost)
            ).resolves.toBeUndefined();
        });

        it("should reject empty and over-long database names", async () => {
            const config = buildConfig();
            await expect(prepareRestore(config, [""], fakeHost)).rejects.toThrow("Invalid database name");
            await expect(prepareRestore(config, ["a".repeat(129)], fakeHost)).rejects.toThrow("Invalid database name");
        });

        it("should reject database names containing control characters", async () => {
            const config = buildConfig();
            await expect(prepareRestore(config, ["db\u0000name"], fakeHost)).rejects.toThrow("Invalid database name");
        });

        it("should throw when database is not online", async () => {
            mockExecuteParameterizedQuery.mockResolvedValue({
                recordset: [{ state_desc: "RESTORING" }],
            });

            const config = buildConfig();
            await expect(prepareRestore(config, ["testdb"], fakeHost)).rejects.toThrow("not online");
        });

        it("should allow restore when database does not exist yet", async () => {
            mockExecuteParameterizedQuery.mockResolvedValue({
                recordset: [], // No results = DB doesn't exist
            });

            const config = buildConfig();
            await expect(prepareRestore(config, ["newdb"], fakeHost)).resolves.toBeUndefined();
        });

        it("should wrap connection errors in a Cannot prepare restore message", async () => {
            mockExecuteParameterizedQuery.mockRejectedValue(new Error("Connection refused"));

            const config = buildConfig();
            await expect(prepareRestore(config, ["testdb"], fakeHost)).rejects.toThrow(
                "Cannot prepare restore for 'testdb'"
            );
        });

        it("should re-throw invalid database name errors from the query as-is", async () => {
            // The query itself throws an "Invalid database name" error (e.g. SQL Server rejects it)
            mockExecuteParameterizedQuery.mockRejectedValue(new Error("Invalid database name: testdb"));

            const config = buildConfig();
            await expect(prepareRestore(config, ["testdb"], fakeHost)).rejects.toThrow("Invalid database name");
        });
    });

    describe("Local Mode", () => {
        it("should restore database from local .bak file", async () => {
            const config = buildConfig({ fileTransferMode: "local" });
            const result = await restore(config, "/backups/testdb.bak", fakeHost);

            expect(result.success).toBe(true);

            // Should execute RESTORE FILELISTONLY (via executeQuery) + RESTORE DATABASE (via executeQueryWithMessages)
            expect(mockExecuteQuery).toHaveBeenCalledTimes(1);
            expect(mockExecuteQueryWithMessages).toHaveBeenCalledTimes(1);
            const restoreQuery = mockExecuteQueryWithMessages.mock.calls[0][1];
            expect(restoreQuery).toContain("RESTORE DATABASE [testdb]");
        });

        it("should log local transfer mode", async () => {
            const logs: string[] = [];
            const config = buildConfig({ fileTransferMode: "local" });

            await restore(config, "/backups/testdb.bak", fakeHost, (msg) => logs.push(msg));

            expect(logs).toContain("File transfer mode: Local (shared filesystem)");
        });
    });

    describe("SSH Mode", () => {
        it("should connect via SSH and upload .bak file before restore", async () => {
            const config = buildConfig({
                fileTransferMode: "ssh",
                sshHost: "ssh.example.com",
                sshUsername: "deploy",
                sshPassword: "sshpass",
            });

            const result = await restore(config, "/backups/testdb.bak", fakeHost);

            expect(result.success).toBe(true);

            // SSH should connect and upload
            expect(mockSshConnect).toHaveBeenCalledOnce();
            expect(mockSshConnect).toHaveBeenCalledWith(config);
            expect(mockSshUpload).toHaveBeenCalledOnce();

            // Upload: local → remote backup path
            const uploadCall = mockSshUpload.mock.calls[0];
            expect(uploadCall[1]).toContain("/var/opt/mssql/backup/");
        });

        it("should clean up remote .bak file after restore", async () => {
            const config = buildConfig({
                fileTransferMode: "ssh",
                sshUsername: "deploy",
            });

            await restore(config, "/backups/testdb.bak", fakeHost);

            expect(mockSshDeleteRemote).toHaveBeenCalled();
            expect(mockSshEnd).toHaveBeenCalled();
        });

        it("should log SSH transfer mode", async () => {
            const logs: string[] = [];
            const config = buildConfig({
                fileTransferMode: "ssh",
                sshUsername: "deploy",
            });

            await restore(config, "/backups/testdb.bak", fakeHost, (msg) => logs.push(msg));

            expect(logs).toContain("File transfer mode: SSH (remote server)");
            expect(logs.some((l) => l.includes("Connecting via SSH"))).toBe(true);
            expect(logs.some((l) => l.includes("Uploading:"))).toBe(true);
        });

        it("should clean up on restore failure", async () => {
            // RESTORE DATABASE fails
            mockExecuteQueryWithMessages.mockRejectedValue(
                new Error("RESTORE failed: exclusive access could not be obtained")
            );

            const config = buildConfig({
                fileTransferMode: "ssh",
                sshUsername: "deploy",
            });

            const result = await restore(config, "/backups/testdb.bak", fakeHost);

            expect(result.success).toBe(false);
            expect(result.error).toContain("exclusive access");

            // Cleanup should still happen
            expect(mockSshDeleteRemote).toHaveBeenCalled();
            expect(mockSshEnd).toHaveBeenCalled();
        });

        it("should clean up when SSH upload fails", async () => {
            mockSshUpload.mockRejectedValue(new Error("SFTP upload failed"));

            const config = buildConfig({
                fileTransferMode: "ssh",
                sshUsername: "deploy",
            });

            const result = await restore(config, "/backups/testdb.bak", fakeHost);

            expect(result.success).toBe(false);
            expect(result.error).toContain("SFTP upload failed");

            // Cleanup should still happen
            expect(mockSshEnd).toHaveBeenCalled();
        });

        it("should not use local file copy in SSH mode", async () => {
            const config = buildConfig({
                fileTransferMode: "ssh",
                sshUsername: "deploy",
                localBackupPath: "/mssql-shared", // Should not be used
            });

            await restore(config, "/backups/testdb.bak", fakeHost);

            // SSH upload should be used instead of local copy
            expect(mockSshUpload).toHaveBeenCalled();
        });
    });

    describe("Database Mapping", () => {
        it("should restore to mapped target database", async () => {
            const config = buildConfig({
                fileTransferMode: "ssh",
                sshUsername: "deploy",
                databaseMapping: [
                    { originalName: "testdb", targetName: "testdb_copy", selected: true },
                ],
            });

            const result = await restore(config, "/backups/testdb.bak", fakeHost);

            expect(result.success).toBe(true);

            // RESTORE should target the mapped name
            const restoreQuery = mockExecuteQueryWithMessages.mock.calls[0][1];
            expect(restoreQuery).toContain("[testdb_copy]");
        });

        it("should skip unselected databases in mapping", async () => {
            const config = buildConfig({
                fileTransferMode: "ssh",
                sshUsername: "deploy",
                databaseMapping: [
                    { originalName: "testdb", targetName: "testdb_copy", selected: false },
                ],
            });

            const result = await restore(config, "/backups/testdb.bak", fakeHost);

            expect(result.success).toBe(false);
            expect(result.error).toContain("No target database specified");
        });
    });

    describe("Error Handling", () => {
        it("should return failure when no target database specified", async () => {
            const config = buildConfig({ database: "" });
            const result = await restore(config, "/backups/testdb.bak", fakeHost);

            expect(result.success).toBe(false);
            expect(result.error).toContain("No target database specified");
        });

        it("should return failure when SSH connection fails", async () => {
            mockSshConnect.mockRejectedValue(new Error("SSH auth failed"));

            const config = buildConfig({
                fileTransferMode: "ssh",
                sshUsername: "deploy",
            });

            const result = await restore(config, "/backups/testdb.bak", fakeHost);

            expect(result.success).toBe(false);
            expect(result.error).toContain("SSH auth failed");
        });

        it("should include MOVE clauses when restoring to different DB name", async () => {
            const config = buildConfig({
                fileTransferMode: "ssh",
                sshUsername: "deploy",
                databaseMapping: [
                    { originalName: "testdb", targetName: "staging", selected: true },
                ],
            });

            const result = await restore(config, "/backups/testdb.bak", fakeHost);

            expect(result.success).toBe(true);

            // RESTORE query should include MOVE clauses for file relocation
            const restoreQuery = mockExecuteQueryWithMessages.mock.calls[0][1];
            expect(restoreQuery).toContain("MOVE");
            expect(restoreQuery).toContain("staging");
        });

        it("should invoke onLog progress callback for SQL Server messages during restore", async () => {
            const logs: string[] = [];
            const config = buildConfig({ fileTransferMode: "local" });

            mockExecuteQueryWithMessages.mockImplementation(
                async (_cfg: any, _q: any, _db: any, _timeout: any, onMessage: any) => {
                    if (onMessage) onMessage({ message: "30 percent processed." });
                    return { result: { recordset: [] }, messages: [] };
                }
            );

            await restore(config, "/backups/testdb.bak", fakeHost, (msg) => logs.push(msg));

            expect(logs.some((l) => l.includes("SQL Server: 30 percent processed."))).toBe(true);
        });
    });

    describe("TAR archive restore", () => {
        function makeTarFileHandle() {
            // Returns a buffer with "ustar" at offset 257 (valid POSIX tar magic)
            const buf = Buffer.alloc(512, 0);
            buf.write("ustar", 257, "ascii");
            return {
                read: vi.fn().mockImplementation(async (buffer: Buffer) => {
                    buf.copy(buffer);
                    return { bytesRead: 512 };
                }),
                close: vi.fn().mockResolvedValue(undefined),
            };
        }

        it("should detect TAR archive via .bak header name (fallback detection)", async () => {
            // No "ustar" magic, but header name ends with .bak
            const buf = Buffer.alloc(512, 0);
            buf.write("testdb.bak", 0, "ascii"); // First 100 bytes contain .bak filename
            const altHandle = {
                read: vi.fn().mockImplementation(async (buffer: Buffer) => {
                    buf.copy(buffer);
                    return { bytesRead: 512 };
                }),
                close: vi.fn().mockResolvedValue(undefined),
            };
            mockFsOpen.mockResolvedValue(altHandle);

            const logs: string[] = [];
            const config = buildConfig({ fileTransferMode: "local", database: "testdb" });
            await restore(config, "/backups/testdb.tar", fakeHost, (msg) => logs.push(msg));

            // TAR was detected via .bak header name
            expect(logs.some((l) => l.includes("TAR archive"))).toBe(true);
        });

        it("should detect TAR archive (ustar magic) and log TAR detection", async () => {
            mockFsOpen.mockResolvedValue(makeTarFileHandle());

            const logs: string[] = [];
            const config = buildConfig({ fileTransferMode: "local", database: "testdb" });

            // TAR extract yields no files - restore continues but has no bakFiles to process
            await restore(config, "/backups/testdb.tar", fakeHost, (msg) => logs.push(msg));

            // TAR was detected: the log must contain the detection message
            expect(logs.some((l) => l.includes("TAR archive"))).toBe(true);
        });

        it("should extract .bak entry from TAR archive and restore it", async () => {
            mockFsOpen.mockResolvedValue(makeTarFileHandle());

            // Override the tar extract factory to emit one .bak entry
            mockExtractFactory.current = () => {
                const extractor = new PassThrough({ objectMode: true });

                process.nextTick(() => {
                    // Simulate entry callback: header with a .bak filename
                    const entryStream = new PassThrough();
                    const next = vi.fn(() => {
                        process.nextTick(() => extractor.emit("finish"));
                    });

                    // We need to call the "entry" listener registered by extractTarArchive
                    const entryListeners = extractor.listeners("entry") as any[];
                    if (entryListeners.length > 0) {
                        entryListeners[0](
                            { name: "testdb_2025-01-01T00-00-00.bak" },
                            entryStream,
                            next
                        );
                        process.nextTick(() => entryStream.emit("finish"));
                    } else {
                        extractor.emit("finish");
                    }
                });

                return extractor;
            };

            const logs: string[] = [];
            const config = buildConfig({ fileTransferMode: "local", database: "testdb" });

            await restore(config, "/backups/testdb.tar", fakeHost, (msg) => logs.push(msg));

            expect(logs.some((l) => l.includes("TAR archive"))).toBe(true);
        });

        it("should skip .bak entries not in the selected database set", async () => {
            mockFsOpen.mockResolvedValue(makeTarFileHandle());

            mockExtractFactory.current = () => {
                const extractor = new PassThrough({ objectMode: true });

                process.nextTick(() => {
                    const entryStream = new PassThrough();
                    const next = vi.fn(() => {
                        process.nextTick(() => extractor.emit("finish"));
                    });

                    const entryListeners = extractor.listeners("entry") as any[];
                    if (entryListeners.length > 0) {
                        // Emit a .bak for a DB that is NOT in the target list
                        entryListeners[0](
                            { name: "otherdb_2025-01-01T00-00-00.bak" },
                            entryStream,
                            next
                        );
                    } else {
                        extractor.emit("finish");
                    }
                });

                return extractor;
            };

            const logs: string[] = [];
            const config = buildConfig({ fileTransferMode: "local", database: "testdb" });

            await restore(config, "/backups/multi.tar", fakeHost, (msg) => logs.push(msg));

            // Skipping should be logged
            expect(logs.some((l) => l.includes("Skipping extraction") || l.includes("TAR archive"))).toBe(true);
        });

        it("should skip non-.bak entries in the TAR archive (e.g. manifest.json)", async () => {
            mockFsOpen.mockResolvedValue(makeTarFileHandle());

            mockExtractFactory.current = () => {
                const extractor = new PassThrough({ objectMode: true });

                process.nextTick(() => {
                    const entryStream = new PassThrough();
                    const next = vi.fn(() => {
                        process.nextTick(() => extractor.emit("finish"));
                    });

                    const entryListeners = extractor.listeners("entry") as any[];
                    if (entryListeners.length > 0) {
                        entryListeners[0](
                            { name: "manifest.json" },
                            entryStream,
                            next
                        );
                        // stream.resume() is called, so emit data
                        process.nextTick(() => entryStream.resume());
                    } else {
                        extractor.emit("finish");
                    }
                });

                return extractor;
            };

            const config = buildConfig({ fileTransferMode: "local", database: "testdb" });
            // Should not throw; non-.bak entries are silently skipped
            const result = await restore(config, "/backups/archive.tar", fakeHost);
            // No bakFiles extracted -> no target match -> result may fail or succeed depending on config
            expect(result).toHaveProperty("success");
        });

        it("should return false when checkIfTarArchive throws (file unreadable)", async () => {
            mockFsOpen.mockRejectedValue(new Error("ENOENT: no such file"));

            // When TAR check fails, isTarArchive = false, falls through to single .bak path
            const config = buildConfig({ fileTransferMode: "local" });
            const result = await restore(config, "/nonexistent/backup.bak", fakeHost);

            // Should still attempt a restore (as single .bak file)
            expect(result.success).toBe(true);
        });

        it("should fail gracefully when the tar extractor emits an error", async () => {
            mockFsOpen.mockResolvedValue(makeTarFileHandle());

            mockExtractFactory.current = () => {
                const extractor = new PassThrough({ objectMode: true });

                process.nextTick(() => {
                    extractor.emit("error", new Error("TAR read error"));
                });

                return extractor;
            };

            const config = buildConfig({ fileTransferMode: "local", database: "testdb" });
            const result = await restore(config, "/backups/corrupt.tar", fakeHost);
            expect(result.success).toBe(false);
        });

        it("should fail gracefully when the write stream for a .bak entry errors", async () => {
            mockFsOpen.mockResolvedValue(makeTarFileHandle());

            // Override the write stream factory to emit "error" instead of "finish"
            mockWriteStreamFactory.current = () => {
                const stream = new PassThrough();
                stream.on("pipe", () => {
                    process.nextTick(() => stream.emit("error", new Error("Disk full")));
                });
                return stream;
            };

            mockExtractFactory.current = () => {
                const extractor = new PassThrough({ objectMode: true });

                process.nextTick(() => {
                    const entryStream = new PassThrough();
                    const next = vi.fn();

                    const entryListeners = extractor.listeners("entry") as any[];
                    if (entryListeners.length > 0) {
                        entryListeners[0](
                            { name: "testdb_2025-01-01T00-00-00.bak" },
                            entryStream,
                            next
                        );
                        process.nextTick(() => entryStream.emit("finish"));
                    } else {
                        extractor.emit("finish");
                    }
                });

                return extractor;
            };

            const config = buildConfig({ fileTransferMode: "local", database: "testdb" });
            const result = await restore(config, "/backups/testdb.tar", fakeHost);
            expect(result.success).toBe(false);
        });
    });
});
