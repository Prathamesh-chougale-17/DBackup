import { sqlpackageExporter } from "./sqlpackage";
import type { BacpacExporter } from "./types";

export type { BacpacExporter, ExporterLog } from "./types";

/**
 * Which mechanism produces the BACPAC.
 *
 * One implementation today, and the resolver exists anyway. It is the difference
 * between adding the REST mechanism later as a new file plus a branch here, and
 * adding it as a change to every call site in dump.ts and restore.ts.
 *
 * When a second one lands it selects on a config field rather than an environment
 * variable: the required credentials differ per source, so one instance has to be
 * able to serve both.
 */
export function resolveExporter(): BacpacExporter {
    return sqlpackageExporter;
}
