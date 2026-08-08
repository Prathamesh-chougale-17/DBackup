# Docker Volumes

Back up the contents of Docker volumes, on the machine DBackup runs on or on another host over SSH.

A database inside a container can be dumped through its own source adapter. Everything beside it - configuration, uploaded files, plugin state, certificates - lives in volumes that nothing else can reach. This adapter reads those directly, without needing them to have been set up as bind mounts.

::: warning Beta
Directory permissions and ownership are not yet restored, and empty directories are not preserved. See [Known limitations](#known-limitations) before relying on this for a database volume.
:::

## Prerequisites

- Access to the Docker daemon socket, either locally or on a host reachable over SSH.
- A small image on the Docker host to mount the volumes into, `alpine:latest` by default. DBackup pulls it once if it is not already there.

When DBackup itself runs in a container, the socket has to be mounted into it:

```yaml
services:
  dbackup:
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
```

::: info What socket access means
A process that can talk to the Docker socket can start containers, and a container can be given access to the whole host. Mount it only if you are comfortable with DBackup having that reach. Connecting over SSH instead does not change this - it moves the same access to the other machine.
:::

## Configuration

| Field | Description | Default | Required |
| :--- | :--- | :--- | :--- |
| **Role** | Fixed to Directory Source. A container runtime is somewhere to read data out of, never somewhere to write backups to. | `Directory Source` | - |
| **Connection Mode** | `Direct` for the host DBackup runs on, `SSH` for another machine | `Direct` | ✅ |
| **SSH Host / Port** | The machine running Docker (SSH mode only) | `22` | SSH only |
| **SSH Credential** | `SSH_KEY` [credential profile](/user-guide/security/credential-profiles) | - | SSH only |
| **Docker socket path** | Path to the daemon socket, as seen from the host DBackup connects to. Leave empty for the default | `/var/run/docker.sock` | ❌ |
| **Helper image** | Under **Advanced**. Image the volumes are mounted into. Needs a shell, and is never started during a backup. Leave empty for the default | `alpine:latest` | ❌ |

## Setup Guide

1. Go to **Connections** → **Directory Sources** → **Add New** and pick **Docker Volumes**. It is offered here only - a container runtime cannot be a backup destination.
2. Choose a **Connection Mode**. The rest of the form appears once you have, because the two modes ask for different things.
3. For **SSH**, pick an `SSH_KEY` credential profile and enter the host. For **Direct**, leave the socket path empty unless it is somewhere unusual.
4. Click **Test Connection**. It reports the Docker version and how many volumes it can see.
5. Save, then open or create a job.
6. Under **Directory Sources**, pick this adapter and click the volume button. It lists the volumes on that host - tick the ones to back up, or use **Every volume on this host** to tick them all. Each ticked volume becomes its own row with its own settings, and a volume created later is not swept in automatically.
7. Optionally expand a source row to set **Stop containers while reading** and exclude patterns.

## How It Works

A volume cannot be read from outside a container, so DBackup mounts the ones it needs into a temporary container and reads them from there. That container is never started for the backup itself, so the helper image only has to exist.

**Volumes are grouped by the containers holding them.** If two volumes belong to the same container, it is stopped once rather than twice, and it is started again as soon as both are read - it does not wait for the rest of the job. A volume shared by two containers stops both. This is why a job with several volumes may interrupt different services at different times rather than all at once.

**Stopping is per source and optional.** With it off, the volume is read while it is being written to, which makes the backup exactly as consistent as one taken during a power cut - fine for uploads or static files, not for a database.

**If a run is killed** while containers are down - the process is force-terminated, the machine reboots - the next run finds what it left behind and starts them again, and says which containers those were. That state is written onto the Docker host itself rather than kept in memory, which is what makes the recovery possible at all.

**The run history shows all of it**: which containers were stopped and started again, which helper container the volume was read through and from which image, and - when a source is set not to stop its containers - that the resulting backup is crash-consistent rather than clean.

Permissions, owners and symbolic links inside a volume are carried into the backup and put back on restore.

## Restoring

Restore a volume from **Storage** → the backup file → **Restore**, choosing this adapter as the target and entering a volume name.

- **Same name**: the volume is **emptied completely** before the backup is written into it, so the result is the backup's state and not a mixture of two. The restore screen marks an existing volume as `Exists` and says so.
- **New name**: the volume is created.

Containers using the target are always stopped for a restore, whatever the job's own setting says, and started again afterwards.

## Known limitations

| Limitation | Effect |
| :--- | :--- |
| Directory permissions and ownership are not restored | A restored directory is owned by root with default permissions. A PostgreSQL data directory restored this way will not start until its ownership and mode are corrected by hand. |
| Empty directories are not preserved | A directory containing no files is missing after a restore. |
| Extended attributes and ACLs are not preserved | On SELinux hosts, labels have to be reapplied with `restorecon` after a restore. |
| Hard links, device nodes and sockets are not backed up | They are reported as failures in the run, so the backup is honestly incomplete rather than quietly so. |
| Incremental backups save storage but not transfer | The volume arrives as one stream, so unchanged files still travel; they are simply not stored again. |

## Troubleshooting

### The socket was not found

```
connect ENOENT /var/run/docker.sock. The Docker socket was not found.
```

**Solution:** DBackup is running in a container without the socket mounted. Add the volume mount shown under [Prerequisites](#prerequisites) and restart. On a host where Docker runs rootless, the socket is usually at `$XDG_RUNTIME_DIR/docker.sock` instead - set **Docker socket path** accordingly.

### The socket is not readable

```
connect EACCES /var/run/docker.sock. The Docker socket exists but is not readable
by the user DBackup runs as.
```

**Solution:** The socket is owned by the `docker` group. Either run the DBackup container with that group, or adjust the socket's permissions on the host.

### The helper image cannot be created

```
Could not create the helper container from image 'alpine:latest': No such image
```

**Solution:** The Docker host has no copy of the image and could not pull one. Either pull it once on that host, or point **Helper image** at an image that is already there - during a backup it is never started, so almost any image will do.

### Forwarding was refused over SSH

```
ssh://user@host:22 would not forward the socket /var/run/docker.sock.
This needs OpenSSH 6.7 or newer with AllowStreamLocalForwarding enabled.
```

**Solution:** The SSH server refuses to forward Unix sockets. Set `AllowStreamLocalForwarding yes` in `sshd_config` and reload sshd.

### Progress shows a count without a total

Reading a volume normally reports `12/2043 files`. When the helper image cannot be started - it has no shell, for instance - the file count cannot be taken beforehand and progress shows a running count instead. The backup itself is unaffected.

## Next Steps

- [Creating Jobs](/user-guide/jobs/) - schedule the volume backup
- [Encryption Vault](/user-guide/security/encryption) - encrypt the archive at rest
- [Restore](/user-guide/features/restore) - the general restore flow
