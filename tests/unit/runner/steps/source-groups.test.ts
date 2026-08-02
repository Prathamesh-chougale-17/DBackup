/**
 * Collection grouping.
 *
 * The grouping decides what a backup stops, for how long, and in what order it puts things
 * back. It is pure, it is where a mistake is invisible on inspection, and its worst failure
 * mode - a source silently dropped from the plan - produces a backup that reports success
 * with a directory missing from it. So it gets a table.
 */

import { describe, it, expect, vi } from "vitest";
import { planCollectionGroups } from "@/lib/runner/steps/source-groups";
import type { DirectorySourceContext } from "@/lib/runner/types";
import type { StorageAdapter } from "@/lib/core/interfaces";

/** A plain adapter with no opinion about grouping - which is every adapter shipping today. */
function plainAdapter(id = "sftp"): StorageAdapter {
    return { id, type: "storage", name: id } as unknown as StorageAdapter;
}

/** An adapter that groups by a fixed partition, standing in for the container topology. */
function groupingAdapter(partition: (paths: string[]) => string[][], id = "docker-volume"): StorageAdapter {
    return {
        id, type: "storage", name: id,
        planSourceGroups: vi.fn(async (_config: unknown, paths: string[]) => partition(paths)),
    } as unknown as StorageAdapter;
}

function source(
    remotePath: string,
    adapter: StorageAdapter,
    overrides: Partial<DirectorySourceContext> = {}
): DirectorySourceContext {
    return {
        jobSourceId: `js-${remotePath}`,
        configId: "cfg-1",
        configName: "Docker Host",
        adapter,
        config: {},
        remotePath,
        excludePatterns: [],
        priority: 0,
        ...overrides,
    };
}

/** The remote paths of each group, which is what the assertions are actually about. */
const shape = (groups: Array<{ sources: DirectorySourceContext[] }>) =>
    groups.map((g) => g.sources.map((s) => s.remotePath));

describe("planCollectionGroups", () => {
    it("gives every source its own group when no adapter groups", async () => {
        // The regression guard for every existing job: without a grouping adapter the plan
        // has to be exactly the source list, in the job's own order.
        const adapter = plainAdapter();
        const sources = [source("/a", adapter), source("/b", adapter), source("/c", adapter)];

        expect(shape(await planCollectionGroups(sources))).toEqual([["/a"], ["/b"], ["/c"]]);
    });

    it("returns nothing for a job with no directory sources", async () => {
        expect(await planCollectionGroups([])).toEqual([]);
    });

    it("puts two volumes of one container into a single group", async () => {
        const adapter = groupingAdapter(() => [["/v-web", "/v-cache"], ["/v-db"]]);
        const sources = [source("/v-web", adapter), source("/v-cache", adapter), source("/v-db", adapter)];

        expect(shape(await planCollectionGroups(sources))).toEqual([["/v-web", "/v-cache"], ["/v-db"]]);
    });

    it("orders groups by their earliest member, so the job's own order survives", async () => {
        // The adapter returns the /v-db group first, but /v-web comes first in the job.
        const adapter = groupingAdapter(() => [["/v-db"], ["/v-cache", "/v-web"]]);
        const sources = [source("/v-web", adapter), source("/v-cache", adapter), source("/v-db", adapter)];

        expect(shape(await planCollectionGroups(sources))).toEqual([["/v-web", "/v-cache"], ["/v-db"]]);
    });

    it("keeps grouped and ungrouped sources interleaved rather than pushing one behind the other", async () => {
        const docker = groupingAdapter(() => [["/v-a", "/v-b"]]);
        const sftp = plainAdapter();
        const sources = [
            source("/files", sftp, { configId: "cfg-sftp" }),
            source("/v-a", docker),
            source("/logs", sftp, { configId: "cfg-sftp" }),
            source("/v-b", docker),
        ];

        expect(shape(await planCollectionGroups(sources))).toEqual([["/files"], ["/v-a", "/v-b"], ["/logs"]]);
    });

    it("groups each config separately, even for the same adapter", async () => {
        // Two Docker hosts. Nothing on one can share a container with anything on the other.
        const adapter = groupingAdapter((paths) => [paths]);
        const sources = [
            source("/v-1", adapter, { configId: "host-a" }),
            source("/v-2", adapter, { configId: "host-b" }),
        ];

        const groups = await planCollectionGroups(sources);
        expect(shape(groups)).toEqual([["/v-1"], ["/v-2"]]);
        expect(adapter.planSourceGroups).toHaveBeenCalledTimes(2);
    });

    it("keeps a source that forbids stopping out of the grouping entirely", async () => {
        // Grouping exists to share a stop between sources. A source that allows no stop has
        // nothing to share, and keeping it out is what makes a group uniform - an adapter
        // never sees one where half the members allow stopping and half do not.
        const adapter = groupingAdapter((paths) => [paths]);
        const sources = [
            source("/v-a", adapter),
            source("/v-live", adapter, { stopContainers: false }),
            source("/v-b", adapter),
        ];

        const groups = await planCollectionGroups(sources);
        expect(shape(groups)).toEqual([["/v-a", "/v-b"], ["/v-live"]]);
        expect(adapter.planSourceGroups).toHaveBeenCalledWith({}, ["/v-a", "/v-b"]);
    });

    it("does not consult the adapter when every source forbids stopping", async () => {
        const adapter = groupingAdapter((paths) => [paths]);
        const sources = [
            source("/v-a", adapter, { stopContainers: false }),
            source("/v-b", adapter, { stopContainers: false }),
        ];

        expect(shape(await planCollectionGroups(sources))).toEqual([["/v-a"], ["/v-b"]]);
        expect(adapter.planSourceGroups).not.toHaveBeenCalled();
    });
});

describe("planCollectionGroups rejects a partition it cannot trust", () => {
    it("fails when the adapter leaves a source out", async () => {
        // The failure this whole validation exists for: a dropped path is a directory
        // missing from a backup that still reports success.
        const adapter = groupingAdapter(() => [["/v-a"]]);
        const sources = [source("/v-a", adapter), source("/v-b", adapter)];

        await expect(planCollectionGroups(sources)).rejects.toThrow(/left 1 source\(s\) out/);
        await expect(planCollectionGroups(sources)).rejects.toThrow(/\/v-b/);
    });

    it("fails when the adapter returns a path the job never asked for", async () => {
        const adapter = groupingAdapter(() => [["/v-a", "/v-somewhere-else"]]);
        const sources = [source("/v-a", adapter)];

        await expect(planCollectionGroups(sources)).rejects.toThrow(/not part of this job/);
    });

    it("fails when the adapter puts one path in two groups", async () => {
        // Would collect it twice and archive it twice under the same source id.
        const adapter = groupingAdapter(() => [["/v-a"], ["/v-a"]]);
        const sources = [source("/v-a", adapter)];

        await expect(planCollectionGroups(sources)).rejects.toThrow(/more than one group/);
    });

    it("names the config in the message, so a multi-host job says which one", async () => {
        const adapter = groupingAdapter(() => []);
        const sources = [source("/v-a", adapter, { configId: "host-b" })];

        await expect(planCollectionGroups(sources)).rejects.toThrow(/host-b/);
    });
});
