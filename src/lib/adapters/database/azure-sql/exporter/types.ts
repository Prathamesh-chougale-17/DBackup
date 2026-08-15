import type { ExecutionHost } from "@/lib/transport";
import type { AzureSQLConfig } from "@/lib/adapters/definitions";
import type { LogLevel, LogType } from "@/lib/core/logs";

export type ExporterLog = (msg: string, level?: LogLevel, type?: LogType, details?: string) => void;

/**
 * The single seam between what this adapter orchestrates and how a BACPAC is
 * actually produced.
 *
 * Two mechanisms can fill it. SqlPackage runs a binary in this container and is
 * what ships. The Azure Import/Export REST API drives the operation server side
 * and needs no binary at all, which mattered while it was unclear whether
 * SqlPackage runs on arm64. It does, so the REST path stays unwritten - but the
 * seam is what keeps adding it a contained change rather than a rewrite.
 *
 * Above this interface: database enumeration, multi-database TAR packing, target
 * checks, temp file lifecycle. Below it: argv or HTTP construction, credential
 * handling, and the wording of the errors. That last one matters more than it
 * looks. "sqlpackage: command not found" and "ARM returned 429" are different
 * vocabularies, and if the orchestration authored those messages it would grow a
 * mechanism switch within two changes.
 */
export interface BacpacExporter {
    readonly id: "sqlpackage";

    /**
     * Can this mechanism run here at all?
     *
     * Deliberately non-throwing, and deliberately called from `test()` rather than
     * from `dump()`. A missing binary should surface when someone clicks Test
     * Connection, not at 03:00 in a scheduled run.
     */
    probe(config: AzureSQLConfig, host: ExecutionHost): Promise<{ ok: boolean; detail: string }>;

    /**
     * Export one database to a BACPAC.
     *
     * `destPath` is a path ON `host`, and the caller is responsible for wrapping it
     * in `host.captureOutput`. On a DirectHost that wrapper is a no-op, so the
     * discipline costs nothing today and is what keeps a `host.kind` fork from
     * growing back if a transport is ever added.
     */
    exportDatabase(
        config: AzureSQLConfig,
        dbName: string,
        destPath: string,
        host: ExecutionHost,
        log: ExporterLog,
    ): Promise<void>;

    /**
     * Import a BACPAC into a target database that does not exist yet.
     *
     * `srcPath` is a path ON `host`, wrapped by the caller in `host.stageInput`.
     * Unlike the dump path, the runner does pass an `onProgress` through to
     * restore, so this one can report percentages.
     */
    importDatabase(
        config: AzureSQLConfig,
        srcPath: string,
        targetDbName: string,
        host: ExecutionHost,
        log: ExporterLog,
        onProgress?: (percentage: number, detail?: string) => void,
    ): Promise<void>;
}
