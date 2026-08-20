import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { ValidationError } from "@/lib/logging/errors";

const mockGetAuthContext = vi.fn();
const mockCheckPermissionWithContext = vi.fn();
vi.mock("@/lib/auth/access-control", () => ({
    getAuthContext: (...args: unknown[]) => mockGetAuthContext(...args),
    checkPermissionWithContext: (...args: unknown[]) => mockCheckPermissionWithContext(...args),
}));

vi.mock("next/headers", () => ({
    headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock("@/lib/auth/permissions", () => ({
    PERMISSIONS: {
        JOBS: { WRITE: "jobs:write" },
    },
}));

const mockCreateJob = vi.fn();
const mockUpdateJob = vi.fn();
vi.mock("@/services/jobs/job-service", () => ({
    jobService: {
        createJob: (...args: unknown[]) => mockCreateJob(...args),
        updateJob: (...args: unknown[]) => mockUpdateJob(...args),
    },
}));

vi.mock("@/lib/prisma", () => ({
    default: {
        systemSetting: { findUnique: vi.fn() },
    },
}));

vi.mock("@/lib/logging/logger", () => ({
    logger: {
        child: () => ({
            error: vi.fn(),
        }),
    },
}));

const { POST } = await import("@/app/api/jobs/route");
const { PUT } = await import("@/app/api/jobs/[id]/route");

function createPostRequest() {
    return new NextRequest("http://localhost:3000/api/jobs", {
        method: "POST",
        body: JSON.stringify({
            name: "MongoDB full instance",
            schedule: "0 0 * * *",
            sourceId: "source-1",
            backupScope: "FULL_INSTANCE",
            destinations: [{ configId: "destination-1" }],
        }),
    });
}

function createPutRequest() {
    return new NextRequest("http://localhost:3000/api/jobs/job-1", {
        method: "PUT",
        body: JSON.stringify({ backupScope: "FULL_INSTANCE" }),
    });
}

function createProps() {
    return { params: Promise.resolve({ id: "job-1" }) };
}

describe("MongoDB backup scope errors in job routes", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetAuthContext.mockResolvedValue({ userId: "user-1" });
        mockCheckPermissionWithContext.mockReturnValue(undefined);
    });

    it("returns 400 when creating a job violates backup scope validation", async () => {
        mockCreateJob.mockRejectedValue(
            new ValidationError("Full Instance is only supported for MongoDB jobs")
        );

        const response = await POST(createPostRequest());
        const body = await response.json();

        expect(response.status).toBe(400);
        expect(body.error).toBe("Full Instance is only supported for MongoDB jobs");
    });

    it("returns 400 when updating a job violates backup scope validation", async () => {
        mockUpdateJob.mockRejectedValue(
            new ValidationError("Full Instance cannot be combined with directory sources")
        );

        const response = await PUT(createPutRequest(), createProps());
        const body = await response.json();

        expect(response.status).toBe(400);
        expect(body.error).toBe("Full Instance cannot be combined with directory sources");
    });

    it("keeps duplicate job names as 409 when creating a job", async () => {
        mockCreateJob.mockRejectedValue(
            new Error('A job with the name "MongoDB full instance" already exists.')
        );

        const response = await POST(createPostRequest());

        expect(response.status).toBe(409);
    });

    it("keeps duplicate job names as 409 when updating a job", async () => {
        mockUpdateJob.mockRejectedValue(
            new Error('A job with the name "MongoDB full instance" already exists.')
        );

        const response = await PUT(createPutRequest(), createProps());

        expect(response.status).toBe(409);
    });
});
