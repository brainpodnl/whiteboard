import { KEY_LEADER, LEASE_MS, LEASE_RENEW_MS } from "../shared/constants";
import { log } from "./log";
import type { LeaseRedis } from "./redis";

type Handlers = {
  onAcquire: () => Promise<void> | void;
  onLose: () => Promise<void> | void;
};

/**
 * One replica holds a short Valkey lease and does the durability work; the rest
 * keep trying to take it. Drawing does not go through the leader at all, so the
 * lease being briefly vacant costs a little compaction latency and nothing else.
 * It is deliberately shorter than a deploy's grace period, so a leader that
 * vanishes without releasing is replaced inside 1.5s.
 */
export class LeaderLease {
  private owned = false;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private stopped = false;

  constructor(
    private readonly redis: LeaseRedis,
    private readonly owner: string,
    private readonly handlers: Handlers,
  ) {}

  get isLeader(): boolean {
    return this.owned;
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), LEASE_RENEW_MS);
    void this.tick();
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      if (this.owned) {
        const renewed = await this.redis.renewLease(KEY_LEADER, this.owner, LEASE_MS);
        if (renewed !== 1) {
          this.owned = false;
          log.warn("lost durability lease");
          await this.handlers.onLose();
        }
        return;
      }

      const claimed = await this.redis.set(
        KEY_LEADER,
        this.owner,
        "PX",
        LEASE_MS,
        "NX",
      );
      if (claimed === "OK") {
        this.owned = true;
        log.info("acquired durability lease");
        await this.handlers.onAcquire();
      }
    } catch (error) {
      log.error("lease tick failed", { message: (error as Error).message });
    } finally {
      this.ticking = false;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (!this.owned) return;
    this.owned = false;
    await this.redis.releaseLease(KEY_LEADER, this.owner).catch(() => {});
    log.info("released durability lease");
  }
}
