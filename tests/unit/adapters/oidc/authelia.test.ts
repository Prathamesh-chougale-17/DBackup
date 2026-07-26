import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AutheliaAdapter } from "@/lib/adapters/oidc/authelia";

const VALID_OIDC_RESPONSE = {
  issuer: "https://auth.company.com",
  authorization_endpoint: "https://auth.company.com/api/oidc/authorization",
  token_endpoint: "https://auth.company.com/api/oidc/token",
  userinfo_endpoint: "https://auth.company.com/api/oidc/userinfo",
  jwks_uri: "https://auth.company.com/jwks.json"
};

describe("AutheliaAdapter", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = mockFetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("metadata", () => {
    it("should have correct id", () => {
      expect(AutheliaAdapter.id).toBe("authelia");
    });

    it("should have correct name", () => {
      expect(AutheliaAdapter.name).toBe("Authelia");
    });

    it("should expose a single baseUrl input", () => {
      expect(AutheliaAdapter.inputs).toHaveLength(1);
      expect(AutheliaAdapter.inputs[0].name).toBe("baseUrl");
    });

    it("should mark baseUrl as required", () => {
      expect(AutheliaAdapter.inputs[0].required).toBe(true);
    });
  });

  describe("inputSchema", () => {
    it("should accept a valid URL", () => {
      const result = AutheliaAdapter.inputSchema.safeParse({
        baseUrl: "https://auth.company.com"
      });
      expect(result.success).toBe(true);
    });

    it("should reject a non-URL string", () => {
      const result = AutheliaAdapter.inputSchema.safeParse({
        baseUrl: "not-a-url"
      });
      expect(result.success).toBe(false);
    });

    it("should reject missing baseUrl", () => {
      const result = AutheliaAdapter.inputSchema.safeParse({});
      expect(result.success).toBe(false);
    });
  });

  describe("getEndpoints", () => {
    it("should call the standard .well-known discovery URL", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => VALID_OIDC_RESPONSE
      });

      await AutheliaAdapter.getEndpoints({ baseUrl: "https://auth.company.com" });

      expect(mockFetch).toHaveBeenCalledWith(
        "https://auth.company.com/.well-known/openid-configuration"
      );
    });

    it("should strip trailing slash from baseUrl", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => VALID_OIDC_RESPONSE
      });

      await AutheliaAdapter.getEndpoints({ baseUrl: "https://auth.company.com/" });

      expect(mockFetch).toHaveBeenCalledWith(
        "https://auth.company.com/.well-known/openid-configuration"
      );
    });

    it("should return mapped endpoints on success", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => VALID_OIDC_RESPONSE
      });

      const endpoints = await AutheliaAdapter.getEndpoints({
        baseUrl: "https://auth.company.com"
      });

      expect(endpoints.issuer).toBe(VALID_OIDC_RESPONSE.issuer);
      expect(endpoints.authorizationEndpoint).toBe(VALID_OIDC_RESPONSE.authorization_endpoint);
      expect(endpoints.tokenEndpoint).toBe(VALID_OIDC_RESPONSE.token_endpoint);
      expect(endpoints.userInfoEndpoint).toBe(VALID_OIDC_RESPONSE.userinfo_endpoint);
      expect(endpoints.jwksEndpoint).toBe(VALID_OIDC_RESPONSE.jwks_uri);
      expect(endpoints.discoveryEndpoint).toBe(
        "https://auth.company.com/.well-known/openid-configuration"
      );
    });

    it("should throw when the discovery document is missing endpoints", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ issuer: "https://auth.company.com" })
      });

      await expect(
        AutheliaAdapter.getEndpoints({ baseUrl: "https://auth.company.com" })
      ).rejects.toThrow("missing endpoints");
    });

    it("should throw when discovery returns non-ok status", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 503
      });

      await expect(
        AutheliaAdapter.getEndpoints({ baseUrl: "https://auth.company.com" })
      ).rejects.toThrow("503");
    });

    it("should throw when fetch itself rejects", async () => {
      mockFetch.mockRejectedValue(new Error("Connection refused"));

      await expect(
        AutheliaAdapter.getEndpoints({ baseUrl: "https://auth.company.com" })
      ).rejects.toThrow("Connection refused");
    });

    it("should block cloud metadata URLs", async () => {
      await expect(
        AutheliaAdapter.getEndpoints({ baseUrl: "http://169.254.169.254" })
      ).rejects.toThrow();
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
