-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_JobSource" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "configId" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "path" TEXT NOT NULL,
    "excludePatterns" TEXT NOT NULL DEFAULT '[]',
    "useStagingCache" BOOLEAN NOT NULL DEFAULT false,
    "stopContainers" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "JobSource_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "JobSource_configId_fkey" FOREIGN KEY ("configId") REFERENCES "AdapterConfig" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_JobSource" ("configId", "createdAt", "excludePatterns", "id", "jobId", "path", "priority", "updatedAt", "useStagingCache") SELECT "configId", "createdAt", "excludePatterns", "id", "jobId", "path", "priority", "updatedAt", "useStagingCache" FROM "JobSource";
DROP TABLE "JobSource";
ALTER TABLE "new_JobSource" RENAME TO "JobSource";
CREATE UNIQUE INDEX "JobSource_jobId_configId_path_key" ON "JobSource"("jobId", "configId", "path");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
