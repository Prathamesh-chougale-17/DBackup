import { OIDCAdapter } from "@/lib/core/oidc-adapter";
import { z } from "zod";
import { logger } from "@/lib/logging/logger";
import { wrapError } from "@/lib/logging/errors";
import { validateOutboundUrl } from "@/lib/url-validation";

const log = logger.child({ adapter: "authelia" });

export const AutheliaAdapter: OIDCAdapter = {
  id: "authelia",
  name: "Authelia",
  description: "Configuration for Authelia",

  inputs: [
    {
      name: "baseUrl",
      label: "Authelia URL",
      type: "url",
      placeholder: "https://auth.company.com",
      required: true,
      description: "The root URL of your Authelia instance"
    }
  ],

  inputSchema: z.object({
    baseUrl: z.string().url()
  }),

  getEndpoints: async (config) => {
    const baseUrl = config.baseUrl.replace(/\/$/, "");
    // Authelia serves discovery at the standard location and uses its root URL as
    // the issuer. Every endpoint is read from the document rather than assembled,
    // so a changed path on the Authelia side does not break this adapter.
    const discoveryUrl = `${baseUrl}/.well-known/openid-configuration`;

    try {
      validateOutboundUrl(discoveryUrl);
      const response = await fetch(discoveryUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch OIDC config from ${discoveryUrl}. Status: ${response.status}`);
      }
      const data = await response.json();

      if (!data.authorization_endpoint || !data.token_endpoint || !data.userinfo_endpoint) {
          throw new Error("Invalid OIDC configuration received: missing endpoints.");
      }

      return {
        issuer: data.issuer,
        authorizationEndpoint: data.authorization_endpoint,
        tokenEndpoint: data.token_endpoint,
        userInfoEndpoint: data.userinfo_endpoint,
        jwksEndpoint: data.jwks_uri,
        discoveryEndpoint: discoveryUrl
      };
    } catch (error) {
       log.error("Authelia discovery failed", { discoveryUrl }, wrapError(error));
       throw error;
    }
  }
};
