import { describe, it, expect } from 'vitest';
import { attachmentDisposition } from '@/lib/server/content-disposition';

describe('downloads of files whose name is not plain ASCII', () => {
    it('builds a header a Response will actually accept', () => {
        // The regression: a raw name above U+00FF makes the Response constructor throw a
        // TypeError, so the download fails with a 500 before any byte is sent.
        for (const name of ['备份.sql', 'Резервная.tar', 'sauvegarde_préférée.tar.gz', '📦.zip']) {
            expect(() =>
                new Response(null, { headers: { 'Content-Disposition': attachmentDisposition(name) } })
            ).not.toThrow();
        }
    });

    it('carries the real name in filename* as percent-encoded UTF-8', () => {
        expect(attachmentDisposition('备份.sql')).toBe(
            `attachment; filename="__.sql"; filename*=UTF-8''%E5%A4%87%E4%BB%BD.sql`
        );
    });

    it('keeps an addressable ASCII fallback when part of the name survives', () => {
        expect(attachmentDisposition('备份_daily.tar.gz')).toBe(
            `attachment; filename="___daily.tar.gz"; filename*=UTF-8''%E5%A4%87%E4%BB%BD_daily.tar.gz`
        );
    });

    it('falls back to a generic name when nothing readable is left', () => {
        expect(attachmentDisposition('备份')).toBe(
            `attachment; filename="download"; filename*=UTF-8''%E5%A4%87%E4%BB%BD`
        );
    });

    it('leaves a plain ASCII name exactly as it was sent before', () => {
        expect(attachmentDisposition('daily_2026-08-08.tar.zst')).toBe(
            'attachment; filename="daily_2026-08-08.tar.zst"'
        );
    });

    it('neutralises quotes, backslashes and separators that would split the header', () => {
        const header = attachmentDisposition('we"ird\\name/backup.tar');

        expect(header).toContain('filename="we_ird_name_backup.tar"');
        expect(header).toContain(`filename*=UTF-8''we%22ird%5Cname%2Fbackup.tar`);
    });

    it('escapes the characters encodeURIComponent leaves behind but attr-char forbids', () => {
        expect(attachmentDisposition("a'b(c)d*e_备.tar")).toContain(
            `filename*=UTF-8''a%27b%28c%29d%2Ae_%E5%A4%87.tar`
        );
    });
});
