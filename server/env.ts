import { hostname } from "os";
import { randomBytes } from "crypto";

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export const env = {
  port: parseInt(process.env.PORT || "3000", 10),
  dev: process.env.NODE_ENV !== "production",
  databaseUrl:
    process.env.DATABASE_URL ||
    "postgres://whiteboard:whiteboard@localhost:5432/whiteboard",
  redisUrl: process.env.REDIS_URL || "redis://localhost:6379",
  podId: process.env.POD_ID || hostname() || `pod-${randomBytes(3).toString("hex")}`,
  release: (process.env.RELEASE_ID || randomBytes(3).toString("hex")).slice(0, 12),
  region: process.env.REGION || "eu-west-1",
  trustProxy: process.env.TRUST_PROXY !== "0",
  opsPerSecond: positiveInt(process.env.OPS_PER_SECOND, 120),
  erasesPer10s: positiveInt(process.env.ERASES_PER_10S, 60),
};
