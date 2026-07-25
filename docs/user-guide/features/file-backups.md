# File & Folder Backups

A backup job can collect **files and folders**, not only database dumps. Both can live in
the same job: one run produces one archive holding the databases and the directory trees
side by side.

## Setting one up

1. Configure the storage adapter as a **Directory Source** under **Connections → Directory
   Sources** (an adapter is either a source or a backup destination, never both - see
   [Storage Destinations](/user-guide/destinations/) for why).
2. In the job's **Sources** tab, add the directory source and pick the folders to back up.
3. Optionally attach [Exclude Pattern Presets](/user-guide/features/templates) to skip
   caches, logs or anything else you do not want stored.

## Which adapters can do what

**Every storage adapter can be a directory source.** What differs is how comfortable it is
to configure and how a restore behaves:

| Adapter | Pick folders by browsing | Restore one file without fetching the whole archive |
| :--- | :---: | :---: |
| Local Filesystem | ✅ | ✅ |
| SFTP | ✅ | ✅ |
| Rsync (SSH) | ✅ | ✅ |
| FTP / FTPS | ✅ | ✅ |
| WebDAV | ✅ | ✅ |
| Amazon S3 / S3-compatible | ✅ | ✅ |
| Google Drive | ✅ | ✅ |
| Dropbox | ✅ | ✅ |
| Microsoft OneDrive | ✅ | ✅ |
| SMB / Samba | ✅ | ❌ |

### Pick folders by browsing

Applies **while configuring a source**: DBackup queries the source server live and shows a
checkbox tree of its folders, so the path does not have to be typed from memory. Every
adapter supports it. On S3 and other object storage there are no real directories, so the
tree shows key prefixes - the same folders the provider's own console displays.

::: info This is not the file tree you see when restoring
The tree on the restore page comes from the `.index` sidecar stored next to the backup, not
from the adapter, so **it lists every file for every adapter**. Browsing a backup never
touches the machine the files came from - that machine may not even exist any more.
:::

### Restore one file without fetching the whole archive

The column that matters for large backups. It describes the adapter holding the **backup**,
not the one being restored *to*. Adapters that can serve byte ranges fetch just the bytes of
the files you picked; SMB downloads the whole archive first and takes the files out of it
afterwards. Pulling a 5 MB file out of a 200 GB backup is a handful of small requests on S3
- and a 200 GB download on SMB.

Rsync is the odd one out: rsync itself has no concept of a partial read, but this adapter
always speaks SSH, and SFTP is a subsystem of that same server - so the range is fetched
over SFTP with the credentials already configured. If the server offers no SFTP subsystem,
the restore falls back to downloading the archive once instead of failing.

SMB is the remaining gap, and it is a limitation of the client rather than the protocol:
SMB2 reads take an offset and a length, but `smbclient` - the tool this adapter drives -
exposes no way to ask for one. Nothing is lost apart from transfer volume: file-level
restore works, it just fetches the archive first.

::: tip Source and destination are judged separately
This column only matters where backups are **written**. If your NAS is the *source* of the
files, use whatever adapter fits; if it is where backups land, prefer one that can serve
byte ranges.
:::

## Choosing an adapter

Every adapter works. Which one is *pleasant* to use for a directory source comes down to two
things: how fast it moves many files, and how it behaves when something is already there.

### What decides the speed

Not bandwidth, in most cases - **per-file overhead**. A backup of 10,000 small files spends its
time opening, authenticating and closing, not transferring. That is why the protocols separate
into two groups:

- **HTTP-based** (WebDAV, S3 and S3-compatible, Google Drive, Dropbox, OneDrive) reuse one
  connection for many requests and stream a whole file per request. There is little per-file cost
  to remove, and they are usually the quickest at scale.
- **Connection-based** (SFTP, FTP, Rsync, SMB) authenticate per connection. DBackup keeps a pool
  open per run rather than reconnecting for every file, so the login count follows the configured
  parallelism instead of the file count - but the ceiling on that parallelism is lower, because
  servers limit connections.

**Local Filesystem** has no transfer at all and is only bounded by the disk.

### Parallel Transfers

Each directory source sets its own value under **Connections → Directory Sources → Configuration**.
The adapter decides the range, because the sensible limit is a property of the protocol:

| Adapter | Default | Maximum | Why the ceiling is where it is |
| :--- | :---: | :---: | :--- |
| SFTP, Rsync (SSH) | 4 | 8 | Every transfer is an SSH login, and OpenSSH refuses connections past `MaxStartups` - ten at once by default. Eight leaves room for your own session. |
| FTP / FTPS | 2 | 4 | Each transfer needs a control **and** a data connection, and servers commonly cap connections per address at around five. |
| Dropbox | 4 | 4 | Dropbox throttles concurrent writes per account. Above four the time goes into retries, so the default is also the limit. |
| Everything else | 4 | 16 | No protocol-level reason to stay lower. |

Raising it helps most when the files are small and the link has latency. It helps least when one
large file dominates - a single transfer already fills a fast link on its own.

### Behaviour worth choosing on

**Rsync restores only what differs.** Restoring to an Rsync destination compares each file against
what is already there and sends only the differing blocks, so restoring over an existing copy can
finish with almost no traffic. No other adapter does this. It is a comparison, not a skip: every
file is checked, so a file that was damaged is still repaired.

**Rsync as a *source* has no incremental advantage.** An incremental job with an Rsync source
transfers and stores everything on every run. The backup is correct, but the incremental mode
saves nothing there - use SFTP for the same server if that matters.

**SMB cannot restore a single file cheaply.** It is the one adapter without ranged reads, so
restoring one file out of a large archive fetches the archive once. See the table above.

::: info About numbers
Throughput figures depend entirely on the link, the server and the files, so this page gives none.
As one data point from a single setup - a Mac over Tailscale to a Synology NAS, 1 GB across 125
mostly-large files - SFTP and WebDAV both reached triple-digit MB/s, Rsync about half that. Your
own numbers will differ; the ranking above is the part that carries over.
:::

## What ends up in the archive

Directory backups use the seekable archive format: each file is compressed and encrypted
on its own, and an index sidecar lists every path, size, timestamp and checksum. That is
what makes browsing a backup cheap - listing a 100 GB archive reads a few megabytes - and
what makes restoring one file out of it possible.

An unencrypted archive is a plain TAR: `tar -xf backup.tar` works with no DBackup involved.
An encrypted one needs the [Recovery Kit](/user-guide/security/recovery-kit), which reads
it with nothing but Node.js. The layout is specified byte by byte in the
[Archive Format reference](/developer-guide/reference/archive-format).

## Restoring

The restore page shows a file tree per directory source. Restore everything, a single
folder, or individual files - each source with its own target:

- back to the **original location** it was collected from
- into any other configured destination
- as a **`.tar.gz` download** to your own machine

A backup that holds databases *and* files asks which half you want before opening the page.

## Incremental

Directory sources can be backed up incrementally, storing only what changed since the last
run. See [Backup Modes](/user-guide/features/backup-modes) for how chains are stored, what
forces a full backup, and how retention treats them.

::: warning Not with an Rsync source
An incremental job whose source is an Rsync connection transfers and stores everything on every
run. The backups are correct and restore normally - the incremental mode simply saves nothing
there. Use SFTP against the same server if you want real incrementals.
:::

## Shadow copies (SMB)

Backing up a live share means reading a tree that keeps changing. For shares holding
running applications, SMB sources can read from a VSS snapshot instead - see
[SMB / CIFS](/user-guide/destinations/smb).

## Next Steps

- [Backup Modes](/user-guide/features/backup-modes) - full vs incremental
- [Restore](/user-guide/features/restore) - the full restore flow
- [Recovery Kit](/user-guide/security/recovery-kit) - getting data back without DBackup
