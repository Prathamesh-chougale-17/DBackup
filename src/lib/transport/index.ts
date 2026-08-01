export type {
    ExecutionHost,
    ExecOptions,
    ExecResult,
    HostKind,
    HostProcess,
    HostStat,
    PortForward,
    SpawnOptions,
    SshConnectionConfig,
    StageInputOptions,
    TempFileOptions,
    TransferOptions,
    TransportResolver,
    TransportSpec,
} from "./types";

export { createHost, withHost } from "./factory";
export {
    PREFIXED_SSH_KEYS,
    UNPREFIXED_SSH_KEYS,
    readSshConfig,
    resolveTransport,
    standardTransport,
    transportSuffix,
    type SshKeyMap,
} from "./spec";

export { BaseHost } from "./base-host";
export { DirectHost } from "./direct-host";
export { SshHost } from "./ssh-host";
export { CompositeHost, isCompositeHost } from "./composite-host";
export { shellEscape, buildRemoteCommand } from "./ssh-escape";
