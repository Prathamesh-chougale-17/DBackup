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

    it("records the containers the run stopped", () => {
        expect(labelsFor("exec-1", ["abc", "def"])[STOPPED_LABEL]).toBe("abc,def");
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
        expect(stoppedContainersFrom(labelsFor("exec-1", ["abc", "def"]))).toEqual(["abc", "def"]);
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
        expect(stoppedContainersFrom({ [STOPPED_LABEL]: " abc , ,def, " })).toEqual(["abc", "def"]);
    });
});
