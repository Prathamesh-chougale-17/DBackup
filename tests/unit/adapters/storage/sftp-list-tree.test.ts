import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SFTPAdapter, endSftpClient, connectSFTP } from "@/lib/adapters/storage/sftp";
import { toRelativePath } from "@/lib/adapters/storage/common/download-directory";

const { mockSftpConnect, mockSftpEnd, mockSftpList, mockSftpExists, mockDestroy } = vi.hoisted(() => ({
    mockSftpConnect: vi.fn().mockResolvedValue(undefined),
    mockSftpEnd: vi.fn().mockResolvedValue(undefined),
    mockSftpList: vi.fn(),
    mockSftpExists: vi.fn(),
    mockDestroy: vi.fn(),
}));

vi.mock("ssh2-sftp-client", () => {
    class MockSFTPClient {
        connect = mockSftpConnect;
        end = mockSftpEnd;
        list = mockSftpList;
        exists = mockSftpExists;
        // The raw ssh2 client the wrapper holds - what endSftpClient reaches for.
        client = { destroy: mockDestroy };
    }
    return { default: MockSFTPClient };
});

vi.mock("@/lib/logging/logger", () => ({
    logger: {
        child: vi.fn().mockReturnValue({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    },
}));

const config = { host: "nas.local", port: 22, username: "backup", password: "pw" };

const dir = (name: string) => ({ name, type: "d", size: 0, modifyTime: 1_700_000_000_000 });
const file = (name: string, size = 10) => ({ name, type: "-", size, modifyTime: 1_700_000_000_000 });

/** Serves a tree keyed by absolute directory path. */
function serveTree(tree: Record<string, unknown[]>) {
    mockSftpExists.mockResolvedValue("d");
    mockSftpList.mockImplementation(async (path: string) => tree[path] ?? []);
}

describe("SFTPAdapter.listTree", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockSftpConnect.mockResolvedValue(undefined);
        mockSftpEnd.mockResolvedValue(undefined);
    });

    it("walks the whole tree when nothing is excluded", async () => {
        serveTree({
            ".": [file("a.txt"), dir("sub")],
            "sub": [file("b.txt")],
        });

        const result = await SFTPAdapter.listTree!(config, "");

        expect(result.files.map((f) => f.path).sort()).toEqual(["a.txt", "sub/b.txt"]);
        expect(result.pruned).toEqual([]);
    });

    it("never reads an excluded directory", async () => {
        serveTree({
            ".": [file("a.txt"), dir("node_modules")],
            "node_modules": [file("huge.js")],
        });

        const result = await SFTPAdapter.listTree!(config, "", { excludePatterns: ["node_modules/**"] });

        expect(result.files.map((f) => f.path)).toEqual(["a.txt"]);
        expect(result.pruned).toEqual([{ path: "node_modules", pattern: "node_modules/**" }]);
        // The saving is the listing that never happened, not a filter applied afterwards.
        expect(mockSftpList).not.toHaveBeenCalledWith("node_modules");
    });

    it("still descends where a pattern only excludes some files", async () => {
        serveTree({
            ".": [dir("logs")],
            "logs": [file("app.log"), file("keep.txt")],
        });

        const result = await SFTPAdapter.listTree!(config, "", { excludePatterns: ["*.log"] });

        // Pruning must not act on a pattern that leaves files behind - the caller filters them.
        expect(mockSftpList).toHaveBeenCalledWith("logs");
        expect(result.files.map((f) => f.path).sort()).toEqual(["logs/app.log", "logs/keep.txt"]);
        expect(result.pruned).toEqual([]);
    });

    it("matches exclude patterns against the same relative path the caller derives", async () => {
        // The sharp edge: with a pathPrefix and a subdirectory query, the walk must apply
        // patterns relative to the queried directory, not to the adapter root.
        serveTree({
            "/srv/backups/docker": [dir("node_modules"), file("compose.yml")],
            "/srv/backups/docker/node_modules": [file("x.js")],
        });

        const prefixed = { ...config, pathPrefix: "/srv/backups" };
        const result = await SFTPAdapter.listTree!(prefixed, "docker", { excludePatterns: ["node_modules/**"] });

        expect(result.pruned).toEqual([{ path: "node_modules", pattern: "node_modules/**" }]);

        // And the returned path, once the caller strips the queried directory, is the path the
        // pattern was matched against.
        const relative = toRelativePath(result.files[0].path, "docker");
        expect(relative).toBe("compose.yml");
    });

    it("reports progress while it walks", async () => {
        serveTree({
            ".": [dir("one"), dir("two")],
            "one": [file("a.txt")],
            "two": [file("b.txt")],
        });

        const seen: { files: number; directories: number }[] = [];
        await SFTPAdapter.listTree!(config, "", {
            onProgress: ({ files, directories }) => seen.push({ files, directories }),
        });

        expect(seen.length).toBeGreaterThan(0);
        expect(seen.at(-1)).toEqual({ files: 2, directories: 3 });
    });

    it("stops when the signal is already aborted", async () => {
        serveTree({ ".": [file("a.txt")] });
        const controller = new AbortController();
        controller.abort();

        await expect(SFTPAdapter.listTree!(config, "", { signal: controller.signal })).rejects.toThrow();
        expect(mockSftpList).not.toHaveBeenCalled();
    });

    it("stops mid-walk when the signal fires, and closes its connections", async () => {
        const controller = new AbortController();
        mockSftpExists.mockResolvedValue("d");
        mockSftpList.mockImplementation(async (path: string) => {
            if (path === ".") return [dir("one"), dir("two")];
            controller.abort();
            return [];
        });

        await expect(
            SFTPAdapter.listTree!(config, "", { signal: controller.signal })
        ).rejects.toThrow();

        expect(mockSftpEnd).toHaveBeenCalled();
    });

    it("returns nothing when the directory does not exist", async () => {
        mockSftpExists.mockResolvedValue(false);

        const result = await SFTPAdapter.listTree!(config, "missing");

        expect(result).toEqual({ files: [], pruned: [] });
        expect(mockSftpList).not.toHaveBeenCalled();
    });

    it("opens one connection for a serial walk and closes it afterwards", async () => {
        serveTree({ ".": [file("a.txt")] });

        await SFTPAdapter.listTree!(config, "");

        expect(mockSftpConnect).toHaveBeenCalledTimes(1);
        expect(mockSftpEnd).toHaveBeenCalledTimes(1);
    });
});

describe("connectSFTP", () => {
    beforeEach(() => vi.clearAllMocks());

    it("enables keepalive and a handshake timeout", async () => {
        await connectSFTP(config);

        // Without these ssh2 has no way to notice a connection that stopped being carried,
        // and a request waiting on it waits forever.
        expect(mockSftpConnect).toHaveBeenCalledWith(expect.objectContaining({
            readyTimeout: expect.any(Number),
            keepaliveInterval: expect.any(Number),
            keepaliveCountMax: expect.any(Number),
        }));
        const passed = mockSftpConnect.mock.calls[0][0];
        expect(passed.keepaliveInterval).toBeGreaterThan(0);
    });
});

describe("endSftpClient", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
    });

    afterEach(() => vi.useRealTimers());

    it("returns once a polite disconnect completes", async () => {
        mockSftpEnd.mockResolvedValue(undefined);
        const client = await connectSFTP(config);

        await endSftpClient(client);

        expect(mockSftpEnd).toHaveBeenCalled();
    });

    it("gives up on a disconnect that never completes and drops the socket", async () => {
        // ssh2's end() is a graceful FIN and resolves only once the peer answers. A half-open
        // connection therefore leaves it pending forever, in a finally block, after the backup
        // has already done its work.
        mockSftpEnd.mockReturnValue(new Promise(() => { }));
        const client = await connectSFTP(config);

        const done = endSftpClient(client);
        await vi.advanceTimersByTimeAsync(30_000);
        await expect(done).resolves.toBeUndefined();

        expect(mockDestroy).toHaveBeenCalled();
    });

    it("treats a failed disconnect as closed rather than propagating it", async () => {
        mockSftpEnd.mockRejectedValue(new Error("socket already gone"));
        const client = await connectSFTP(config);

        await expect(endSftpClient(client)).resolves.toBeUndefined();
        expect(mockDestroy).toHaveBeenCalled();
    });
});
