import { withHost } from '@/lib/transport';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { registry } from '@/lib/core/registry';
import { registerAdapters } from '@/lib/adapters';
import { DatabaseAdapter } from '@/lib/core/interfaces';
import { sshTestDatabases, sshHostAvailable, sshRestoreUnsupported } from './test-configs';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * SSH mode against a real sshd.
 *
 * Until the transport extraction, SSH mode had no automated coverage at all -
 * the integration suite was direct-only and the only SSH environment was a
 * hand-started Multipass VM. These tests run every adapter operation against
 * the `ssh-host` container, whose sshd, key exchange, channel limits and
 * SFTP subsystem are the real thing rather than a mock.
 *
 * Each source addresses its database by compose service name, which resolves
 * only inside that container. A passing test therefore proves the command ran
 * on the remote host: had it silently fallen back to direct mode, the hostname
 * would not resolve.
 */
describe('Integration Tests: SSH Mode', () => {
    const tempDir = path.join(os.tmpdir(), 'dbm-integration-ssh');

    beforeAll(() => {
        registerAdapters();
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }
    });

    afterAll(() => {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    sshTestDatabases.forEach(({ name, config }) => {
        const skip = !sshHostAvailable;
        const slug = name.replace(/\s+/g, '_');

        function adapterFor(): DatabaseAdapter {
            const adapter = registry.get(config.type) as DatabaseAdapter;
            if (!adapter) throw new Error(`Adapter ${config.type} not found`);
            return adapter;
        }

        describe(name, () => {
            it.skipIf(skip)('connects and reports a version', async () => {
                const adapter = adapterFor();

                const result = await withHost(adapter, config, (host) =>
                    adapter.test!(config as never, host),
                );

                expect(result.success).toBe(true);
                expect(result.message).toContain('via SSH');
            }, 60000);

            it.skipIf(skip)('lists databases from the remote host', async () => {
                const adapter = adapterFor();
                if (!adapter.getDatabases) return;

                const databases = await withHost(adapter, config, (host) =>
                    adapter.getDatabases!(config as never, host),
                );

                expect(Array.isArray(databases)).toBe(true);
                expect(databases.length).toBeGreaterThan(0);
            }, 60000);

            it.skipIf(skip)('dumps to a local file', async () => {
                const adapter = adapterFor();
                const dumpFile = path.join(tempDir, `${slug}_dump.bin`);
                if (fs.existsSync(dumpFile)) fs.unlinkSync(dumpFile);

                const result = await withHost(adapter, config, (host) =>
                    adapter.dump(config as never, dumpFile, host),
                );

                expect(result.success).toBe(true);
                expect(fs.existsSync(dumpFile)).toBe(true);
                // The dump was produced remotely and streamed back, so a
                // non-empty file is the proof that the transfer worked too.
                expect(fs.statSync(dumpFile).size).toBeGreaterThan(0);
            }, 120000);

            it.skipIf(skip || sshRestoreUnsupported.includes(config.type))(
                'restores a dump it just took',
                async () => {
                    const adapter = adapterFor();
                    const dumpFile = path.join(tempDir, `${slug}_roundtrip.bin`);

                    const dumped = await withHost(adapter, config, (host) =>
                        adapter.dump(config as never, dumpFile, host),
                    );
                    expect(dumped.success).toBe(true);

                    const restored = await withHost(adapter, config, (host) =>
                        adapter.restore(config as never, dumpFile, host),
                    );
                    expect(restored.success).toBe(true);
                },
                180000,
            );
        });
    });

    describe('connection reuse', () => {
        const multiDb = sshTestDatabases.find((entry) => entry.config.type === 'mariadb');

        it.skipIf(!sshHostAvailable || !multiDb)(
            'serves several adapter calls from one connection',
            async () => {
                // The point of the extraction: a job used to open one SSH
                // connection per adapter call. Three calls inside one scope
                // must share a single handshake, which only holds if the host
                // stays usable after each one.
                const config = multiDb!.config;
                const adapter = registry.get(config.type) as DatabaseAdapter;

                const result = await withHost(adapter, config, async (host) => {
                    const first = await adapter.getDatabases!(config as never, host);
                    const probe = await adapter.test!(config as never, host);
                    const second = await adapter.getDatabases!(config as never, host);
                    return { first, probe, second };
                });

                expect(result.probe.success).toBe(true);
                expect(result.second).toEqual(result.first);
            },
            90000,
        );
    });
});
