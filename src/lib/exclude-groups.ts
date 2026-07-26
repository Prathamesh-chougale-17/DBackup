/**
 * Curated exclude-pattern groups, shipped as code rather than as database rows.
 *
 * A preset stores which groups it uses, not a copy of their patterns. That is the whole point:
 * extending a group in a later release reaches every preset that references it, without a
 * migration and without overwriting anything a user wrote themselves. Seeding the same lists
 * as editable rows would make them impossible to update - the moment someone edits a row, a
 * release either has to skip it or clobber their change.
 *
 * A preset may still drop individual patterns from a group (see `excludedGroupPatterns`), so
 * following a curated list never means accepting all of it.
 */
export interface ExcludeGroup {
    id: string;
    label: string;
    description: string;
    patterns: string[];
}

export const EXCLUDE_GROUPS: ExcludeGroup[] = [
    {
        id: "macos",
        label: "macOS clutter",
        description: "Finder and Spotlight metadata macOS writes into every folder it touches.",
        patterns: [".DS_Store", "._*", ".Spotlight-V100", ".Trashes", ".fseventsd", ".DocumentRevisions-V100", ".TemporaryItems"],
    },
    {
        id: "windows",
        label: "Windows clutter",
        description: "Thumbnail caches and folder settings Windows Explorer leaves behind.",
        patterns: ["Thumbs.db", "ehthumbs.db", "desktop.ini", "$RECYCLE.BIN/**", "System Volume Information/**"],
    },
    {
        id: "linux",
        label: "Linux clutter",
        description: "Desktop environment leftovers and trash folders.",
        patterns: [".directory", ".Trash-*/**", "lost+found/**"],
    },
    {
        id: "temp",
        label: "Temporary and lock files",
        description: "Editor swap files, partial downloads and lock files that are meaningless once restored.",
        patterns: ["*.tmp", "*.temp", "*.swp", "*.swo", "*~", ".~lock.*", "*.part", "*.crdownload"],
    },
    {
        id: "dev",
        label: "Development artifacts",
        description: "Dependency and build directories that are rebuilt from source, often larger than the source itself.",
        patterns: ["node_modules/**", "__pycache__/**", "*.pyc", ".venv/**", "venv/**", "target/**", "dist/**", "build/**", ".next/**", ".gradle/**"],
    },
    {
        id: "vcs",
        label: "Version control",
        description: "Repository internals. Exclude when the remote is the source of truth - restoring a partial .git is worse than none.",
        patterns: [".git/**", ".svn/**", ".hg/**"],
    },
    {
        id: "logs",
        label: "Logs and caches",
        description: "Rotating logs and cache directories that regenerate on their own.",
        patterns: ["*.log", "*.log.[0-9]*", "logs/**", "cache/**", ".cache/**"],
    },
];

/**
 * Reads one of the JSON-encoded string arrays these presets are stored as.
 *
 * Malformed or unexpected content resolves to an empty list rather than throwing: a broken
 * row must not take a backup run down, and no exclusions is the safe direction (more is
 * backed up, not less).
 */
export function parseJsonStringArray(value: string | null | undefined): string[] {
    try {
        const parsed = JSON.parse(value || "[]");
        return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
    } catch {
        return [];
    }
}

/** Looks a group up by id; unknown ids resolve to nothing rather than throwing. */
export function findExcludeGroup(id: string): ExcludeGroup | undefined {
    return EXCLUDE_GROUPS.find((g) => g.id === id);
}

/**
 * Resolves a preset into the flat pattern list the backup and restore paths apply.
 *
 * Group patterns come first, minus anything the preset opted out of, then the preset's own
 * patterns. Deduplicated, because a user's own entry may repeat one a group already covers.
 * A group id that no longer exists is skipped silently - a removed group must not break a
 * backup that still references it.
 */
export function resolveExcludePatterns(input: {
    groups?: string[];
    excludedGroupPatterns?: string[];
    patterns?: string[];
}): string[] {
    const optedOut = new Set(input.excludedGroupPatterns ?? []);
    const fromGroups = (input.groups ?? [])
        .flatMap((id) => findExcludeGroup(id)?.patterns ?? [])
        .filter((pattern) => !optedOut.has(pattern));

    return [...new Set([...fromGroups, ...(input.patterns ?? [])])];
}
