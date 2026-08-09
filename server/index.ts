import { createServer } from "http";
import { join } from "path";
import next from "next";
import { env } from "./env";
import { log } from "./log";
import { Runtime } from "./runtime";

const PROJECT_ROOT = join(__dirname, "..", "..");

async function main(): Promise<void> {
  const runtime = new Runtime();
  await runtime.start(join(PROJECT_ROOT, "migrations"));

  const server = createServer((request, response) => {
    if (request.url === "/healthz") {
      const body = JSON.stringify({
        status: "ok",
        pod: env.podId,
        release: env.release,
        region: env.region,
        leader: runtime.isLeader,
        clients: runtime.clientCount,
        boards: runtime.boardCount,
        uptimeSeconds: Math.round(process.uptime()),
      });
      response.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(body);
      return;
    }

    void handle(request, response);
  });

  const app = next({ dev: env.dev, dir: PROJECT_ROOT, port: env.port, httpServer: server });
  const handle = app.getRequestHandler();

  await app.prepare();
  const upgrade = app.getUpgradeHandler();
  runtime.attach();

  server.on("upgrade", (request, socket, head) => {
    const { pathname } = new URL(request.url || "/", "http://localhost");
    if (pathname === "/ws") {
      runtime.handleUpgrade(request, socket, head);
      return;
    }
    void upgrade(request, socket, head);
  });

  server.on("error", (error: NodeJS.ErrnoException) => {
    log.error("http server error", { message: error.message, code: error.code });
    void runtime.shutdown().finally(() => process.exit(1));
  });

  server.listen(env.port, () => {
    log.info("listening", {
      port: env.port,
      release: env.release,
      region: env.region,
      mode: env.dev ? "development" : "production",
    });
  });

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    log.info("shutting down", { signal });

    server.close();
    await runtime.shutdown();
    await app.close().catch(() => {});

    log.info("shutdown complete");
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error: Error) => {
  log.error("failed to start", { message: error.message, stack: error.stack });
  process.exit(1);
});
