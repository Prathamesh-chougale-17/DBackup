/**
 * The labels DBackup puts on the containers it creates.
 *
 * They are the only state that survives a run being killed. The session holding the
 * bookkeeping dies with the process, so what a later run can know about a stopped container
 * is exactly what was written onto the Docker host - which makes this small parser the
 * difference between a user's database being started again and being left down.
 */

import { describe, it, expect } from "vitest";
import {
    EXECUTION_LABEL,
    STOPPED_LABEL,
    TEMP_CONTAINER_LABEL,
    labelsFor,
    stoppedContainersFrom,
} from "@/lib/adapters/storage/docker/labels";

describe("labelsFor", () => {
    it("marks the container as ours and records who made it", () => {
        const labels = labelsFor("exec-1", []);

        expect(labels[TEMP_CONTAINER_LABEL]).toBe("1");
        expect(labels[EXECUTION_LABEL]).toBe("exec-1");
    });

    it("records the containers the run stopped, with their names", () => {
        // The name travels with the id because a later run reads this label to say which
        // services an interrupted run left down, and an id alone leaves that to the operator.
        const labels = labelsFor("exec-1", [
            { id: "abc", name: "web" },
            { id: "def", name: "db" },
        ]);

        expect(labels[STOPPED_LABEL]).toBe("abc|web,def|db");
    });

    it("writes an empty list rather than omitting it", () => {
        // "Stopped nothing" is a real state - it is what a source with the stop option
        // turned off produces - and it has to be distinguishable from a label that was
        // never written by an older version.
        expect(labelsFor("exec-1", [])).toHaveProperty(STOPPED_LABEL, "");
    });
});

describe("stoppedContainersFrom", () => {
    it("reads back what labelsFor wrote", () => {
        const written = labelsFor("exec-1", [{ id: "abc", name: "web" }, { id: "def", name: "db" }]);

        expect(stoppedContainersFrom(written)).toEqual([
            { id: "abc", name: "web" },
            { id: "def", name: "db" },
        ]);
    });

    it("still reads a label written before names were carried", () => {
        // Such a helper belongs to a run from an older version. Dropping it would leave
        // exactly the containers that version stopped down for good.
        expect(stoppedContainersFrom({ [STOPPED_LABEL]: "abc,def" })).toEqual([
            { id: "abc", name: "" },
            { id: "def", name: "" },
        ]);
    });

    it("reports nothing for a run that stopped nothing", () => {
        expect(stoppedContainersFrom(labelsFor("exec-1", []))).toEqual([]);
    });

    it("reports nothing when the label is absent entirely", () => {
        // A container left by a version before the label existed, or by something else
        // wearing our marker. Neither should produce a container id of "".
        expect(stoppedContainersFrom({})).toEqual([]);
    });

    it("survives whitespace and stray separators", () => {
        expect(stoppedContainersFrom({ [STOPPED_LABEL]: " abc|web , ,def, " })).toEqual([
            { id: "abc", name: "web" },
            { id: "def", name: "" },
        ]);
    });
});
