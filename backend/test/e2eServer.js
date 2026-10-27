import { createApp } from "../src/app.js";

const userId = "e2e-test-user";
const user = {
  id: userId,
  name: "Browser Test User",
  email: "e2e@example.test",
  username: "browser-test",
};
const workspaces = new Map();

function workspaceFor(id) {
  if (!workspaces.has(id)) workspaces.set(id, { audits: [], repairs: [], verifications: [], artifacts: [] });
  return workspaces.get(id);
}

const repository = {
  async loadWorkspace(id) {
    return structuredClone(workspaceFor(id));
  },
  async saveAudit(id, audit) {
    const records = workspaceFor(id);
    records.audits = [audit, ...records.audits.filter((record) => record.id !== audit.id)];
  },
  async saveRepair(id, repair) {
    const records = workspaceFor(id);
    records.repairs = [repair, ...records.repairs.filter((record) => record.id !== repair.id)];
  },
  async saveVerification(id, verification) {
    const records = workspaceFor(id);
    records.verifications = [verification, ...records.verifications.filter((record) => record.id !== verification.id)];
  },
  async saveArtifact(id, artifact) {
    const records = workspaceFor(id);
    records.artifacts = [artifact, ...records.artifacts.filter((record) => record.id !== artifact.id)];
  },
  async saveRepairAndArtifact(id, repair, artifact) {
    const records = workspaceFor(id);
    records.repairs = [repair, ...records.repairs.filter((record) => record.id !== repair.id)];
    records.artifacts = [artifact, ...records.artifacts.filter((record) => record.id !== artifact.id)];
  },
};

const auth = {
  ready: () => true,
  sessionMiddleware: () => (request, _response, next) => {
    request.session = { userId };
    next();
  },
  requireReady: (_request, _response, next) => next(),
  requireOrigin: (_request, _response, next) => next(),
  requireUser: (request, _response, next) => {
    request.user = { id: userId };
    next();
  },
  loginLimiter: (_request, _response, next) => next(),
  register: (_request, response) => response.status(201).json({ user }),
  login: (_request, response) => response.json({ user }),
  logout: (_request, response) => response.json({ status: "logged_out" }),
  me: (_request, response) => response.json({ user }),
};

const app = createApp({ auth, repository, storageName: "test_memory" });
const port = Number(process.env.E2E_API_PORT ?? 3101);
const server = app.listen(port, "127.0.0.1", () => {
  console.info(`AccessZ isolated E2E API listening on http://127.0.0.1:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
