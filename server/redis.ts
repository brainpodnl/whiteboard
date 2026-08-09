import Redis from "ioredis";
import { env } from "./env";
import { log } from "./log";

/**
 * A `rediss://` URL carries no verification mode, so it is treated the way
 * libpq treats `sslmode=require`: encrypted, but not checked against a public
 * CA. A managed Valkey is reachable only from inside the pod and presents a
 * certificate for its internal hostname, which no public CA can vouch for.
 */
function tlsOptions(url: string) {
  return url.startsWith("rediss://") ? { tls: { rejectUnauthorized: false } } : {};
}

function connect(role: string, autoPipelining: boolean): Redis {
  const client = new Redis(env.redisUrl, {
    ...tlsOptions(env.redisUrl),
    lazyConnect: false,
    maxRetriesPerRequest: null,
    enableAutoPipelining: autoPipelining,
    retryStrategy: (attempt) => Math.min(attempt * 200, 2000),
  });

  client.on("error", (error: Error) => {
    log.error("redis error", { role, message: error.message });
  });

  return client;
}

export function createRedis(role: string): Redis {
  return connect(role, true);
}

/**
 * A blocking `XREAD` owns its connection for the length of the block, so the
 * tailer gets one of its own: sharing it would stall every other command for up
 * to the block timeout, and auto-pipelining would batch the block behind them.
 */
export function createBlockingRedis(role: string): Redis {
  return connect(role, false);
}

const RENEW_LEASE = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
end
return 0
`;

const RELEASE_LEASE = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`;

export function defineLeaseCommands(client: Redis) {
  client.defineCommand("renewLease", {
    numberOfKeys: 1,
    lua: RENEW_LEASE,
  });
  client.defineCommand("releaseLease", {
    numberOfKeys: 1,
    lua: RELEASE_LEASE,
  });
}

export type LeaseRedis = Redis & {
  renewLease(key: string, owner: string, ttlMs: number): Promise<number>;
  releaseLease(key: string, owner: string): Promise<number>;
};
