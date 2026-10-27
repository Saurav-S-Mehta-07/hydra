import { afterEach, describe, expect, it, vi } from "vitest";
import { MongoAuditRepository } from "../src/auditRepository.js";
import { ArtifactRecord, AuditRecord, RepairRecord, User, VerificationRecord } from "../src/models.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MongoDB account repository", () => {
  it("loads every persisted record collection using the authenticated owner ID", async () => {
    const userId = "000000000000000000000042";
    const query = () => ({
      sort: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      lean: async () => [],
    });
    const auditFind = vi.spyOn(AuditRecord, "find").mockImplementation(query);
    const repairFind = vi.spyOn(RepairRecord, "find").mockImplementation(query);
    const verificationFind = vi.spyOn(VerificationRecord, "find").mockImplementation(query);
    const artifactFind = vi.spyOn(ArtifactRecord, "find").mockImplementation(query);
    const repository = new MongoAuditRepository();

    await expect(repository.loadWorkspace(userId)).resolves.toEqual({
      audits: [],
      repairs: [],
      verifications: [],
      artifacts: [],
    });
    for (const find of [auditFind, repairFind, verificationFind, artifactFind]) {
      expect(find).toHaveBeenCalledWith({ userId });
      expect(find.mock.results[0].value.sort).toHaveBeenCalledWith({ createdAt: -1 });
    }
  });

  it("persists controlled artifacts under the authenticated owner key", async () => {
    const userId = "000000000000000000000044";
    const artifact = { id: "artifact-1", html: "<main></main>", createdAt: "2026-01-01T00:00:00.000Z" };
    const update = vi.spyOn(ArtifactRecord, "updateOne").mockResolvedValue({});

    await new MongoAuditRepository().saveArtifact(userId, artifact);

    expect(update).toHaveBeenCalledWith(
      { userId, recordId: artifact.id },
      expect.objectContaining({ $set: { data: artifact, createdAt: new Date(artifact.createdAt) } }),
      { upsert: true, runValidators: true, timestamps: false },
    );
  });

  it("upserts audit data only under the requesting user's owner key", async () => {
    const userId = "000000000000000000000043";
    const audit = { id: "audit-private", createdAt: "2026-01-01T00:00:00.000Z" };
    const update = vi.spyOn(AuditRecord, "updateOne").mockResolvedValue({});

    await new MongoAuditRepository().saveAudit(userId, audit);

    expect(update).toHaveBeenCalledWith(
      { userId, recordId: audit.id },
      expect.objectContaining({ $set: { data: audit, createdAt: new Date(audit.createdAt) } }),
      { upsert: true, runValidators: true, timestamps: false },
    );
  });

  it("keeps passwords out of ordinary user queries and declares unique account identifiers", () => {
    expect(User.schema.path("passwordHash").options.select).toBe(false);
    const indexes = User.schema.indexes();
    expect(indexes).toEqual(expect.arrayContaining([
      [{ email: 1 }, { unique: true }],
      [{ username: 1 }, { unique: true }],
    ]));
  });
});
