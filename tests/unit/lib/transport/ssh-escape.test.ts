import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { shellEscape, buildRemoteCommand } from "@/lib/transport/ssh-escape";

const execFileAsync = promisify(execFile);

/**
 * Run a rendered command through a real /bin/sh and recover the argv the shell
 * actually produced.
 *
 * This is what turns the escaping from "looks right" into "provably right":
 * `printf '%s\0'` emits each argument verbatim separated by NUL, so any quoting
 * mistake shows up as a split, merged, or mangled argument.
 */
async function roundTripArgv(args: string[]): Promise<string[]> {
    const command = buildRemoteCommand(["printf", "%s\\0", ...args]);
    const { stdout } = await execFileAsync("/bin/sh", ["-c", command], {
        encoding: "buffer",
        maxBuffer: 1024 * 1024,
    });
    const parts = stdout.toString("utf8").split("\0");
    // printf emits a trailing NUL after the last argument.
    parts.pop();
    return parts;
}

describe("shellEscape", () => {
    it("wraps a plain value in single quotes", () => {
        expect(shellEscape("hello")).toBe("'hello'");
    });

    it("preserves an empty string as an explicit empty argument", () => {
        expect(shellEscape("")).toBe("''");
    });

    it("closes and reopens the quote around an embedded single quote", () => {
        expect(shellEscape("a'b")).toBe("'a'\\''b'");
    });

    it("leaves shell metacharacters literal instead of escaping them", () => {
        // Inside single quotes these are already inert, so no backslashes appear.
        expect(shellEscape("$(id)")).toBe("'$(id)'");
        expect(shellEscape("`id`")).toBe("'`id`'");
        expect(shellEscape("a\\b")).toBe("'a\\b'");
    });

    it("rejects a NUL byte rather than truncating the argument", () => {
        expect(() => shellEscape("a\0b")).toThrow(/NUL byte/);
    });
});

describe("buildRemoteCommand", () => {
    it("rejects an empty argv array", () => {
        expect(() => buildRemoteCommand([])).toThrow(/empty argv/);
    });

    it("quotes every argument independently", () => {
        expect(buildRemoteCommand(["mysqldump", "--user", "root"]))
            .toBe("'mysqldump' '--user' 'root'");
    });

    it("puts environment values in an export prefix, never in argv", () => {
        const command = buildRemoteCommand(["mysqldump", "-h", "db"], {
            env: { MYSQL_PWD: "s3cr3t" },
        });

        expect(command).toBe("export MYSQL_PWD='s3cr3t'; 'mysqldump' '-h' 'db'");
        // The secret must not be reachable through the remote process list.
        expect(command.slice(command.indexOf("'mysqldump'"))).not.toContain("s3cr3t");
    });

    it("skips undefined and empty environment values", () => {
        const command = buildRemoteCommand(["psql"], {
            env: { PGPASSWORD: undefined, PGUSER: "", PGHOST: "db" },
        });
        expect(command).toBe("export PGHOST='db'; 'psql'");
    });

    it("rejects an environment name that is not a valid shell identifier", () => {
        expect(() => buildRemoteCommand(["true"], { env: { "A;rm -rf /": "x" } }))
            .toThrow(/Invalid environment variable name/);
    });

    it("guards the command with cd so it cannot run in the wrong directory", () => {
        expect(buildRemoteCommand(["ls"], { cwd: "/var/backups" }))
            .toBe("cd '/var/backups' && 'ls'");
    });

    it("redirects stdin from a file on the remote host", () => {
        expect(buildRemoteCommand(["mysql"], { stdinFile: "/tmp/dump.sql" }))
            .toBe("'mysql' < '/tmp/dump.sql'");
    });

    it("orders exports, then cd, then the command", () => {
        expect(buildRemoteCommand(["mysql"], {
            env: { MYSQL_PWD: "pw" },
            cwd: "/tmp",
            stdinFile: "/tmp/in.sql",
        })).toBe("export MYSQL_PWD='pw'; cd '/tmp' && 'mysql' < '/tmp/in.sql'");
    });
});

describe("argv round-trip through a real shell", () => {
    const payloads: Array<[string, string]> = [
        ["plain value", "database"],
        ["empty string", ""],
        ["spaces", "my database"],
        ["single quote", "a'b"],
        ["double quote", 'a"b'],
        ["backslash", "a\\b"],
        ["command substitution", "a'; rm -rf /; echo '"],
        ["dollar substitution", "$(id)"],
        ["backtick substitution", "`id`"],
        ["variable expansion", "$HOME"],
        ["semicolon", "a;b"],
        ["pipe and redirect", "a|b>c<d"],
        ["ampersand", "a&b"],
        ["glob", "*"],
        ["newline", "line1\nline2"],
        ["tab", "a\tb"],
        ["leading dash", "--user=$(whoami)"],
        ["non-ascii", "Grüße_日本語_🚀"],
        ["quote soup", `'"''"'`],
    ];

    it.each(payloads)("survives %s unchanged", async (_label, payload) => {
        expect(await roundTripArgv([payload])).toEqual([payload]);
    });

    it("keeps multiple hostile arguments separate", async () => {
        const args = ["a b", "a'b", "$(id)", "", "--flag=x y"];
        expect(await roundTripArgv(args)).toEqual(args);
    });

    it("survives a 4 KiB argument", async () => {
        const payload = "x".repeat(4096);
        expect(await roundTripArgv([payload])).toEqual([payload]);
    });

    it("does not let an injected argument execute a command", async () => {
        // If quoting were broken this would run `id` and leak its output.
        const [result] = await roundTripArgv(["'; id #"]);
        expect(result).toBe("'; id #");
        expect(result).not.toMatch(/uid=\d+/);
    });
});
