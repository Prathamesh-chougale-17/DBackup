/**
 * Which volumes get prepared together.
 *
 * This decides what a backup stops, for how long, and when it puts things back. It is pure
 * logic, and a mistake in it is invisible on inspection - the wrong grouping still produces
 * a working backup, it just stops a container twice or keeps one down far longer than it
 * needed to be. So it gets a table.
 */

import { describe, it, expect } from "vitest";
import { planVolumeGroups } from "@/lib/adapters/storage/docker/grouping";
import { createFakeDockerEngine, type FakeContainer } from "@/lib/testing/fake-docker-engine";

const container = (id: string, volumes: string[], running = true): FakeContainer =>
    ({ id, name: id, running, volumes });

async function group(containers: FakeContainer[], volumes: string[]): Promise<string[][]> {
    const engine = createFakeDockerEngine({ volumes, containers });
    return planVolumeGroups(engine, volumes);
}

describe("planVolumeGroups", () => {
    it("puts two volumes of one container in the same group", async () => {
        // The case the whole mechanism exists for: stopping that container twice would be
        // two interruptions where one was needed.
        expect(await group([container("web", ["v-web", "v-cache"])], ["v-web", "v-cache"]))
            .toEqual([["v-web", "v-cache"]]);
    });

    it("keeps volumes of different containers apart", async () => {
        // So the first container is running again before the second one is touched.
        const containers = [container("web", ["v-web"]), container("db", ["v-db"])];

        expect(await group(containers, ["v-web", "v-db"])).toEqual([["v-web"], ["v-db"]]);
    });

    it("works the whole example through: three volumes, two containers", async () => {
        const containers = [
            container("web", ["v-web", "v-cache"]),
            container("db", ["v-db"]),
        ];

        expect(await group(containers, ["v-web", "v-cache", "v-db"]))
            .toEqual([["v-web", "v-cache"], ["v-db"]]);
    });

    it("pulls both containers in when one volume is shared between them", async () => {
        const containers = [container("a", ["v-shared"]), container("b", ["v-shared"])];

        expect(await group(containers, ["v-shared"])).toEqual([["v-shared"]]);
    });

    it("pulls in everything a shared container also holds", async () => {
        // v-shared is on a and b, so b comes along, and with b comes v-only-b. Transitivity
        // is the part a hand-written grouping gets wrong.
        const containers = [
            container("a", ["v-only-a", "v-shared"]),
            container("b", ["v-shared", "v-only-b"]),
        ];

        expect(await group(containers, ["v-only-a", "v-shared", "v-only-b"]))
            .toEqual([["v-only-a", "v-shared", "v-only-b"]]);
    });

    it("chains through several containers", async () => {
        // a-b via v2, b-c via v3. Everything is one component even though a and c share
        // nothing directly.
        const containers = [
            container("a", ["v1", "v2"]),
            container("b", ["v2", "v3"]),
            container("c", ["v3", "v4"]),
        ];

        expect(await group(containers, ["v1", "v2", "v3", "v4"])).toEqual([["v1", "v2", "v3", "v4"]]);
    });

    it("gives a volume with no container a group of its own", async () => {
        const containers = [container("web", ["v-web"])];

        expect(await group(containers, ["v-web", "v-orphan"])).toEqual([["v-web"], ["v-orphan"]]);
    });

    it("ignores containers holding volumes this job did not ask for", async () => {
        // Two containers, one volume each, but only one volume is in the job. Nothing links
        // them, and pulling the other container's volume in would back up more than asked.
        const containers = [container("web", ["v-web"]), container("other", ["v-other"])];

        expect(await group(containers, ["v-web"])).toEqual([["v-web"]]);
    });

    it("groups a stopped container's volumes the same way as a running one's", async () => {
        // Whether it is running decides whether it gets stopped, not whether it groups.
        const containers = [container("web", ["v-a", "v-b"], false)];

        expect(await group(containers, ["v-a", "v-b"])).toEqual([["v-a", "v-b"]]);
    });

    it("places each group where its earliest volume was", async () => {
        // Preserves the order the user gave the job, as far as the grouping allows.
        const containers = [container("db", ["v-db"]), container("web", ["v-web", "v-cache"])];

        expect(await group(containers, ["v-web", "v-db", "v-cache"]))
            .toEqual([["v-web", "v-cache"], ["v-db"]]);
    });

    it("does not confuse a container and a volume that share a name", async () => {
        // Both go into one disjoint-set structure, so they have to be told apart or two
        // unrelated groups get glued together.
        const containers = [container("data", ["v-a"]), container("other", ["data"])];

        expect(await group(containers, ["v-a", "data"])).toEqual([["v-a"], ["data"]]);
    });

    it("returns nothing for nothing", async () => {
        expect(await group([], [])).toEqual([]);
    });
});
