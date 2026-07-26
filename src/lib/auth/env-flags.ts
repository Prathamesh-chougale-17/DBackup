/**
 * Deployment-level authentication switches.
 *
 * These two settings live in the environment rather than in `SystemSetting`
 * on purpose: both can lock an administrator out of their own instance, so
 * the lever has to be reachable without logging in.
 *
 * Values are read on every call rather than captured at module load, which
 * keeps them straightforward to exercise in tests.
 */

/**
 * Whether browser-facing email/password authentication is switched off.
 *
 * Only interactive sign-in and sign-up are affected. Server-side `auth.api.*`
 * calls - admin user creation and password resets - keep working, because an
 * account usually has to exist before it can link to an SSO identity.
 */
export function isEmailLoginDisabled(): boolean {
    return process.env.DISABLE_EMAIL_LOGIN === "true";
}

/**
 * Endpoints that must be unreachable from a browser when email login is off.
 *
 * Sign-up is on the list because better-auth is configured with `autoSignIn: true`,
 * which makes it mint a session directly without ever touching the sign-in route.
 * Blocking only sign-in would still let somebody self-register into a fresh instance.
 */
const BROWSER_BLOCKED_AUTH_PATHS = new Set(["/sign-in/email", "/sign-up/email"]);

/**
 * Whether a better-auth request should be rejected because email login is disabled.
 *
 * `hasRequest` reflects `ctx.request`, which better-call's router populates only for
 * calls arriving over HTTP. Direct `auth.api.*` calls leave it undefined even when
 * they pass `headers`, which is what keeps admin user creation and password resets
 * working while the browser-facing endpoints are closed.
 */
export function shouldBlockBrowserEmailAuth(path: string, hasRequest: boolean): boolean {
    if (!isEmailLoginDisabled()) return false;
    if (!BROWSER_BLOCKED_AUTH_PATHS.has(path)) return false;
    return hasRequest;
}

/**
 * The `providerId` of the SSO provider the login page should redirect to
 * automatically, or `null` when the feature is off.
 *
 * The value is not verified against the database here. `validateOidcAutoRedirect()`
 * in `src/lib/server/startup-checks.ts` reports an unknown or disabled provider at
 * startup, and the login page only redirects to a provider it actually resolved.
 */
export function getOidcAutoRedirectProviderId(): string | null {
    const value = process.env.OIDC_AUTO_REDIRECT?.trim();
    return value ? value : null;
}
