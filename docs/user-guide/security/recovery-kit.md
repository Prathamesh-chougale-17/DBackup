# Recovery Kit

Emergency decryption tool for encrypted backups.

## Overview

A Recovery Kit is a standalone package that lets you decrypt backups **without access to DBackup**. It's essential for disaster recovery scenarios.

## What's Included

Each Recovery Kit contains:

```
recovery-kit/
├── README.txt              # Instructions
├── master.key              # Your encryption key (64 hex characters)
├── dbackup-recover.js      # The recovery tool
├── START-Windows.bat       # Double-click launcher
├── START-macOS.command     # Double-click launcher
└── START-Linux.sh          # Launcher
```

One tool handles every backup format DBackup writes - database dumps, file backups and
incremental chains, encrypted or not. It works out which one it is looking at, so you do
not have to, and everything it restores lands in a `restored` folder ready to use.

It streams every entry it extracts, so a backup containing a 50 GB VM image needs no more
memory than one containing text files - which matters precisely when you are recovering
onto whatever machine happens to be available. Files are written to a temporary name and
only put in place once their authentication tag and recorded checksum both verify, so a
damaged archive never leaves something that looks like a recovered file.

## Why You Need It

### Disaster Scenarios

- DBackup server destroyed
- Database corrupted
- Lost access to application
- `ENCRYPTION_KEY` lost
- Need offline access

### Without Recovery Kit

❌ Cannot decrypt backups
❌ Data potentially lost forever
❌ No way to recover encryption key

### With Recovery Kit

✅ Decrypt backups anywhere
✅ Only need Node.js
✅ Works offline
✅ Independent of DBackup

## Downloading a Recovery Kit

1. Go to **Settings** → **Vault**
2. Click on an encryption profile
3. Click **Download Recovery Kit**
4. Save the zip file securely

::: danger Store Securely
The Recovery Kit contains your encryption key! Store it:
- In a password manager
- On encrypted storage
- In a secure physical location
- **NOT** in the same place as backups
:::

## Using the Recovery Kit

The only prerequisite is [Node.js 18 or newer](https://nodejs.org/). No `npm install`, no
DBackup server, no database.

1. Unzip the Recovery Kit.
2. Copy the backup next to the unzipped files. If the backup is a **folder** - which is how
   an incremental chain is stored - copy the whole folder.
3. Start the tool:

   | System | How |
   | :--- | :--- |
   | Windows | Double-click `START-Windows.bat` |
   | macOS | Double-click `START-macOS.command` |
   | Linux | `./START-Linux.sh`, or `node dbackup-recover.js` |

4. It shows what it found and asks what to do with it:

```
  DBackup Recovery
  Key loaded from master.key

  Found 2 backup(s):

 > chain-2026-07-25T20-10-37-652   25.07.2026 20:11  1.0 GB  encrypted  incremental chain, 2 archive(s)
   MyDb_2026-07-20.sql.gz.enc      20.07.2026 03:00  348 MB  encrypted
   Quit
```

Choosing a backup offers restoring everything, looking inside first, picking an older state
of a chain, or pulling out only certain files.

You never have to type the key: the tool reads `master.key` from its own folder. If the key
is somewhere else, it asks for it.

::: tip macOS may refuse to open the launcher
`START-macOS.command` is downloaded from the internet, so Gatekeeper blocks the first
double-click. Right-click it and choose **Open**, or run `node dbackup-recover.js` in
Terminal instead.
:::

## Command line

The same tool, for scripting or over SSH. Every mode accepts a folder wherever it accepts
an archive.

```bash
node dbackup-recover.js --list    <archive or folder>
node dbackup-recover.js --extract <archive or folder> <output_dir> [pattern...]
node dbackup-recover.js --decrypt <backup.enc> [output_dir]
```

Everything lands in `./restored` unless another folder is named.

`--list` prints the databases, the directory sources, and every file with its size and
modification time. For an incremental snapshot it also names every archive the snapshot
needs and marks any that are missing, so a gap is visible before you start extracting.

`--extract` patterns accept `*` and `**`, and naming a folder selects everything inside it:

```bash
node dbackup-recover.js --extract backup.tar ./restored 'www/**'
node dbackup-recover.js --extract backup.tar ./restored docs
```

Every extracted file is verified against the checksum recorded when the backup was made. A
mismatch is reported and the command exits non-zero.

`--decrypt` handles a database backup encrypted as a single file. It decompresses in the
same pass, and a backup holding several databases is unpacked into one dump per database -
the output is always ready to feed to `mysql`, `psql` or `mongorestore`, never a `.gz` or a
`.tar` to take apart first.

The key is read from `master.key` next to the tool. Pass it as an extra argument to override,
or leave it out entirely for unencrypted backups.

## Incremental chains

An incremental backup is stored as a chain in one folder: one full backup plus the changes
made after it.

```
MyJob/chain-2026-07-24T03-00-00-000/
    ..._full-000.tar     the full backup the chain is built on
    ..._inc-001.tar      what changed after it
    ..._inc-002.tar      what changed after that
```

**Copy the whole folder and point the tool at it.** It picks the newest snapshot on its own
and rebuilds the current state from all of them, every file at its latest version, merged
into a single output folder. There is no separate step to replay the chain.

```bash
node dbackup-recover.js --extract ./chain-2026-07-24T03-00-00-000 ./restored
```

To recover an older state, choose "Pick an older state" in the wizard, or name that archive
directly - each one rebuilds the snapshot as it was at its own point in time.

Keep the archives of a chain together in one folder; that is how they find each other. A
missing archive aborts the extract by name instead of writing an incomplete restore.

::: tip Unencrypted archives need no kit at all
If the job had no encryption profile, the archive is a plain TAR:

```bash
tar -xf backup.tar
# If the job used compression, the extracted files are gzip streams:
find . -name '*.gz' -exec gunzip {} +
```

Encrypted archives always require this kit, because each file inside is individually
encrypted.
:::

## How It Works

### Decryption Process

```javascript
// 1. Read metadata
const meta = JSON.parse(fs.readFileSync(file + '.meta.json'));

// 2. Extract encryption parameters
const { iv, authTag, profileId } = meta.encryption;

// 3. Create decipher
const decipher = crypto.createDecipheriv(
  'aes-256-gcm',
  Buffer.from(KEY, 'hex'),
  Buffer.from(iv, 'hex')
);
decipher.setAuthTag(Buffer.from(authTag, 'hex'));

// 4. Decrypt file
fs.createReadStream(encryptedFile)
  .pipe(decipher)
  .pipe(fs.createWriteStream(outputFile));
```

### Required Metadata

The `.meta.json` file must contain:

```json
{
  "encryption": {
    "enabled": true,
    "iv": "hex-encoded-initialization-vector",
    "authTag": "hex-encoded-authentication-tag"
  },
  "compression": "GZIP"
}
```

## Best Practices

### Storage Recommendations

| Location | Security | Accessibility |
| :--- | :--- | :--- |
| Password Manager | ✅ High | ✅ Easy |
| Encrypted USB | ✅ High | ⚡ Medium |
| Bank Safe Deposit | ✅ Very High | ❌ Difficult |
| Printed (sealed) | ✅ High | ❌ Manual entry |

### Multiple Copies

Store Recovery Kit in:
1. Primary: Password manager (Bitwarden, 1Password)
2. Secondary: Encrypted USB at home
3. Tertiary: Sealed envelope at trusted location

### Test Regularly

1. Download fresh Recovery Kit quarterly
2. Test decryption with recent backup
3. Verify key matches current profile

### Update After Key Rotation

When creating new encryption profile:
1. Download new Recovery Kit
2. Update all storage locations
3. Keep old kit until old backups expire

## Troubleshooting

### "Invalid key length"

**Cause**: Key is not 64 hex characters

**Solution**: Verify `master.key` contains exactly 64 characters and nothing else

### "Unable to authenticate data"

**Cause**: Wrong key or corrupted file

**Solutions**:
1. Verify correct Recovery Kit for this backup
2. Check `.meta.json` matches the `.enc` file
3. Re-download backup file

### "Metadata file not found"

**Cause**: Missing `.meta.json`

**Solution**:
- Download both files from storage
- They must be in same directory

### "Unsupported Node.js version"

**Cause**: Old Node.js

**Solution**: Update to Node.js 18+

## Creating Custom Decryption

If you need to decrypt in another language:

### Python Example

```python
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
import json

# Read key
key = bytes.fromhex(open('master.key').read().strip())

# Read metadata
meta = json.load(open('backup.sql.gz.enc.meta.json'))
iv = bytes.fromhex(meta['encryption']['iv'])
tag = bytes.fromhex(meta['encryption']['authTag'])

# Read encrypted data
encrypted = open('backup.sql.gz.enc', 'rb').read()

# Decrypt
aesgcm = AESGCM(key)
decrypted = aesgcm.decrypt(iv, encrypted + tag, None)

# Write output
open('backup.sql.gz', 'wb').write(decrypted)
```

### OpenSSL (Command Line)

```bash
# Note: OpenSSL GCM support varies
openssl enc -d -aes-256-gcm \
  -K $(cat master.key) \
  -iv $(cat meta.json | jq -r '.encryption.iv') \
  -in backup.sql.gz.enc \
  -out backup.sql.gz
```

## Emergency Checklist

When you need to use Recovery Kit:

- [ ] Locate Recovery Kit
- [ ] Download backup files (.enc + .meta.json)
- [ ] Install Node.js if needed
- [ ] Unzip the Recovery Kit
- [ ] Copy the backup (or its whole folder) next to it
- [ ] Start the launcher for your system and follow the prompts
- [ ] Verify the restored files
- [ ] Restore to database

## Next Steps

- [Encryption Vault](/user-guide/security/encryption) - Manage encryption profiles
- [Restore](/user-guide/features/restore) - Normal restore process
- [System Backup](/user-guide/features/system-backup) - Backup DBackup itself
