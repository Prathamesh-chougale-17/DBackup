import { matchesExcludePattern } from "@/lib/exclude-patterns";
import { PrunedDirectory } from "@/lib/core/interfaces";
import { formatBytes } from "@/lib/utils";

/**
 * What a set of exclude patterns kept out, grouped by the pattern responsible.
 *
 * Deliberately aggregated rather than a list of paths. Execution logs are stored as a JSON
 * string on the Execution row, so logging every excluded path would put megabytes into the
 * database for a source with a `node_modules` in it - tens of thousands of lines, on every
 * single run. Grouping by pattern keeps the size tied to how many patterns exist (a handful)
 * instead of how many files matched, and it answers the question that actually matters:
 * did one of my patterns take more than I meant it to?
 */
export interface ExcludeBreakdown {
    totalFiles: number;
    totalBytes: number;
    /**
     * Directories skipped without being read.
     *
     * They contribute no files to the counts above, because their contents were never
     * listed - that is the whole saving. Counting them separately is what keeps the summary
     * honest: a pattern that prunes a large tree would otherwise report nothing at all.
     */
    prunedDirectories: number;
    byPattern: {
        pattern: string;
        files: number;
        bytes: number;
        /** A few example paths, so a pattern that matches the wrong thing is recognisable. */
        samples: string[];
        /** Directories this pattern pruned, as example paths. */
        prunedSamples: string[];
        prunedCount: number;
    }[];
}

/** How many example paths to keep per pattern - enough to judge a pattern, small enough to store. */
const SAMPLES_PER_PATTERN = 5;

/**
 * Attributes each excluded file to the first pattern that matches it.
 *
 * First match wins so the counts add up to the total - a file matched by two patterns is
 * counted once, under the earlier one.
 */
export function summariseExcluded(
    excluded: readonly { path: string; size: number }[],
    patterns: readonly string[],
    pruned: readonly PrunedDirectory[] = []
): ExcludeBreakdown {
    const active = patterns.filter((p) => p.trim().length > 0);
    type Bucket = { files: number; bytes: number; samples: string[]; prunedSamples: string[]; prunedCount: number };
    const perPattern = new Map<string, Bucket>();
    const bucketFor = (pattern: string): Bucket => {
        let bucket = perPattern.get(pattern);
        if (!bucket) {
            bucket = { files: 0, bytes: 0, samples: [], prunedSamples: [], prunedCount: 0 };
            perPattern.set(pattern, bucket);
        }
        return bucket;
    };
    let totalBytes = 0;

    for (const file of excluded) {
        totalBytes += file.size;
        const pattern = active.find((p) => matchesExcludePattern(file.path, p)) ?? "(unknown pattern)";

        const bucket = bucketFor(pattern);
        bucket.files++;
        bucket.bytes += file.size;
        if (bucket.samples.length < SAMPLES_PER_PATTERN) bucket.samples.push(file.path);
    }

    for (const directory of pruned) {
        const bucket = bucketFor(directory.pattern);
        bucket.prunedCount++;
        if (bucket.prunedSamples.length < SAMPLES_PER_PATTERN) bucket.prunedSamples.push(directory.path);
    }

    return {
        totalFiles: excluded.length,
        totalBytes,
        prunedDirectories: pruned.length,
        // Biggest contributor first - that is the one worth a second look. A pattern that only
        // pruned has no file count, so its pruned count decides its place.
        byPattern: [...perPattern.entries()]
            .map(([pattern, stats]) => ({ pattern, ...stats }))
            .sort((a, b) => (b.files - a.files) || (b.prunedCount - a.prunedCount)),
    };
}

/**
 * Renders a breakdown as a log line plus its expandable detail block.
 *
 * The message carries the totals, the details the per-pattern figures with a few example
 * paths - which is what the log viewer shows when a line is expanded.
 */
export function formatExcludeSummary(breakdown: ExcludeBreakdown): { message: string; details: string } {
    const message = `${breakdown.totalFiles} file(s) skipped by exclude patterns (${formatBytes(breakdown.totalBytes)})`
        + (breakdown.prunedDirectories > 0
            ? `, plus ${breakdown.prunedDirectories} director(ies) not scanned at all`
            : "");

    const details = breakdown.byPattern
        .map(({ pattern, files, bytes, samples, prunedSamples, prunedCount }) => {
            const header = `${pattern}  ${files} file(s), ${formatBytes(bytes)}`
                + (prunedCount > 0 ? `, ${prunedCount} director(ies) not scanned` : "");
            const shown = samples.map((s) => `    ${s}`);
            const rest = files - samples.length;
            if (rest > 0) shown.push(`    ... and ${rest} more`);

            if (prunedCount > 0) {
                shown.push("  not scanned:");
                shown.push(...prunedSamples.map((s) => `    ${s}`));
                const restPruned = prunedCount - prunedSamples.length;
                if (restPruned > 0) shown.push(`    ... and ${restPruned} more`);
            }

            return [header, ...shown].join("\n");
        })
        .join("\n");

    return { message, details };
}
