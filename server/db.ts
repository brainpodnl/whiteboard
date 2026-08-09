import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { Pool } from "pg";
import { parse, toClientConfig } from "pg-connection-string";
import {
  KIND_INK,
  KIND_STICKER,
  MAX_POINTS_PER_STROKE,
  MAX_STROKES_PER_BOARD,
  OP_BEGIN,
  OP_DELETE,
  OP_END,
  OP_POINTS,
  OP_RESTORE,
  OP_STAMP,
} from "../shared/constants";
import {
  encodeSnapshot,
  packPoints,
  pointsTail,
  unpackPoints,
  type Op,
  type Stroke,
} from "../shared/protocol";
import type { StoredStroke } from "./boards";
import { env } from "./env";
import { log } from "./log";

/** Any replica may boot first, so migrations run under a lock all of them contend for. */
const MIGRATION_LOCK = 8123471;

export const EMPTY_CURSOR = "0-0";

const MAX_POINT_BYTES = MAX_POINTS_PER_STROKE * 4;

type StrokeRow = {
  stroke_id: string;
  author: number;
  kind: number;
  color: number;
  width: number;
  points: Buffer;
  complete: boolean;
  deleted: boolean;
};

export type SnapshotRow = { lastOpId: string; payload: Buffer };

export type BoardRows = { lastOpId: string; strokes: StoredStroke[] };

type Pending = {
  begin: {
    author: number;
    kind: number;
    color: number;
    width: number;
    x: number;
    y: number;
  } | null;
  /** Absolute index within the stroke of the first point in `pts`. */
  base: number;
  pts: number[];
  complete: boolean | null;
  deleted: boolean | null;
};

export class Database {
  readonly pool: Pool;

  constructor() {
    // Do not collapse this back to `connectionString`: pg would then read the
    // URL itself and treat `sslmode=require` as verify-full, which no public CA
    // can satisfy for a managed database's pod-internal hostname.
    this.pool = new Pool({
      ...toClientConfig(parse(env.databaseUrl, { useLibpqCompat: true })),
      max: 8,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    this.pool.on("error", (error) =>
      log.error("postgres pool error", { message: error.message }),
    );
  }

  async migrate(directory: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK]);
      await client.query(
        `create table if not exists schema_migrations (
           name text primary key,
           applied_at timestamptz not null default now()
         )`,
      );

      const applied = new Set(
        (await client.query<{ name: string }>("select name from schema_migrations")).rows.map(
          (row) => row.name,
        ),
      );

      const files = readdirSync(directory)
        .filter((name) => name.endsWith(".sql"))
        .sort();

      for (const file of files) {
        if (applied.has(file)) continue;
        const sql = readFileSync(join(directory, file), "utf8");
        await client.query("begin");
        try {
          await client.query(sql);
          await client.query("insert into schema_migrations (name) values ($1)", [file]);
          await client.query("commit");
          log.info("migration applied", { file });
        } catch (error) {
          await client.query("rollback");
          throw error;
        }
      }
    } finally {
      await client.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK]).catch(() => {});
      client.release();
    }
  }

  async readCursor(board: string): Promise<string> {
    const result = await this.pool.query<{ last_op_id: string }>(
      "select last_op_id from board_cursor where board_id = $1",
      [board],
    );
    return result.rows[0]?.last_op_id ?? EMPTY_CURSOR;
  }

  async loadSnapshot(board: string): Promise<SnapshotRow | null> {
    const result = await this.pool.query<{ last_op_id: string; payload: Buffer }>(
      "select last_op_id, payload from board_snapshots where board_id = $1",
      [board],
    );
    const row = result.rows[0];
    return row ? { lastOpId: row.last_op_id, payload: row.payload } : null;
  }

  /**
   * The rebuild path: the live strokes plus the op the leader had drained them
   * up to, read together so the replay that follows starts exactly where the
   * rows stop.
   */
  async loadBoard(board: string): Promise<BoardRows> {
    const client = await this.pool.connect();
    try {
      await client.query("begin isolation level repeatable read");
      const cursor = await client.query<{ last_op_id: string }>(
        "select last_op_id from board_cursor where board_id = $1",
        [board],
      );
      const rows = await client.query<StrokeRow>(
        `select stroke_id, author, kind, color, width, points, complete, deleted
           from strokes
          where board_id = $1 and not deleted
          order by seq desc
          limit $2`,
        [board, MAX_STROKES_PER_BOARD],
      );
      await client.query("commit");
      return {
        lastOpId: cursor.rows[0]?.last_op_id ?? EMPTY_CURSOR,
        strokes: rows.rows.reverse().map(toStoredStroke),
      };
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Applies a run of stream ops and advances the board's cursor in one
   * transaction, so a leader that dies half way through leaves nothing behind:
   * its successor reads the same cursor and replays the same ops. The fencing
   * read makes a leader that has already lost its lease roll back instead of
   * appending a second copy of the points it was in the middle of writing.
   */
  async compact(
    board: string,
    from: string,
    to: string,
    ops: Op[],
  ): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const current = await client.query<{ last_op_id: string }>(
        "select last_op_id from board_cursor where board_id = $1 for update",
        [board],
      );
      if ((current.rows[0]?.last_op_id ?? EMPTY_CURSOR) !== from) {
        await client.query("rollback");
        return false;
      }

      await client.query(
        `insert into boards (id) values ($1)
         on conflict (id) do update set updated_at = now()`,
        [board],
      );

      for (const [stroke, pending] of fold(ops)) {
        if (pending.begin) {
          await client.query(
            `insert into strokes (board_id, stroke_id, author, kind, color, width, points)
             values ($1, $2, $3, $4, $5, $6, $7)
             on conflict (board_id, stroke_id) do nothing`,
            [
              board,
              stroke,
              pending.begin.author,
              pending.begin.kind,
              pending.begin.color,
              pending.begin.width,
              packPoints([pending.begin.x, pending.begin.y]),
            ],
          );
        }
        if (!pending.pts.length && pending.complete === null && pending.deleted === null) {
          continue;
        }
        // The batch carries the byte offset it starts at, so a stream that holds
        // two copies of the same points — a replay racing the append it was
        // replacing — lands the overlap exactly once. The `else` arm keeps a
        // batch that starts past the stored end from splicing across a gap.
        await client.query(
          `update strokes
              set points = case
                    when octet_length(points) >= $7::int
                      then substring(
                             points || substring($3::bytea from octet_length(points) - $7::int + 1)
                             from 1 for $4::int)
                    else points
                  end,
                  complete = coalesce($5, complete),
                  deleted = coalesce($6, deleted)
            where board_id = $1 and stroke_id = $2`,
          [
            board,
            stroke,
            packPoints(pending.pts),
            MAX_POINT_BYTES,
            pending.complete,
            pending.deleted,
            Math.max(pending.base, 0) * 4,
          ],
        );
      }

      await client.query(
        `insert into board_cursor (board_id, last_op_id) values ($1, $2)
         on conflict (board_id) do update set last_op_id = excluded.last_op_id,
                                              updated_at = now()`,
        [board, to],
      );
      await client.query("commit");
      return true;
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Packs the board straight out of Postgres rather than out of a replica's
   * memory, so the snapshot and the cursor it claims to reflect are read in the
   * same transaction and can never describe two different moments.
   */
  async writeSnapshot(board: string): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query("begin isolation level repeatable read");
      const cursor = await client.query<{ last_op_id: string }>(
        "select last_op_id from board_cursor where board_id = $1",
        [board],
      );
      const lastOpId = cursor.rows[0]?.last_op_id ?? EMPTY_CURSOR;
      const rows = await client.query<StrokeRow>(
        `select stroke_id, author, kind, color, width, points, complete, deleted
           from strokes
          where board_id = $1 and not deleted
          order by seq desc
          limit $2`,
        [board, MAX_STROKES_PER_BOARD],
      );
      const strokes: Stroke[] = rows.rows.reverse().map(toStoredStroke);
      const payload = Buffer.from(encodeSnapshot(strokes));
      await client.query(
        `insert into board_snapshots (board_id, last_op_id, strokes, payload)
         values ($1, $2, $3, $4)
         on conflict (board_id) do update set last_op_id = excluded.last_op_id,
                                              strokes = excluded.strokes,
                                              payload = excluded.payload,
                                              updated_at = now()`,
        [board, lastOpId, strokes.length, payload],
      );
      await client.query("commit");
      return strokes.length;
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /** Keeps the table to the same newest-first window the replicas hold in memory. */
  async trimStrokes(board: string): Promise<void> {
    await this.pool.query(
      `delete from strokes
        where board_id = $1
          and seq < (select min(seq)
                       from (select seq from strokes where board_id = $1
                             order by seq desc limit $2) recent)`,
      [board, MAX_STROKES_PER_BOARD],
    );
  }

  async close(): Promise<void> {
    await this.pool.end().catch(() => {});
  }
}

function toStoredStroke(row: StrokeRow): StoredStroke {
  return {
    id: Number(row.stroke_id),
    author: row.author,
    kind: row.kind,
    color: row.color,
    width: row.width,
    complete: row.complete,
    deleted: row.deleted,
    pts: unpackPoints(row.points),
  };
}

/**
 * Collapses a run of ops into one mutation per stroke. The ops arrive already
 * deduplicated against board state, so points only ever append here; folding
 * them keeps a 750ms drain to a couple of statements per stroke touched.
 */
function fold(ops: Op[]): Map<number, Pending> {
  const pending = new Map<number, Pending>();

  const forStroke = (stroke: number): Pending => {
    let entry = pending.get(stroke);
    if (!entry) {
      entry = { begin: null, base: -1, pts: [], complete: null, deleted: null };
      pending.set(stroke, entry);
    }
    return entry;
  };

  for (const op of ops) {
    const entry = forStroke(op.stroke);
    switch (op.t) {
      case OP_BEGIN:
        if (!entry.begin) {
          entry.begin = {
            author: op.author,
            kind: KIND_INK,
            color: op.color,
            width: op.width,
            x: op.x,
            y: op.y,
          };
        }
        break;
      case OP_STAMP:
        if (!entry.begin) {
          entry.begin = {
            author: op.author,
            kind: KIND_STICKER,
            color: op.sticker,
            width: op.size,
            x: op.x,
            y: op.y,
          };
          entry.complete = true;
        }
        break;
      case OP_POINTS: {
        if (entry.base < 0) {
          entry.base = op.from;
          for (const value of op.pts) entry.pts.push(value);
          break;
        }
        const tail = pointsTail(entry.base + (entry.pts.length >> 1), op.from, op.pts);
        if (tail) for (const value of tail) entry.pts.push(value);
        break;
      }
      case OP_END:
        entry.complete = true;
        break;
      case OP_DELETE:
        entry.deleted = true;
        break;
      case OP_RESTORE:
        entry.deleted = false;
        break;
    }
  }

  return pending;
}
