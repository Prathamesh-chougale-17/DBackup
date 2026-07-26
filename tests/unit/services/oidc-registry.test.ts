import { describe, it, expect } from 'vitest';
import {
    OIDC_ADAPTERS,
    getOIDCAdapter,
    getAllOIDCAdapters,
} from '@/services/sso/oidc-registry';

describe('OIDC_ADAPTERS registry', () => {
    it('contains at least one adapter', () => {
        expect(OIDC_ADAPTERS.length).toBeGreaterThan(0);
    });

    it('each adapter has an id, name, inputs, inputSchema and getEndpoints', () => {
        for (const adapter of OIDC_ADAPTERS) {
            expect(adapter.id).toBeTruthy();
            expect(adapter.name).toBeTruthy();
            expect(Array.isArray(adapter.inputs)).toBe(true);
            expect(adapter.inputSchema).toBeDefined();
            expect(typeof adapter.getEndpoints).toBe('function');
        }
    });

    it('includes authentik adapter', () => {
        const adapter = getOIDCAdapter('authentik');
        expect(adapter).toBeDefined();
        expect(adapter?.name).toBe('Authentik');
    });

    it('includes authelia adapter', () => {
        const adapter = getOIDCAdapter('authelia');
        expect(adapter).toBeDefined();
        expect(adapter?.name).toBe('Authelia');
    });

    it('includes generic adapter', () => {
        const adapter = getOIDCAdapter('generic');
        expect(adapter).toBeDefined();
    });

    it('has a unique id per adapter', () => {
        const ids = OIDC_ADAPTERS.map(a => a.id);
        expect(new Set(ids).size).toBe(ids.length);
    });
});

describe('getOIDCAdapter()', () => {
    it('returns the correct adapter by id', () => {
        const adapter = getOIDCAdapter('authentik');
        expect(adapter?.id).toBe('authentik');
    });

    it('returns undefined for unknown adapter id', () => {
        const adapter = getOIDCAdapter('does-not-exist');
        expect(adapter).toBeUndefined();
    });
});

describe('getAllOIDCAdapters()', () => {
    it('returns the same array as OIDC_ADAPTERS', () => {
        expect(getAllOIDCAdapters()).toBe(OIDC_ADAPTERS);
    });

    it('returns all registered adapters', () => {
        const all = getAllOIDCAdapters();
        expect(all.length).toBe(OIDC_ADAPTERS.length);
    });
});
