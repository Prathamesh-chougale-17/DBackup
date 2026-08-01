# Microsoft SQL Server

Configure Microsoft SQL Server databases for backup.

## Supported Versions

| Version | Notes |
| :--- | :--- |
| SQL Server 2017 | v14.x |
| SQL Server 2019 | v15.x |
| SQL Server 2022 | v16.x |
| Azure SQL Edge | Container-based |

## Architecture

Unlike other database adapters that use CLI dump tools, SQL Server backup uses:

1. **T-SQL `BACKUP DATABASE`** command
2. Native `.bak` format (full database backup)
3. File transfer to access `.bak` files (shared volume or SSH)

This means the backup file is created **on the SQL Server** first, then transferred to DBackup.

## Connection Modes

| Mode | SQL Server connection | `.bak` transfer |
| :--- | :--- | :--- |
| **Direct** | Straight to the SQL Server port | Shared volume or SSH, chosen under [File Transfer Modes](#file-transfer-modes) |
| **SSH** | Tunnelled through the SSH connection | The same SSH connection, nothing to configure |

**SSH mode** is the simpler setup and the better choice when the SQL Server port is not reachable from DBackup. DBackup opens one SSH connection to the server and sends the SQL Server protocol through it, so **port 1433 does not have to be exposed at all**. The `.bak` file travels back over that same connection, which is why SSH mode has no File Transfer settings.

Certificate validation still applies through the tunnel: DBackup validates against the hostname in the **Host** field, not against the tunnel endpoint. Encryption settings behave exactly as in direct mode.

::: tip Existing sources are unaffected
Sources created before SSH mode existed keep working exactly as they did. They stay in direct mode, and their File Transfer settings are untouched. There is nothing to migrate.
:::

SSH mode requires an `SSH_KEY` [Credential Profile](/user-guide/security/credential-profiles) and an SSH account on the SQL Server host. That account needs read and write access to the **Backup Path**, but no SQL Server privileges - the database login is still what authenticates against SQL Server.

## Configuration

::: info Credential Profiles required
Microsoft SQL Server requires a [Credential Profile](/user-guide/security/credential-profiles). Create an `USERNAME_PASSWORD` profile in **Settings → Vault → Credentials** before saving the source. SSH connection mode, and SSH file transfer mode in direct connections, additionally require an `SSH_KEY` profile.
:::

### Connection Settings

| Field | Description | Default |
| :--- | :--- | :--- |
| **Connection Mode** | `Direct` or `SSH` (see [Connection Modes](#connection-modes)) | `Direct` |
| **Host** | SQL Server hostname | `localhost` |
| **Port** | SQL Server port | `1433` |
| **Primary Credential** | `USERNAME_PASSWORD` credential profile (SQL Server login + password) | Required |
| **Database** | Database name(s) to backup | Required |

In SSH mode, **Host** and **Port** describe the SQL Server as reachable **from the SSH host**. `localhost:1433` is the usual value when SQL Server runs on that machine.

### Configuration Settings

| Field | Description | Default |
| :--- | :--- | :--- |
| **Encrypt** | Use encrypted connection | `true` |
| **Trust Server Certificate** | Trust self-signed certs | `false` |
| **Request Timeout** | Query timeout in ms | `300000` (5 min) |
| **Additional Options** | Extra BACKUP options | - |

### File Transfer Settings

These apply to **direct** connection mode only. In SSH mode the `.bak` file travels over the SSH connection and none of these fields are shown.

| Field | Description | Default |
| :--- | :--- | :--- |
| **Backup Path (Server)** | Server-side backup directory | `/var/opt/mssql/backup` |
| **File Transfer Mode** | How to access .bak files | `local` |
| **Local Backup Path** | Host-side mounted path (local mode) | `/tmp` |
| **SSH Host** | SSH host (SSH mode, defaults to DB host) | - |
| **SSH Port** | SSH port (SSH mode) | `22` |
| **SSH Credential** | `SSH_KEY` credential profile for file transfer (SSH mode) | - |

## File Transfer Modes

::: info Direct connection mode only
These modes describe how a **direct** connection reaches the `.bak` file. In SSH connection mode the file comes back over the SSH connection already, so there is nothing to choose here. See [Connection Modes](#connection-modes).
:::

DBackup supports two modes to access the `.bak` files that SQL Server creates on its filesystem.

### Local File Transfer (Shared Volume)

Use this when DBackup and SQL Server share a filesystem - typically via Docker volume mounts or NFS shares.

```yaml
services:
  dbackup:
    volumes:
      - ./mssql-backups:/mssql-backups
    # Configure in source:
    # - Backup Path (Server): /var/opt/mssql/backup
    # - File Transfer Mode: local
    # - Local Backup Path: /mssql-backups

  mssql:
    image: mcr.microsoft.com/mssql/server:2022-latest
    volumes:
      - ./mssql-backups:/var/opt/mssql/backup
```

#### How It Works

1. DBackup sends `BACKUP DATABASE` command to SQL Server
2. SQL Server writes `.bak` file to `/var/opt/mssql/backup`
3. DBackup reads the file from `/mssql-backups` (same volume)
4. DBackup processes (compress/encrypt) and uploads to destination
5. Cleanup: Original `.bak` file is deleted

### SSH File Transfer (Remote Server)

Use this when SQL Server runs on a remote host (bare-metal, VM, or remote Docker) and there is no shared filesystem. DBackup connects via SSH/SFTP to download/upload `.bak` files.

#### Setup

1. Set **File Transfer Mode** to `SSH`
2. Select an `SSH_KEY` credential profile in the **SSH Credential** picker
3. Set **Backup Path (Server)** to the directory on the SQL Server host (e.g., `/var/opt/mssql/backup`)
4. Ensure the SSH user has read/write access to the backup path

::: tip SSH Host Default
If **SSH Host** is left empty, DBackup uses the same hostname as the database connection. This is the most common setup since SSH and SQL Server usually run on the same machine.
:::

::: warning Backup Path is shared between SQL Server and SSH
The **Backup Path (Server)** is used for both the `BACKUP DATABASE` T-SQL command **and** the SSH/SFTP file transfer. This means:
- SQL Server must be able to **write** to this path
- The SSH user must be able to **read and delete** files in this path
- Both must reference the **same physical directory** on disk

If SQL Server runs in **Docker**, the default path `/var/opt/mssql/backup` only exists inside the container. Use a volume-mounted path that is **identical on both the host and inside the container** (e.g., `/data/mssql-backups`), so SSH can reach the same files:

```yaml
services:
  mssql:
    volumes:
      - /data/mssql-backups:/data/mssql-backups
```

Then set **Backup Path (Server)** to `/data/mssql-backups`.

If SQL Server is installed **directly on the host** (bare-metal/VM), you can use the default path `/var/opt/mssql/backup` since SSH has direct access to the host filesystem.
:::

#### How It Works (Backup)

1. DBackup sends `BACKUP DATABASE` command to SQL Server
2. SQL Server writes `.bak` file to the backup path on its filesystem
3. DBackup connects via SSH/SFTP and downloads the `.bak` file
4. DBackup processes (compress/encrypt) and uploads to destination
5. Cleanup: Remote `.bak` file is deleted via SSH

#### How It Works (Restore)

1. DBackup downloads the backup from storage
2. DBackup connects via SSH/SFTP and uploads the `.bak` file to the backup path
3. DBackup sends `RESTORE DATABASE` command to SQL Server
4. SQL Server reads the `.bak` file from the backup path
5. Cleanup: Remote `.bak` file is deleted via SSH

#### SSH Authentication

| Method | Description |
| :--- | :--- |
| **Password** | Simple username/password authentication |
| **Private Key** | PEM-format private key (optionally with passphrase) |
| **Agent** | Uses the system SSH agent (`SSH_AUTH_SOCK`) |

## Setting Up a Backup User

Create a dedicated login with backup permissions:

```sql
-- Create login
CREATE LOGIN dbackup WITH PASSWORD = 'secure_password_here';

-- Create user in master
USE master;
CREATE USER dbackup FOR LOGIN dbackup;

-- Grant backup permissions
ALTER SERVER ROLE [db_backupoperator] ADD MEMBER dbackup;

-- Or grant on specific databases:
USE mydb;
CREATE USER dbackup FOR LOGIN dbackup;
ALTER ROLE [db_backupoperator] ADD MEMBER dbackup;
```

For restore operations:
```sql
ALTER SERVER ROLE [dbcreator] ADD MEMBER dbackup;
```

## Backup Process

DBackup executes:

```sql
BACKUP DATABASE [MyDatabase]
TO DISK = '/var/opt/mssql/backup/backup_20240115_120000.bak'
WITH FORMAT, INIT, COMPRESSION
```

### Backup Options

Add custom options in "Additional Options":

```sql
-- With checksum verification
CHECKSUM

-- With differential backup
DIFFERENTIAL

-- Copy-only (doesn't break log chain)
COPY_ONLY

-- Custom description
DESCRIPTION = 'Daily backup'
```

## Connection Security

### Encrypted Connection (Recommended)

Enable **Encrypt** option for production:
- Requires valid SSL certificate on SQL Server
- Or enable **Trust Server Certificate** for self-signed

### Azure SQL

For Azure SQL Database:
1. Enable **Encrypt**
2. Keep **Trust Server Certificate** disabled
3. Use Azure AD authentication if needed

## Troubleshooting

### Connection Timeout

```
Login failed. The login is from an untrusted domain
```

**Solutions**:
1. Increase **Request Timeout** for large databases
2. Check network latency
3. Verify SQL Server is accessible

### Backup Permission Denied

```
Cannot open backup device. Operating system error 5 (Access denied)
```

This error occurs when the **SQL Server service account** (typically `mssql`) cannot write to the backup directory.

**Solutions**:
1. Ensure the `mssql` user has write access to the backup path:
   ```bash
   sudo chown mssql:mssql /path/to/backup-dir
   sudo chmod 770 /path/to/backup-dir
   ```
2. **Docker**: Verify the volume mount exists and the container user has write permissions
3. Verify the backup directory exists on the SQL Server - it is **not** created automatically

### File Not Found After Backup (Local Mode)

```
Backup completed but file not found
```

**Solutions**:
1. Verify shared volume is mounted correctly
2. Check **Backup Path (Server)** matches SQL Server mount
3. Check **Local Backup Path** matches DBackup mount
4. Verify paths are absolute

### SSH Connection Failed (SSH Mode)

```
SSH connection failed: Authentication failed
```

**Solutions**:
1. Verify SSH credentials (username, password, or key)
2. Check that the SSH host and port are correct
3. Ensure the SSH service is running on the SQL Server host
4. For private key auth, verify the key is in PEM format
5. Check firewall rules allow SSH connections (port 22)

### SSH File Transfer Failed - Permission Denied (SSH Mode)

```
Failed to download /path/to/backup.bak: Permission denied
```

This is the most common SSH mode issue. The backup **succeeds** (SQL Server writes the `.bak` file), but the SSH/SFTP download **fails** because the SSH user cannot read the file.

**Why this happens:** SQL Server runs as the `mssql` service account and creates `.bak` files with restrictive permissions (typically `640`, owner `mssql:mssql`). Even if the backup directory has `777` permissions, the **file itself** is owned by `mssql` with limited access - your SSH user cannot read it.

**Solution 1 - Add SSH user to the `mssql` group** (recommended):
```bash
sudo usermod -aG mssql your-ssh-user
```
Log out and back in (or run `newgrp mssql`) for the change to take effect.

**Solution 2 - Set default ACL on the backup directory:**
```bash
sudo setfacl -d -m u:your-ssh-user:rwx /path/to/backup-dir
sudo setfacl -m u:your-ssh-user:rwx /path/to/backup-dir
```
This ensures every new file created in the directory is automatically readable by your SSH user.

**Solution 3 - Change SQL Server's default file permissions:**
```bash
sudo systemctl edit mssql-server
```
Add:
```ini
[Service]
UMask=0022
```
Then restart: `sudo systemctl restart mssql-server`. SQL Server will now create files with `644` permissions (world-readable).

::: tip
Solution 1 is the quickest and least invasive fix. Solutions 2 and 3 are alternatives if you cannot modify group membership.
:::

### SSL Certificate Error

```
The certificate chain was issued by an authority that is not trusted
```

**Solutions**:
1. Enable **Trust Server Certificate** (development only)
2. Install valid SSL certificate on SQL Server
3. Add CA certificate to DBackup container

## Azure SQL Edge (Docker)

For containerized development:

```yaml
services:
  mssql:
    image: mcr.microsoft.com/azure-sql-edge:latest
    environment:
      - ACCEPT_EULA=Y
      - SA_PASSWORD=YourStrong@Password123
    ports:
      - "1433:1433"
    volumes:
      - ./mssql-backups:/var/opt/mssql/backup
```

Configure source:
- **Host**: `mssql` (service name) or `host.docker.internal`
- **User**: `sa`
- **Encrypt**: `false`
- **Trust Server Certificate**: `true`

## Restore

To restore a SQL Server backup:

1. Go to **Storage Explorer**
2. Find your `.bak` backup file
3. Click **Restore**
4. Select target database configuration
5. Choose:
   - Restore to same database (overwrite)
   - Restore to new database name
6. Confirm and monitor progress

### Restore Process

The restore process depends on the configured **File Transfer Mode**:

**Local mode:**
1. Copy `.bak` file to shared volume (Local Backup Path)
2. Execute `RESTORE DATABASE` command
3. Verify restore integrity
4. Cleanup temporary files

**SSH mode:**
1. Upload `.bak` file to server via SFTP (Backup Path)
2. Execute `RESTORE DATABASE` command
3. Verify restore integrity
4. Cleanup: Delete remote `.bak` file via SSH

## Best Practices

1. **Use SSH mode** for remote SQL Servers without shared filesystem access
2. **Use shared volumes** with proper permissions for Docker setups
3. **Enable COMPRESSION** in backup options (reduces size 60-80%)
4. **Use CHECKSUM** for integrity verification
5. **Test restores** regularly
6. **Monitor backup duration** and adjust timeout
7. **Use encrypted connections** in production
8. **Separate backup user** from application user
9. **Enable Trust Server Certificate** only in development - use valid certs in production
