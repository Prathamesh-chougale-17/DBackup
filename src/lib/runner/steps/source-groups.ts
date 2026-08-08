/**
 * Groups a run's directory sources into units that share one preparation.
 *
 * Most adapters have nothing to share: reading one folder over SFTP has no bearing on
 * reading the next, so every source is its own group and the collection behaves exactly as
 * it did before groups existed. The mechanism exists for the sources where preparation
 * reaches past the source itself - a container volume can only be read once the containers
 * holding it are stopped, two volumes of the same container must stop it once rather than
 * twice, and a container whose volumes are done should start again immediately rather than
 * waiting out the rest of the job.
 *
 * The grouping decision belongs to the adapter, which is the only thing that knows what a
 * path costs to prepare. This module owns the ordering, the validation and the default.
 */

import type { DirectorySourceContext } from "../types";

export interface CollectionGroup {
    /** Sources collected one after another under a single shared preparation. */
    sources: DirectorySourceContext[];
}

/** One group per source, in the order the job lists them. */
function ungrouped(sources: readonly DirectorySourceContext[]): CollectionGroup[] {
    return sources.map((source) => ({ sources: [source] }));
}

/**
 * A path can repeat across configs but not within one, so the key has to carry both.
 * `JobSource` enforces that with a unique constraint on (job, config, path).
 */
function keyOf(source: DirectorySourceContext): string {
    return `${source.configId}\0${source.remotePath}`;
}

/**
 * Plans the collection order for one run.
 *
 * Sources of an adapter without `planSourceGroups` keep their original position. Sources of
 * one that has it are handed to it per config, and the groups it returns are placed at the
 * position of their earliest member - so a job's own ordering survives as far as the
 * grouping allows.
 *
 * Throws when an adapter returns a partition that does not cover its input exactly once.
 * That is deliberately fatal: a dropped path is a file missing from a backup that would
 * otherwise report success, which is the one failure this project treats as worse than a
 * failed run.
 */
export async function planCollectionGroups(
    sources: readonly DirectorySourceContext[]
): Promise<CollectionGroup[]> {
    const byConfig = new Map<string, DirectorySourceContext[]>();
    for (const source of sources) {
        if (!source.adapter.planSourceGroups) continue;
        // A source whose job entry forbids stopping anything is never offered to the
        // grouping. Grouping exists to share a stop between sources, so there is nothing to
        // share here, and keeping it out means the group it would have joined stays uniform:
        // an adapter never sees a group where half the members allow stopping and half do
        // not. The cost is that such a source is read live even when its container happens
        // to be down anyway for a neighbour - deliberate, because the alternative makes the
        // result depend on what else is in the job.
        if (source.stopContainers === false) continue;
        const existing = byConfig.get(source.configId);
        if (existing) existing.push(source);
        else byConfig.set(source.configId, [source]);
    }

    if (byConfig.size === 0) return ungrouped(sources);

    const position = new Map(sources.map((source, index) => [keyOf(source), index]));
    const planned: Array<{ at: number; group: CollectionGroup }> = [];
    const grouped = new Set<string>();

    for (const [configId, configSources] of byConfig) {
        const byPath = new Map(configSources.map((source) => [source.remotePath, source]));
        const partition = await configSources[0].adapter.planSourceGroups!(
            configSources[0].config,
            [...byPath.keys()]
        );

        const seen = new Set<string>();
        for (const paths of partition) {
            const members: DirectorySourceContext[] = [];
            for (const remotePath of paths) {
                const source = byPath.get(remotePath);
                if (!source) {
                    throw new Error(
                        `Adapter '${configSources[0].adapter.id}' grouped a path that is not part of this job: '${remotePath}'`
                    );
                }
                if (seen.has(remotePath)) {
                    throw new Error(
                        `Adapter '${configSources[0].adapter.id}' placed '${remotePath}' in more than one group`
                    );
                }
                seen.add(remotePath);
                members.push(source);
            }
            if (members.length === 0) continue;

            members.sort((a, b) => position.get(keyOf(a))! - position.get(keyOf(b))!);
            members.forEach((member) => grouped.add(keyOf(member)));
            planned.push({ at: position.get(keyOf(members[0]))!, group: { sources: members } });
        }

        const missing = [...byPath.keys()].filter((remotePath) => !seen.has(remotePath));
        if (missing.length > 0) {
            throw new Error(
                `Adapter '${configSources[0].adapter.id}' left ${missing.length} source(s) out of its grouping: ${missing.join(", ")}. `
                + `Config '${configId}' would have backed up less than the job asks for.`
            );
        }
    }

    // Everything the grouping did not touch keeps its own slot, so the two kinds of source
    // interleave in the job's order rather than one being pushed behind the other.
    for (const source of sources) {
        if (grouped.has(keyOf(source))) continue;
        planned.push({ at: position.get(keyOf(source))!, group: { sources: [source] } });
    }

    planned.sort((a, b) => a.at - b.at);
    return planned.map((entry) => entry.group);
}
