import { describe, expect, it } from "vitest";
import { resolvePublicAddress, validatePublicUrl } from "../src/networkGuard.js";

const publicResolver = async () => [{ address: "93.184.216.34", family: 4 }];

describe("scanner network policy", () => {
  it.each([
    "http://127.0.0.1",
    "http://localhost",
    "http://10.0.0.1",
    "http://172.16.0.1",
    "http://192.168.1.1",
    "http://169.254.169.254",
    "http://[::1]",
    "http://[fe80::1]",
    "http://[fd00::1]",
    "http://metadata.google.internal",
  ])("rejects a restricted target: %s", async (url) => {
    await expect(validatePublicUrl(url, publicResolver)).rejects.toMatchObject({ code: "DESTINATION_BLOCKED" });
  });

  it("rejects disallowed schemes, credentials, and nonstandard ports", async () => {
    await expect(validatePublicUrl("file:///etc/passwd")).rejects.toMatchObject({ code: "DISALLOWED_SCHEME" });
    await expect(validatePublicUrl("https://user:secret@example.com")).rejects.toMatchObject({ code: "URL_CREDENTIALS_NOT_ALLOWED" });
    await expect(validatePublicUrl("https://example.com:8443")).rejects.toMatchObject({ code: "DISALLOWED_PORT" });
  });

  it("blocks mixed public/private DNS answers to prevent rebinding", async () => {
    await expect(resolvePublicAddress("public.example", async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ])).rejects.toMatchObject({ code: "DESTINATION_BLOCKED" });
  });

  it("revalidates a redirect destination and blocks redirects into metadata networks", async () => {
    const redirectLocation = new URL("http://169.254.169.254/latest/meta-data/", "https://public.example/start");

    await expect(validatePublicUrl(redirectLocation.href, publicResolver))
      .rejects.toMatchObject({ code: "DESTINATION_BLOCKED" });
  });

  it("returns a pinned public address for the outbound proxy to connect to", async () => {
    await expect(resolvePublicAddress("public.example", publicResolver)).resolves.toEqual({
      address: "93.184.216.34",
      family: 4,
    });
  });
});
