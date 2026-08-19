import { z } from "zod";

export const MONGODB_BACKUP_SCOPE_VALUES = ["SELECTED_DATABASES", "FULL_INSTANCE"] as const;

export const MongoDBBackupScopeSchema = z.enum(MONGODB_BACKUP_SCOPE_VALUES);

export type MongoDBBackupScope = z.infer<typeof MongoDBBackupScopeSchema>;
