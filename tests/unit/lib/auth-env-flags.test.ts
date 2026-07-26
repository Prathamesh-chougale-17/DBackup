import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    getOidcAutoRedirectProviderId,
    isEmailLoginDisabled,
    shouldBlockBrowserEmailAuth,
} from '@/lib/auth/env-flags';

const MANAGED_ENV_VARS = ['DISABLE_EMAIL_LOGIN', 'OIDC_AUTO_REDIRECT'];

describe('auth env flags', () => {
    const saved: Record<string, string | undefined> = {};

    beforeEach(() => {
        MANAGED_ENV_VARS.forEach(k => {
            saved[k] = process.env[k];
            delete process.env[k];
        });
    });

    afterEach(() => {
        MANAGED_ENV_VARS.forEach(k => {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        });
    });

    describe('isEmailLoginDisabled', () => {
        it('is off unless the variable is exactly "true"', () => {
            expect(isEmailLoginDisabled()).toBe(false);

            process.env.DISABLE_EMAIL_LOGIN = 'false';
            expect(isEmailLoginDisabled()).toBe(false);

            process.env.DISABLE_EMAIL_LOGIN = 'true';
            expect(isEmailLoginDisabled()).toBe(true);
        });
    });

    describe('getOidcAutoRedirectProviderId', () => {
        it('returns null when unset or blank', () => {
            expect(getOidcAutoRedirectProviderId()).toBeNull();

            process.env.OIDC_AUTO_REDIRECT = '   ';
            expect(getOidcAutoRedirectProviderId()).toBeNull();
        });

        it('returns the trimmed provider ID', () => {
            process.env.OIDC_AUTO_REDIRECT = ' authentik-742 ';
            expect(getOidcAutoRedirectProviderId()).toBe('authentik-742');
        });
    });

    // This is the invariant the whole design rests on: closing the browser-facing
    // endpoints must not close the server-side ones the admin UI calls.
    describe('shouldBlockBrowserEmailAuth', () => {
        it('blocks nothing while the flag is off', () => {
            expect(shouldBlockBrowserEmailAuth('/sign-in/email', true)).toBe(false);
            expect(shouldBlockBrowserEmailAuth('/sign-up/email', true)).toBe(false);
        });

        it('blocks browser sign-in and sign-up when the flag is on', () => {
            process.env.DISABLE_EMAIL_LOGIN = 'true';

            expect(shouldBlockBrowserEmailAuth('/sign-in/email', true)).toBe(true);
            // Sign-up matters because autoSignIn mints a session without touching sign-in
            expect(shouldBlockBrowserEmailAuth('/sign-up/email', true)).toBe(true);
        });

        it('leaves server-side auth.api calls alone', () => {
            process.env.DISABLE_EMAIL_LOGIN = 'true';

            // auth.api.signUpEmail - admin creates a user
            expect(shouldBlockBrowserEmailAuth('/sign-up/email', false)).toBe(false);
            // auth.api.signInEmail - self-service current-password check
            expect(shouldBlockBrowserEmailAuth('/sign-in/email', false)).toBe(false);
        });

        it('never touches passkey, SSO or two-factor routes', () => {
            process.env.DISABLE_EMAIL_LOGIN = 'true';

            expect(shouldBlockBrowserEmailAuth('/sign-in/sso', true)).toBe(false);
            expect(shouldBlockBrowserEmailAuth('/passkey/generate-authenticate-options', true)).toBe(false);
            expect(shouldBlockBrowserEmailAuth('/two-factor/verify-totp', true)).toBe(false);
            expect(shouldBlockBrowserEmailAuth('/two-factor/verify-backup-code', true)).toBe(false);
            // setPassword is server-only and has no path at all
            expect(shouldBlockBrowserEmailAuth('', true)).toBe(false);
        });
    });
});
