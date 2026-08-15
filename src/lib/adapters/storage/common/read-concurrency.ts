/**
 * Shared `readConcurrency` value for adapters whose `read()` is stateless.
 *
 * An adapter opts in by setting `readConcurrency: STATELESS_READ_CONCURRENCY`. That is a
 * claim about the protocol, not about the destination: it says a read is a single HTTP
 * request or a local file access, with no connection dialled and no process spawned, so
 * several can be in flight without anything to exhaust.
 *
 * Adapters that do open state per read (FTP dials a control connection, SMB spawns an
 * smbclient process) deliberately declare nothing and stay serial. There the limit is the
 * server's connection count, and going wide turns a slow retention pass into a failing one.
 *
 * 8 rather than a larger number because the caller is a retention pass reading small
 * sidecars. The win is in removing the round trip latency, which is nearly all captured by
 * the first handful of parallel requests, and a modest cap keeps a destination holding
 * hundreds of backups from opening hundreds of sockets at once.
 */
export const STATELESS_READ_CONCURRENCY = 8;
