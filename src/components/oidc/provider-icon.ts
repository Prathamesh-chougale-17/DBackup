import { Box, Globe, Key, Settings2, ShieldCheck, ShieldHalf, type LucideIcon } from "lucide-react";

/**
 * Icon for an OIDC adapter, shared by every surface that renders a provider:
 * the login page, the provider list, the add dialog and the profile SSO card.
 *
 * This lives in one place on purpose. It used to be copied into all four, and
 * they had already drifted - Keycloak fell back to the generic globe in three
 * of them. A new adapter now needs a single line here.
 */
export function getOidcProviderIcon(adapterId: string | null | undefined): LucideIcon {
    switch (adapterId) {
        case "authelia": return ShieldHalf;
        case "authentik": return ShieldCheck;
        case "keycloak": return Key;
        case "pocket-id": return Box;
        case "generic": return Settings2;
        default: return Globe;
    }
}
