import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const dataDir = path.join(root, "data");
const dbFiles = ["gitfi.db", "gitfi.db-wal", "gitfi.db-shm"];
for (const file of dbFiles) {
  fs.rmSync(path.join(dataDir, file), { force: true });
}
fs.rmSync(path.join(dataDir, "uploads"), { recursive: true, force: true });

const { initDb } = await import("../src/server/db.js");
const { seedDemoData } = await import("../src/server/seed.js");
initDb();
await seedDemoData();
console.log("[gitfi] reset complete — fresh demo markets seeded");
process.exit(0);
