import { OIDCAdapter } from "@/lib/core/oidc-adapter";
import { AutheliaAdapter } from "@/lib/adapters/oidc/authelia";
import { AuthentikAdapter } from "@/lib/adapters/oidc/authentik";
import { GenericAdapter } from "@/lib/adapters/oidc/generic";
import { PocketIDAdapter } from "@/lib/adapters/oidc/pocket-id";
import { KeycloakAdapter } from "@/lib/adapters/oidc/keycloak";

/**
 * Registry of all available OIDC Adapters (Presets).
 */
export const OIDC_ADAPTERS: OIDCAdapter[] = [
    AutheliaAdapter,
    AuthentikAdapter,
    KeycloakAdapter,
    PocketIDAdapter,
    GenericAdapter
];

export function getOIDCAdapter(id: string): OIDCAdapter | undefined {
    return OIDC_ADAPTERS.find(adapter => adapter.id === id);
}

export function getAllOIDCAdapters() {
    return OIDC_ADAPTERS;
}
