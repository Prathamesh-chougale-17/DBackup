import { describe, it, expect } from 'vitest';
import { encodeUrlPayload, decodeUrlPayload } from '@/lib/url-payload';

describe('restore deep links carrying non-Latin1 metadata', () => {
    it('encodes a backup whose job and source names are Chinese', () => {
        const file = {
            name: 'backup_2026-08-08.tar.zst',
            path: 'dbackup/生产环境/backup_2026-08-08.tar.zst',
            jobName: '生产环境每日备份',
            sourceName: '主数据库',
            trigger: { type: 'schedule', actor: '管理员' },
        };

        expect(decodeUrlPayload(encodeUrlPayload(file))).toEqual(file);
    });

    it('survives Cyrillic, Greek, Hebrew and emoji in a file name', () => {
        for (const name of ['Резервная.tar', 'αντίγραφο.tar', 'גיבוי.tar', '📦.tar']) {
            expect(decodeUrlPayload<{ name: string }>(encodeUrlPayload({ name }))?.name).toBe(name);
        }
    });

    it('stays byte-identical to plain btoa for ASCII, so older links keep resolving', () => {
        const file = { name: 'daily_2026-08-08.tar.zst', size: 184320114 };
        const legacy = btoa(JSON.stringify(file));

        expect(encodeUrlPayload(file)).toBe(legacy);
        expect(decodeUrlPayload(legacy)).toEqual(file);
    });

    it('handles a payload large enough to need chunking', () => {
        const file = { name: '备'.repeat(50_000) };

        expect(decodeUrlPayload(encodeUrlPayload(file))).toEqual(file);
    });

    it('returns null for a missing, truncated or non-JSON parameter', () => {
        expect(decodeUrlPayload(null)).toBeNull();
        expect(decodeUrlPayload('')).toBeNull();
        expect(decodeUrlPayload('not base64 !!')).toBeNull();
        expect(decodeUrlPayload(btoa('{"name":'))).toBeNull();
    });
});
