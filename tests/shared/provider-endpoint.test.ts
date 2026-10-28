import { describe, expect, it } from "vitest";

import { providerEndpointIssue } from "@shared/provider-endpoint";

const allowedEndpoints = [
  "https://provider.example",
  "https://provider.example:8443/proxy/v1/",
  "http://localhost:8080/v1",
  "http://127.0.0.1:8080/v1",
  "http://127.42.5.9:8080/v1",
  "http://127.255.255.255:8080/v1",
  "http://[::1]:8080/v1",
];

describe("providerEndpointIssue", () => {
  it.each(allowedEndpoints)("accepts %s", (endpoint) => {
    expect(providerEndpointIssue(endpoint)).toBeNull();
  });

  it.each([
    "http://provider.example/v1",
    "http://192.168.1.10:8080/v1",
    "http://128.0.0.1:8080/v1",
    "http://localhost.example/v1",
    "http://[::2]:8080/v1",
    "https://user:password@provider.example/v1",
    "https://user@provider.example/v1",
    "https://provider.example/v1?key=secret",
    "https://provider.example/v1#fragment",
    "http://localhost:8080/v1?key=secret",
    "ftp://provider.example/v1",
    "not a URL",
    "/relative/path",
    "",
  ])("rejects %s", (endpoint) => {
    expect(providerEndpointIssue(endpoint)).toEqual(expect.any(String));
  });
});
