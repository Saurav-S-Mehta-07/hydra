import { describe, expect, it } from "vitest";
import { createApiServer } from "../src/server.js";

describe("API server network boundary", () => {
  it("binds the API to loopback and closes cleanly", async () => {
    const server = createApiServer({ port: 0, onListening: () => {} });
    await new Promise((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });

    expect(server.address()).toMatchObject({ address: "127.0.0.1", family: "IPv4" });
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it("rejects invalid port configuration instead of listening on an unintended interface", () => {
    expect(() => createApiServer({ port: Number.NaN })).toThrow("PORT must be an integer");
    expect(() => createApiServer({ port: 65_536 })).toThrow("PORT must be an integer");
  });
});
