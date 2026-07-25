import { describe, it, expect, vi, beforeEach } from "vitest";
import { SFTPAdapter } from "@/lib/adapters/storage/sftp";

// --- Hoisted mocks ---
const { mockSftpConnect, mockSftpEnd, mockSftpPut, mockSftpGet, mockSftpFastGet, mockSftpList, mockSftpExists, mockSftpMkdir, mockSftpDelete, mockSftpStat, mockSftpCwd, mockFsStat } = vi.hoisted(() => ({
    mockSftpConnect: vi.fn(),
    mockSftpEnd: vi.fn().mockResolvedValue(undefined),
    mockSftpPut: vi.fn().mockResolvedValue(undefined),
    mockSftpGet: vi.fn().mockResolvedValue(undefined),
    mockSftpFastGet: vi.fn().mockResolvedValue(undefined),
    mockSftpList: vi.fn(),
    mockSftpExists: vi.fn(),
    mockSftpMkdir: vi.fn().mockResolvedValue(undefined),
    mockSftpDelete: vi.fn().mockResolvedValue(undefined),
    mockSftpStat: vi.fn(),
    mockSftpCwd: vi.fn(),
    mockFsStat: vi.fn().mockResolvedValue({ size: 1024 }),
}));

vi.mock("ssh2-sftp-client", () => {
    class MockSFTPClient {
        connect = mockSftpConnect;
        end = mockSftpEnd;
        put = mockSftpPut;
        get = mockSftpGet;
        fastGet = mockSftpFastGet;
        list = mockSftpList;
        exists = mockSftpExists;
        mkdir = mockSftpMkdir;
        delete = mockSftpDelete;
        stat = mockSftpStat;
        cwd = mockSftpCwd;
    }
    return { default: MockSFTPClient };
});

vi.mock("fs", () => ({
    createReadStream: vi.fn(() => ({ pipe: vi.fn(), destroy: vi.fn() })),
    default: {
        createReadStream: vi.fn(() => ({ pipe: vi.fn(), destroy: vi.fn() })),
    },
    promises: {
        stat: mockFsStat,
    },
}));

vi.mock("@/lib/logging/logger", () => ({
    logger: {
        child: vi.fn().mockReturnValue({
            info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(),
        }),
    },
}));

vi.mock("@/lib/logging/errors", () => ({
    wrapError: vi.fn((e) => e),
}));

// --- Base config ---
const config = {
    host: "sftp.example.com",
    port: 22,
    username: "backupuser",
    password: "secret",
    pathPrefix: "/backups",
};

describe("SFTPAdapter", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockSftpConnect.mockResolvedValue(undefined);
        mockSftpEnd.mockResolvedValue(undefined);
        mockSftpPut.mockResolvedValue(undefined);
        mockSftpDelete.mockResolvedValue(undefined);
        mockSftpMkdir.mockResolvedValue(undefined);
        mockSftpExists.mockResolvedValue("d");
        mockSftpCwd.mockResolvedValue("/");
        mockFsStat.mockResolvedValue({ size: 1024 });
    });

    // ===== upload() =====

    describe("upload()", () => {
        it("returns true on successful upload", async () => {
            mockSftpExists.mockResolvedValue("d"); // dir exists
            mockSftpPut.mockResolvedValue(undefined);

            const result = await SFTPAdapter.upload(config, "/tmp/backup.sql", "Job/backup.sql");

            expect(result).toBe(true);
            expect(mockSftpPut).toHaveBeenCalled();
            expect(mockSftpEnd).toHaveBeenCalled();
        });

        it("creates remote directory when it does not exist", async () => {
            // The configured path exists, the job folder below it does not.
            mockSftpExists.mockImplementation(async (p: string) => (p === '/backups' ? 'd' : false));
            mockSftpMkdir.mockResolvedValue(undefined);
            mockSftpPut.mockResolvedValue(undefined);

            await SFTPAdapter.upload(config, "/tmp/backup.sql", "Job/backup.sql");

            expect(mockSftpMkdir).toHaveBeenCalledWith('/backups/Job');
        });

        it("fails with the configured path when that path is unreachable", async () => {
            // Rather than climbing upwards and reporting a permission error on a path the
            // user never entered - which is what made the original failure so confusing.
            mockSftpExists.mockResolvedValue(false);
            mockSftpPut.mockResolvedValue(undefined);

            const ok = await SFTPAdapter.upload(config, "/tmp/backup.sql", "Job/backup.sql");

            expect(ok).toBe(false);
            expect(mockSftpMkdir).not.toHaveBeenCalled();
        });

        it("returns false when connection fails", async () => {
            mockSftpConnect.mockRejectedValue(new Error("ECONNREFUSED"));

            const result = await SFTPAdapter.upload(config, "/tmp/backup.sql", "Job/backup.sql");

            expect(result).toBe(false);
        });

        it("returns false when put() throws", async () => {
            mockSftpExists.mockResolvedValue("d");
            mockSftpPut.mockRejectedValue(new Error("Disk full"));

            const result = await SFTPAdapter.upload(config, "/tmp/backup.sql", "Job/backup.sql");

            expect(result).toBe(false);
        });

        it("always calls end() even on failure", async () => {
            mockSftpExists.mockResolvedValue("d");
            mockSftpPut.mockRejectedValue(new Error("Error"));

            await SFTPAdapter.upload(config, "/tmp/backup.sql", "Job/backup.sql");

            expect(mockSftpEnd).toHaveBeenCalled();
        });

        it("logs connection and start messages", async () => {
            mockSftpExists.mockResolvedValue("d");
            mockSftpPut.mockResolvedValue(undefined);
            const onLog = vi.fn();

            await SFTPAdapter.upload(config, "/tmp/backup.sql", "Job/backup.sql", undefined, onLog);

            expect(onLog).toHaveBeenCalledWith(expect.stringContaining("sftp.example.com"), "info", "storage");
        });
    });

    // ===== download() =====

    describe("download()", () => {
        it("returns true on successful download (no progress)", async () => {
            mockSftpGet.mockResolvedValue(undefined);

            const result = await SFTPAdapter.download(config, "Job/backup.sql", "/tmp/out.sql");

            expect(result).toBe(true);
            expect(mockSftpGet).toHaveBeenCalled();
        });

        it("returns false when get() throws", async () => {
            mockSftpGet.mockRejectedValue(new Error("No such file"));

            const result = await SFTPAdapter.download(config, "Job/missing.sql", "/tmp/out.sql");

            expect(result).toBe(false);
        });

        it("uses fastGet when onProgress is provided", async () => {
            mockSftpStat.mockResolvedValue({ size: 2048 });
            mockSftpFastGet.mockResolvedValue(undefined);

            const onProgress = vi.fn();
            const result = await SFTPAdapter.download(config, "Job/backup.sql", "/tmp/out.sql", onProgress);

            expect(result).toBe(true);
            expect(mockSftpFastGet).toHaveBeenCalled();
        });
    });

    // ===== list() =====

    describe("list()", () => {
        it("returns files from directory walk", async () => {
            mockSftpExists.mockResolvedValue("d");
            mockSftpList.mockResolvedValue([
                { name: "backup.sql", type: "-", size: 1024, modifyTime: Date.now() },
            ]);

            const result = await SFTPAdapter.list(config, "Job");

            expect(result).toHaveLength(1);
            expect(result[0].name).toBe("backup.sql");
        });

        it("returns empty array when directory does not exist", async () => {
            mockSftpExists.mockResolvedValue(false);

            const result = await SFTPAdapter.list(config, "NonExistent");

            expect(result).toEqual([]);
        });

        it("throws on connection error", async () => {
            mockSftpConnect.mockRejectedValue(new Error("Auth failed"));

            await expect(SFTPAdapter.list(config, "Job")).rejects.toThrow("Auth failed");
        });

        it("recurses into subdirectories", async () => {
            mockSftpExists.mockResolvedValue("d");
            mockSftpList
                .mockResolvedValueOnce([
                    { name: "subdir", type: "d", size: 0, modifyTime: Date.now() },
                ])
                .mockResolvedValueOnce([
                    { name: "nested.sql", type: "-", size: 512, modifyTime: Date.now() },
                ]);

            const result = await SFTPAdapter.list(config, "Job");

            expect(result).toHaveLength(1);
            expect(result[0].name).toBe("nested.sql");
        });

        it("strips pathPrefix from returned paths", async () => {
            mockSftpExists.mockResolvedValue("d");
            mockSftpList.mockResolvedValue([
                { name: "backup.sql", type: "-", size: 100, modifyTime: Date.now() },
            ]);

            const result = await SFTPAdapter.list(config, "Job");

            // path should be relative to pathPrefix, not including /backups
            expect(result[0].path).not.toContain("/backups");
        });
    });

    // ===== delete() =====

    describe("delete()", () => {
        it("returns true on successful delete", async () => {
            mockSftpDelete.mockResolvedValue(undefined);

            const result = await SFTPAdapter.delete(config, "Job/backup.sql");

            expect(result).toBe(true);
        });

        it("returns false when delete() throws", async () => {
            mockSftpDelete.mockRejectedValue(new Error("Permission denied"));

            const result = await SFTPAdapter.delete(config, "Job/backup.sql");

            expect(result).toBe(false);
        });
    });

    // ===== test() =====

    describe("test()", () => {
        it("returns success when connect succeeds", async () => {
            const result = await SFTPAdapter.test!(config);

            expect(result.success).toBe(true);
            expect(mockSftpEnd).toHaveBeenCalled();
        });

        it("returns failure when connection throws", async () => {
            mockSftpConnect.mockRejectedValue(new Error("Host unreachable"));

            const result = await SFTPAdapter.test!(config);

            expect(result.success).toBe(false);
            expect(result.message).toContain("Host unreachable");
        });

        it("creates only the directories below the configured path", async () => {
            // The configured path exists; everything under it does not yet.
            mockSftpExists.mockImplementation(async (p: string) => (p === '/backups' ? 'd' : false));

            const result = await SFTPAdapter.test!(config);

            expect(result.success).toBe(true);
            // Segment by segment, never the prefix itself and never a recursive walk that
            // could climb above it.
            expect(mockSftpMkdir).toHaveBeenCalledWith('/backups/.dbackup');
            expect(mockSftpMkdir).toHaveBeenCalledWith('/backups/.dbackup/test');
            const targets = mockSftpMkdir.mock.calls.map((c) => c[0] as string);
            expect(targets).not.toContain('/backups');
            expect(targets.every((t) => t.startsWith('/backups/'))).toBe(true);
        });

        it("never tries to create anything above the configured path", async () => {
            // The case from a NAS: the account may write inside its share but cannot stat the
            // volume above it, so exists() says false for everything. The library's recursive
            // mkdir climbed to the root and failed with "Permission denied /volume1" - a path
            // the user never configured. It must report the configured path instead.
            const nasConfig = { ...config, pathPrefix: '/volume1/Transfer/restore' };
            mockSftpExists.mockResolvedValue(false);

            const result = await SFTPAdapter.test!(nasConfig);

            expect(result.success).toBe(false);
            expect(result.message).toContain('/volume1/Transfer/restore');
            expect(mockSftpMkdir).not.toHaveBeenCalled();
        });

        it("names the exact segment of the path that stops being reachable", async () => {
            // "Path not reachable" cannot be acted on. Knowing that the share is visible but the
            // folder inside it is not turns it into a permissions fix on one specific folder.
            mockSftpExists.mockImplementation(async (p: string) => (p === '/volume1' || p === '/volume1/Transfer' ? 'd' : false));

            const result = await SFTPAdapter.test!({ ...config, pathPrefix: '/volume1/Transfer/restore' });

            expect(result.message).toContain('"/volume1/Transfer" is reachable');
            expect(result.message).toContain('"/volume1/Transfer/restore" inside it is not');
        });

        it("names the corrected path when SFTP is confined below the filesystem root", async () => {
            // The Synology case: SFTP shows /volume1 as "/", so a path written from the real
            // filesystem's point of view carries a segment that cannot exist inside it. Both
            // halves are known here, so the fix is computed rather than left as a deduction.
            mockSftpExists.mockResolvedValue(false);
            mockSftpCwd.mockResolvedValue('/');
            mockSftpList.mockResolvedValue([
                { name: 'Transfer', type: 'd' },
                { name: 'homes', type: 'd' },
            ]);

            // Only the rewritten path resolves - the configured one is what failed.
            mockSftpExists.mockImplementation(async (p: string) => (p === '/Transfer/restore' ? 'd' : false));

            const result = await SFTPAdapter.test!({ ...config, pathPrefix: '/volume1/Transfer/restore' });

            expect(result.message).toContain('Use "/Transfer/restore" as the path instead');
        });

        it("keeps as much of the configured path as possible when suggesting", async () => {
            // The outermost match wins. Matching the innermost segment would suggest "/restore"
            // and silently drop a level the user does want.
            mockSftpCwd.mockResolvedValue('/');
            mockSftpList.mockResolvedValue([
                { name: 'Transfer', type: 'd' },
                { name: 'restore', type: 'd' },
            ]);
            // Both rewrites resolve, so only the preference decides which one is offered.
            mockSftpExists.mockImplementation(async (p: string) =>
                (p === '/Transfer/restore' || p === '/restore' ? 'd' : false));

            const result = await SFTPAdapter.test!({ ...config, pathPrefix: '/volume1/Transfer/restore' });

            expect(result.message).toContain('Use "/Transfer/restore" as the path instead');
        });

        it("does not offer a rewritten path that the server does not have either", async () => {
            // A folder name can line up by coincidence. Offering an unverified guess would send
            // the user to a path that fails exactly the same way, so it is checked first.
            mockSftpExists.mockResolvedValue(false);
            mockSftpCwd.mockResolvedValue('/');
            mockSftpList.mockResolvedValue([{ name: 'Transfer', type: 'd' }]);

            const result = await SFTPAdapter.test!({ ...config, pathPrefix: '/volume1/Transfer/restore' });

            expect(result.message).not.toMatch(/as the path instead/);
            // Falls back to the listing, which is the most useful thing left to offer.
            expect(result.message).toContain('starts at "/"');
        });

        it("suggests nothing when the path's own first segment is the visible one", async () => {
            // Then the path is already written from the right root and the cause is elsewhere -
            // proposing the identical path back would be noise dressed up as a fix.
            mockSftpExists.mockResolvedValue(false);
            mockSftpCwd.mockResolvedValue('/');
            mockSftpList.mockResolvedValue([{ name: 'Transfer', type: 'd' }]);

            const result = await SFTPAdapter.test!({ ...config, pathPrefix: '/Transfer/restore' });

            expect(result.message).not.toMatch(/as the path instead/);
        });

        it("falls back to listing what the account can see when nothing matches", async () => {
            // No overlap between the path and the visible folders means there is nothing to
            // compute - the listing is then the most useful thing left to offer.
            mockSftpExists.mockResolvedValue(false);
            mockSftpCwd.mockResolvedValue('/homes/backupuser');
            mockSftpList.mockResolvedValue([
                { name: 'Documents', type: 'd' },
                { name: 'notes.txt', type: '-' },
            ]);

            const result = await SFTPAdapter.test!({ ...config, pathPrefix: '/volume1/Transfer' });

            expect(result.message).toContain('starts at "/homes/backupuser"');
            expect(result.message).toContain('Documents');
            // Files are noise here - only folders can be a path prefix.
            expect(result.message).not.toContain('notes.txt');
            expect(result.message).toMatch(/relative to it/i);
        });

        it("says how many folders it left out rather than looking complete", async () => {
            // A capped list that does not admit to being capped is worse than no list: a folder
            // below the cut-off looks like a folder that does not exist, which sends the user
            // looking for the wrong problem.
            mockSftpExists.mockResolvedValue(false);
            mockSftpCwd.mockResolvedValue('/');
            mockSftpList.mockResolvedValue(
                Array.from({ length: 15 }, (_, i) => ({ name: `folder${i}`, type: 'd' }))
            );

            const result = await SFTPAdapter.test!({ ...config, pathPrefix: '/volume1/Transfer' });

            expect(result.message).toContain('(and 3 more)');
        });

        it("still reports the configured path when the server refuses every diagnostic probe", async () => {
            // A locked-down server may answer neither cwd nor list. The primary message has to
            // survive that - a diagnostic failure must never replace the actual error.
            mockSftpExists.mockResolvedValue(false);
            mockSftpCwd.mockRejectedValue(new Error('permission denied'));
            mockSftpList.mockRejectedValue(new Error('permission denied'));

            const result = await SFTPAdapter.test!({ ...config, pathPrefix: '/volume1/Transfer' });

            expect(result.success).toBe(false);
            expect(result.message).toContain('/volume1/Transfer');
        });
    });

    // ===== download() fastGet step callback =====

    describe("download() fastGet step callback", () => {
        it("invokes onProgress via fastGet step callback", async () => {
            mockSftpStat.mockResolvedValue({ size: 2048 });
            let stepCb: ((transferred: number) => void) | undefined;
            mockSftpFastGet.mockImplementation((_src: unknown, _dst: unknown, opts: { step?: (t: number) => void }) => {
                stepCb = opts?.step;
                return Promise.resolve(undefined);
            });

            const onProgress = vi.fn();
            await SFTPAdapter.download(config, "Job/backup.sql", "/tmp/out.sql", onProgress);

            stepCb?.(1024);
            expect(onProgress).toHaveBeenCalledWith(1024, 2048);
        });
    });

    // ===== read() non-Buffer result =====

    describe("read() non-Buffer result", () => {
        it("returns null when sftp.get() returns non-Buffer value", async () => {
            mockSftpGet.mockResolvedValue(null);

            const result = await SFTPAdapter.read!(config, "Job/meta.json");

            expect(result).toBeNull();
        });

        it("returns null when sftp.get() throws", async () => {
            mockSftpGet.mockRejectedValue(new Error("File not found"));

            const result = await SFTPAdapter.read!(config, "Job/missing.meta.json");

            expect(result).toBeNull();
        });

        it("works without pathPrefix (uses remotePath directly)", async () => {
            const noPrefix = { ...config, pathPrefix: undefined };
            mockSftpGet.mockResolvedValue(Buffer.from("content"));

            const result = await SFTPAdapter.read!(noPrefix, "backup.meta.json");

            expect(result).toBe("content");
        });
    });

    // ====================================================================
    // upload() step callback progress (lines 76-80)
    // ====================================================================
    describe("upload() step callback progress", () => {
        it("invokes onProgress via put step callback when totalSize > 0", async () => {
            mockSftpExists.mockResolvedValue("d");
            mockFsStat.mockResolvedValue({ size: 2048 });

            let stepCb: ((transferred: number, chunk: unknown, total: number) => void) | undefined;
            mockSftpPut.mockImplementation((_src: unknown, _dst: unknown, opts: any) => {
                stepCb = opts?.step;
                return Promise.resolve(undefined);
            });

            const onProgress = vi.fn();
            await SFTPAdapter.upload(config, "/tmp/backup.sql", "Job/backup.sql", onProgress);

            // Simulate data transfer: 1024 of 2048 bytes transferred
            stepCb?.(1024, null, 2048);

            expect(onProgress).toHaveBeenCalledWith(50); // 1024/2048 * 100 = 50
        });

        it("does not call onProgress when totalSize is 0", async () => {
            mockSftpExists.mockResolvedValue("d");
            mockFsStat.mockResolvedValue({ size: 0 });

            let stepCb: ((transferred: number, chunk: unknown, total: number) => void) | undefined;
            mockSftpPut.mockImplementation((_src: unknown, _dst: unknown, opts: any) => {
                stepCb = opts?.step;
                return Promise.resolve(undefined);
            });

            const onProgress = vi.fn();
            await SFTPAdapter.upload(config, "/tmp/backup.sql", "Job/backup.sql", onProgress);

            stepCb?.(0, null, 0);

            // totalSize = 0 → step callback guard: if (totalSize > 0) is false → no call
            expect(onProgress).not.toHaveBeenCalled();
        });
    });
});
