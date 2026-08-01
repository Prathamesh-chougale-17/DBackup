/**
 * The metadata operations MongoDB needs beyond dumping and restoring.
 *
 * This exists because MongoDB is the one adapter where the two connection modes
 * genuinely cannot share an implementation: direct mode speaks the wire protocol
 * through the `mongodb` driver, while SSH mode shells out to `mongosh` on the
 * target. `mongosh` is not in the DBackup image, so direct mode cannot use it,
 * and there is no tunnel yet, so SSH mode cannot use the driver.
 *
 * Everything else about the adapter is transport-agnostic. Confining the split
 * to these methods is what keeps connection.ts, browser.ts and restore.ts free
 * of transport checks.
 */

export interface MongoDatabaseStats {
    name: string;
    sizeOnDisk: number;
    collectionCount: number;
}

export interface MongoCollectionInfo {
    name: string;
    type: string;
    estimatedCount?: number;
}

export interface MongoFindQuery {
    filter: Record<string, unknown>;
    sort?: Record<string, 1 | -1>;
    skip: number;
    limit: number;
}

export interface MongoPage {
    total: number;
    docs: Record<string, unknown>[];
}

export interface MongoMeta {
    serverVersion(): Promise<string>;
    /** User database names, with MongoDB's own databases removed. */
    listDatabaseNames(): Promise<string[]>;
    /** User databases with their size and collection count. */
    databaseStats(): Promise<MongoDatabaseStats[]>;
    listCollections(database: string): Promise<MongoCollectionInfo[]>;
    findPage(database: string, collection: string, query: MongoFindQuery): Promise<MongoPage>;
    /**
     * Verify the connection may write to a database.
     *
     * Returns null when the transport cannot probe, in which case the caller
     * proceeds and lets mongorestore report any permission problem itself.
     */
    checkWritable(database: string): Promise<void> | null;
    close(): Promise<void>;
}
