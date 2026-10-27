import bcrypt from "bcryptjs";
import { describe, expect, it, vi } from "vitest";
import { createAuth } from "../src/auth.js";

function responseMock() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    clearCookie: vi.fn(),
  };
}

function requestMock(body = {}) {
  return {
    body,
    requestId: "request-test",
    headers: {},
    get(name) {
      return this.headers[name.toLowerCase()];
    },
    session: {
      regenerate(callback) {
        callback(null);
      },
      save(callback) {
        callback(null);
      },
      destroy(callback) {
        callback(null);
      },
    },
  };
}

describe("AccessZ authentication service", () => {
  it("hashes passwords and creates a session on registration", async () => {
    const storedUsers = [];
    const userModel = {
      async create(user) {
        const created = { _id: "user-1", ...user };
        storedUsers.push(created);
        return created;
      },
    };
    const auth = createAuth({ userModel, databaseStatus: () => ({ connected: true, status: "connected" }) });
    const req = requestMock({
      name: "Ada Lovelace",
      email: "ADA@example.com",
      username: "Ada_1",
      password: "A11yStrongPass123",
      confirmPassword: "A11yStrongPass123",
    });
    const res = responseMock();

    await auth.register(req, res);

    expect(res.statusCode).toBe(201);
    expect(res.body.user).toMatchObject({ id: "user-1", email: "ada@example.com", username: "ada_1" });
    expect(storedUsers[0].passwordHash).not.toBe("A11yStrongPass123");
    expect(req.session.userId).toBe("user-1");
    expect(JSON.stringify(res.body)).not.toContain("password");
  }, 15_000);

  it("returns generic invalid credentials and rejects weak or mismatched signup inputs", async () => {
    const userModel = {
      findOne: () => ({ select: async () => null }),
    };
    const auth = createAuth({ userModel, databaseStatus: () => ({ connected: true, status: "connected" }) });
    const loginResponse = responseMock();
    await auth.login(requestMock({ identifier: "person@example.com", password: "wrong" }), loginResponse);
    expect(loginResponse.statusCode).toBe(401);
    expect(loginResponse.body.error.code).toBe("INVALID_CREDENTIALS");

    const registrationResponse = responseMock();
    await auth.register(requestMock({
      name: "Person",
      email: "person@example.com",
      username: "person",
      password: "weak",
      confirmPassword: "other",
    }), registrationResponse);
    expect(registrationResponse.statusCode).toBe(400);
    expect(registrationResponse.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("authenticates a stored password hash, regenerates the session, and destroys it on logout", async () => {
    const user = {
      _id: "user-2",
      name: "Test User",
      email: "test@example.com",
      username: "testuser",
      passwordHash: await bcrypt.hash("A11yStrongPass123", 4),
    };
    const userModel = {
      findOne: () => ({ select: async () => user }),
    };
    const auth = createAuth({ userModel, databaseStatus: () => ({ connected: true, status: "connected" }) });
    const req = requestMock({ identifier: "TESTUSER", password: "A11yStrongPass123" });
    const res = responseMock();

    await auth.login(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.user).toMatchObject({ id: "user-2", email: "test@example.com" });
    expect(req.session.userId).toBe("user-2");

    auth.logout(req, res);
    expect(res.body.status).toBe("logged_out");
    expect(res.clearCookie).toHaveBeenCalledWith("accessz.sid", expect.objectContaining({ httpOnly: true, path: "/" }));
  });

  it("fails closed when the database or session secret is unavailable", () => {
    const auth = createAuth({ databaseStatus: () => ({ connected: false, status: "not_configured" }) });
    const response = responseMock();
    auth.requireReady(requestMock(), response, vi.fn());
    expect(response.statusCode).toBe(503);
    expect(response.body.error.code).toBe("AUTH_NOT_CONFIGURED");
    expect(JSON.stringify(response.body)).not.toContain("stack");
  });

  it("rejects state-changing requests from an untrusted origin", () => {
    const auth = createAuth({ databaseStatus: () => ({ connected: true, status: "connected" }) });
    const request = requestMock();
    request.headers.origin = "https://attacker.example";
    const response = responseMock();
    auth.requireOrigin(request, response, vi.fn());
    expect(response.statusCode).toBe(403);
    expect(response.body.error.code).toBe("ORIGIN_NOT_ALLOWED");
  });
});
