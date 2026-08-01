import type { ExecOptions } from "./types";

/**
 * Shell quoting for the SSH transport.
 *
 * This is the single place in the codebase that turns an argv array into a
 * command string. Adapters always hand over `string[]`, so a quoting bug can
 * only exist here, where one test suite covers it, instead of at every call site.
 */

/**
 * Wrap a value in single quotes so the remote shell treats it as one literal
 * argument.
 *
 * Inside single quotes every byte is literal, including backslashes, newlines,
 * `$`, and backticks. The only character that needs handling is the single
 * quote itself: close the string, emit an escaped quote, reopen.
 *
 *   a'b  ->  'a'\''b'
 */
export function shellEscape(value: string): string {
    if (value.includes("\0")) {
        // A NUL byte cannot survive a shell command line. Failing loudly beats
        // silently truncating an argument at the NUL.
        throw new Error("Argument contains a NUL byte and cannot be passed to a remote shell.");
    }
    return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Render an argv array plus execution options into a single command string for
 * `ssh2.exec`.
 *
 * Layout is `export VARS; cd DIR && argv < STDIN_FILE`:
 *   - exports come first so they apply even if `cd` fails
 *   - environment values go into `export` rather than argv, so secrets stay out
 *     of the remote process list
 *   - `cd` is joined with `&&` so the command does not run in the wrong
 *     directory when the target does not exist
 */
export function buildRemoteCommand(
    argv: string[],
    options: Pick<ExecOptions, "env" | "cwd" | "stdinFile"> = {},
): string {
    if (argv.length === 0) {
        throw new Error("Cannot build a remote command from an empty argv array.");
    }

    const exports: string[] = [];
    for (const [key, value] of Object.entries(options.env ?? {})) {
        if (value === undefined || value === "") continue;
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
            throw new Error(`Invalid environment variable name: ${key}`);
        }
        exports.push(`export ${key}=${shellEscape(value)}`);
    }

    let command = argv.map(shellEscape).join(" ");

    if (options.stdinFile) {
        command += ` < ${shellEscape(options.stdinFile)}`;
    }

    if (options.cwd) {
        command = `cd ${shellEscape(options.cwd)} && ${command}`;
    }

    return exports.length > 0 ? `${exports.join("; ")}; ${command}` : command;
}
