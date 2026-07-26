import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { getAuthContext, checkPermissionWithContext } from "@/lib/auth/access-control";
import { PERMISSIONS } from "@/lib/auth/permissions";
import * as encryptionService from "@/services/backup/encryption-service";
import AdmZip from "adm-zip";
import fs from "fs/promises";
import path from "path";
import { auditService } from "@/services/audit-service";
import { AUDIT_ACTIONS, AUDIT_RESOURCES } from "@/lib/core/audit-types";
import { logger } from "@/lib/logging/logger";
import { wrapError } from "@/lib/logging/errors";

const log = logger.child({ route: "vault/recovery-kit" });

/** The single standalone tool shipped in the kit. Lives in scripts/ and is tested there. */
const RECOVERY_TOOL = "dbackup-recover.js";

/**
 * Unix mode 0755 in the place a zip keeps it: the high 16 bits of the external attributes,
 * with the regular-file bit set. Without this every extracted launcher lands unexecutable
 * and has to be chmod-ed by hand, which is exactly the friction the launchers exist to
 * remove.
 */
const EXECUTABLE_ATTR = (0o100755 << 16) >>> 0;

/**
 * Starts the tool from wherever the kit was unpacked.
 *
 * `cd` first, because a double-click on macOS opens Terminal in the home directory, and the
 * tool looks for master.key and for backups next to itself.
 */
function unixLauncher(): string {
    return `#!/bin/sh
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
    echo "Node.js is required but was not found."
    echo "Install it from https://nodejs.org/ (version 18 or newer), then run this again."
    printf "Press Enter to close..."
    read -r _
    exit 1
fi

node ${RECOVERY_TOOL}

printf "\\nPress Enter to close..."
read -r _
`;
}

function windowsLauncher(): string {
    return `@echo off
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo Node.js is required but was not found.
    echo Install it from https://nodejs.org/ ^(version 18 or newer^), then run this again.
    pause
    exit /b 1
)

node ${RECOVERY_TOOL}

pause
`;
}

function readme(profileName: string): string {
    return `# Recovery Kit for Profile: ${profileName}
Generated at: ${new Date().toISOString()}

This kit restores your backups WITHOUT DBackup. Keep it somewhere safe, and NOT next to
your backups - it contains the key that opens them.

## HOW TO USE IT

1. Copy the backup next to these files. If the backup is a FOLDER (an incremental chain),
   copy the whole folder.
2. Start the tool:

     Windows      double-click START-Windows.bat
     macOS        double-click START-macOS.command
     Linux        ./START-Linux.sh      (or: node ${RECOVERY_TOOL})

3. It shows what it found and asks what to do with it. That is all.

You do not need to know which kind of backup you have, and you do not need to type the
key anywhere: the tool reads master.key from this folder by itself.

## PREREQUISITES

Node.js 18 or newer, from https://nodejs.org/
Nothing else - no npm install, no DBackup server, no database.

## CONTENTS

  master.key            Your raw 64-character key. Anyone holding it can read your backups.
  ${RECOVERY_TOOL}   The recovery tool. Reads every backup format DBackup writes.
  START-Windows.bat     Double-click launcher for Windows.
  START-macOS.command   Double-click launcher for macOS.
  START-Linux.sh        Launcher for Linux.
  README.txt            This file.

## INCREMENTAL BACKUPS

A job with incremental backups stores each chain in its own folder:

    MyJob/chain-2026-07-24T03-00-00-000/
        ..._full-000.tar     the full backup the chain is built on
        ..._inc-001.tar      what changed after it
        ..._inc-002.tar      what changed after that

Copy that whole folder. The tool picks the newest snapshot on its own and rebuilds the
current state from all of them, every file at its latest version. Pick "an older state" in
the menu to go back to an earlier point instead.

If an archive of the chain is missing, the tool names it and stops rather than writing an
incomplete restore.

## COMMAND LINE

The same tool, for scripting or over SSH:

    node ${RECOVERY_TOOL} --list    <archive or folder>
    node ${RECOVERY_TOOL} --extract <archive or folder> <output_dir> [pattern...]
    node ${RECOVERY_TOOL} --decrypt <backup.enc> [output_file]

Patterns accept * and **, and naming a folder takes everything inside it:

    node ${RECOVERY_TOOL} --extract backup.tar ./restored 'www/**'
    node ${RECOVERY_TOOL} --extract backup.tar ./restored docs

Every extracted file is checked against the checksum recorded when the backup was made.
A key can be passed as an extra argument if master.key is not in this folder.

## WITHOUT THIS KIT AT ALL

An UNENCRYPTED file backup is a plain TAR:

    tar -xf backup.tar

If the job used compression, the extracted files are gzip or brotli streams - run 'gunzip'
or 'brotli -d' on them afterwards. Encrypted backups always need this kit.
`;
}

export async function GET(
    request: NextRequest,
    props: { params: Promise<{ id: string }> }
) {
    const params = await props.params;
    const { id } = params;

    // 1. Auth & Permissions
    const headersList = await headers();
    const ctx = await getAuthContext(headersList);
    if (!ctx) {
        return new NextResponse("Unauthorized", { status: 401 });
    }

    // Security: Require VAULT.WRITE for master key export (sensitive operation)
    checkPermissionWithContext(ctx, PERMISSIONS.VAULT.WRITE);

    // Audit log: Track master key export
    await auditService.log(
        ctx.userId,
        AUDIT_ACTIONS.EXPORT,
        AUDIT_RESOURCES.VAULT,
        { action: 'recovery_kit_download', profileId: id },
        id
    );

    try {
        // 2. Fetch Profile & Key
        const profile = await encryptionService.getEncryptionProfile(id);
        if (!profile) {
            return new NextResponse("Profile not found", { status: 404 });
        }

        const masterKeyHex = await encryptionService.getDecryptedMasterKey(id);

        // 3. Prepare Files
        const zip = new AdmZip();

        // A. Master Key File
        //
        // The tool reads this itself, which is why no launcher below carries the key: a key
        // passed as an argument shows up in shell history and in the process list.
        zip.addFile("master.key", Buffer.from(masterKeyHex, "utf8"));

        // B. The recovery tool
        //
        // One file, deliberately. It is unzipped into a strange folder in the worst week of
        // someone's year, and anything that can be separated from it by a careless copy
        // eventually will be. It recognises every backup format DBackup writes, so nobody
        // has to work out which one they are holding before they can start.
        try {
            const toolContent = await fs.readFile(path.join(process.cwd(), "scripts", RECOVERY_TOOL), "utf8");
            zip.addFile(RECOVERY_TOOL, Buffer.from(toolContent, "utf8"), "", EXECUTABLE_ATTR);
        } catch (e: unknown) {
            log.error("Failed to read the recovery tool", { script: RECOVERY_TOOL }, wrapError(e));
            zip.addFile(
                `ERROR_MISSING_${RECOVERY_TOOL}.txt`,
                Buffer.from(`Could not find scripts/${RECOVERY_TOOL} on server.`, "utf8")
            );
        }

        // C. Launchers, one per platform, so the tool can be started by double-clicking it.
        //
        // Each one only starts the tool - it then asks what to do. None of them takes an
        // argument, and none of them carries the key.
        zip.addFile("START-Windows.bat", Buffer.from(windowsLauncher(), "utf8"));
        // A .command file is what macOS opens in Terminal on a double-click. Both need the
        // executable bit, which the zip carries in its external attributes - without it the
        // Linux launcher is only runnable via `bash START-Linux.sh`.
        zip.addFile("START-macOS.command", Buffer.from(unixLauncher(), "utf8"), "", EXECUTABLE_ATTR);
        zip.addFile("START-Linux.sh", Buffer.from(unixLauncher(), "utf8"), "", EXECUTABLE_ATTR);

        // D. README
        zip.addFile("README.txt", Buffer.from(readme(profile.name), "utf8"));

        // 4. Generate & Send
        const zipBuffer = zip.toBuffer();

        const sanitizedName = profile.name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        const filename = `recovery_kit_${sanitizedName}.zip`;

        return new NextResponse(zipBuffer as any, {
            status: 200,
            headers: {
                "Content-Type": "application/zip",
                "Content-Disposition": `attachment; filename="${filename}"`
            }
        });

    } catch (error: unknown) {
        log.error("Recovery kit generation error", { profileId: id }, wrapError(error));
        return new NextResponse("Internal Server Error", { status: 500 });
    }
}
