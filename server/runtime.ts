import { randomUUID } from "crypto";
import type { IncomingMessage } from "http";
import type { Duplex } from "stream";
import { WebSocket, WebSocketServer } from "ws";
import {
  BOARD_ID,
  BOARD_IDLE_MS,
  COLOR_COUNT,
  COMPACT_MS,
  CURSOR_MS,
  DEFAULT_BOARD,
  FANOUT_MS,
  FRAME_SNAPSHOT,
  KEY_BOARDS,
  KEY_REPLICAS,
  MAX_POINTS_PER_MESSAGE,
  OP_BEGIN,
  OP_DELETE,
  OP_END,
  OP_POINTS,
  OP_RESTORE,
  PRESENCE_BEAT_MS,
  PRESENCE_TTL_MS,
  REPLICA_BEAT_MS,
  REPLICA_TTL_MS,
  SNAPSHOT_MS,
  STREAM_RETAIN_MS,
  WIDTHS,
  boardAuthorMap,
  boardAuthorSeq,
  boardCursorChannel,
  boardPresence,
  boardStream,
} from "../shared/constants";
import { randomName, sanitizeName } from "../shared/names";
import {
  decodeFrame,
  decodeOp,
  encodeCursors,
  encodeOp,
  encodeOps,
  pointsTail,
  strokeAuthor,
  type CursorWire,
  type Op,
  type Person,
  type ServerMessage,
} from "../shared/protocol";
import { BoardState, type StoredStroke } from "./boards";
import { Database, EMPTY_CURSOR } from "./db";
import { env } from "./env";
import { LeaderLease } from "./leader";
import { log } from "./log";
import {
  createBlockingRedis,
  createRedis,
  defineLeaseCommands,
  type LeaseRedis,
} from "./redis";

const SOCKET_BACKPRESSURE = 1024 * 1024;
const MAX_MESSAGE_BYTES = 16 * 1024;
const MAX_ERASE_BATCH = 512;
const OPS_PER_FRAME = 256;
const TAIL_BLOCK_MS = 100;
const TAIL_COUNT = 1024;
const REPLAY_COUNT = 1000;
const COMPACT_COUNT = 2000;
const PRESENCE_POLL_MS = 1000;
const REAP_MS = 30_000;
const PING_MS = 30_000;
const AUTHOR_MAP_TTL_S = 86_400;
const AUTHOR_MAX = 0xffff;
const SESSION_ID = /^[A-Za-z0-9_-]{8,64}$/;
const STREAM_FIELD = "d";

type Draft = { stroke: number; points: number; complete: boolean };

type Session = {
  socket: WebSocket;
  ip: string;
  board: string;
  sessionId: string;
  author: number;
  name: string;
  color: number;
  greeted: boolean;
  ready: boolean;
  alive: boolean;
  cursor: CursorWire | null;
  draft: Draft | null;
  opsWindow: number;
  opsUsed: number;
  eraseWindow: number;
  eraseUsed: number;
};

type BoardRuntime = {
  id: string;
  state: BoardState;
  sessions: Set<Session>;
  pending: Op[];
  tailId: string;
  hydrated: boolean;
  hydrating: Promise<void> | null;
  lastActivity: number;
  presence: string;
};

export class Runtime {
  private readonly commands: LeaseRedis;
  private readonly subscriber: LeaseRedis;
  private readonly publisher: LeaseRedis;
  private readonly tail: LeaseRedis;
  private readonly db = new Database();
  private readonly lease: LeaderLease;
  private readonly sessions = new Set<Session>();
  private readonly boards = new Map<string, BoardRuntime>();
  private readonly inflight = new Set<Promise<unknown>>();
  private wss: WebSocketServer | null = null;

  private intervals: NodeJS.Timeout[] = [];
  private leaderIntervals: NodeJS.Timeout[] = [];
  private replicaIndex = 1;
  private replicaCount = 1;
  private compacting = false;
  private snapshotting = false;
  private shuttingDown = false;

  constructor() {
    this.commands = createRedis("commands") as LeaseRedis;
    this.subscriber = createRedis("subscriber") as LeaseRedis;
    this.publisher = createRedis("publisher") as LeaseRedis;
    this.tail = createBlockingRedis("tail") as LeaseRedis;
    defineLeaseCommands(this.commands);

    this.lease = new LeaderLease(this.commands, env.podId, {
      onAcquire: () => this.becomeLeader(),
      onLose: () => this.stepDown(),
    });
  }

  get isLeader(): boolean {
    return this.lease.isLeader;
  }

  get clientCount(): number {
    return this.sessions.size;
  }

  get boardCount(): number {
    return this.boards.size;
  }

  async start(migrationsDir: string): Promise<void> {
    await this.db.migrate(migrationsDir);

    this.subscriber.on("messageBuffer", (channel: Buffer, payload: Buffer) => {
      this.onCursorFrame(channel.toString(), payload);
    });

    this.lease.start();

    this.intervals.push(
      setInterval(() => this.flushFanout(), FANOUT_MS),
      setInterval(() => this.flushCursors(), CURSOR_MS),
      setInterval(() => void this.heartbeatPresence(), PRESENCE_BEAT_MS),
      setInterval(() => void this.pollPresence(), PRESENCE_POLL_MS),
      setInterval(() => void this.heartbeatReplica(), REPLICA_BEAT_MS),
      setInterval(() => this.reapBoards(), REAP_MS),
      setInterval(() => this.pingSockets(), PING_MS),
    );

    void this.heartbeatReplica();
    void this.tailLoop();
  }

  attach(): void {
    const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
    this.wss = wss;

    wss.on("connection", (socket: WebSocket, request: IncomingMessage) => {
      this.onConnection(socket, request);
    });
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!this.wss || this.shuttingDown) {
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.wss?.emit("connection", ws, request);
    });
  }

  private onConnection(socket: WebSocket, request: IncomingMessage): void {
    const now = Date.now();
    const session: Session = {
      socket,
      ip: clientIp(request),
      board: boardOf(request),
      sessionId: "",
      author: 0,
      name: "",
      color: 0,
      greeted: false,
      ready: false,
      alive: true,
      cursor: null,
      draft: null,
      opsWindow: now,
      opsUsed: 0,
      eraseWindow: now,
      eraseUsed: 0,
    };
    this.sessions.add(session);

    socket.on("pong", () => {
      session.alive = true;
    });

    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      void this.onClientMessage(session, data.toString());
    });

    socket.on("close", () => this.dropSession(session));
    socket.on("error", () => socket.terminate());
  }

  private dropSession(session: Session): void {
    this.sessions.delete(session);
    const board = this.boards.get(session.board);
    if (!board) return;
    board.sessions.delete(session);
    if (session.ready) {
      void this.commands
        .zrem(boardPresence(session.board), presenceMember(session))
        .catch(() => {});
    }
  }

  private async onClientMessage(session: Session, raw: string): Promise<void> {
    if (raw.length > MAX_MESSAGE_BYTES) return;

    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;

    const body = message as Record<string, unknown>;

    if (body.t === "ping") {
      const stamp = Number(body.c);
      if (Number.isFinite(stamp)) this.send(session, { t: "pong", c: stamp });
      return;
    }

    if (body.t === "hello") {
      await this.onHello(session, body);
      return;
    }

    if (!session.ready) return;
    const board = this.boards.get(session.board);
    if (!board || !board.hydrated) return;

    switch (body.t) {
      case "begin":
        this.onBegin(session, board, body);
        return;
      case "pts":
        this.onPoints(session, board, body);
        return;
      case "end":
        this.onEnd(session, board, body);
        return;
      case "erase":
        this.onErase(session, board, body, true);
        return;
      case "restore":
        this.onErase(session, board, body, false);
        return;
      case "cursor":
        this.onCursor(session, body);
        return;
    }
  }

  private async onHello(session: Session, body: Record<string, unknown>): Promise<void> {
    if (session.greeted) return;
    session.greeted = true;

    const boardId = session.board;
    const sessionId =
      typeof body.session === "string" && SESSION_ID.test(body.session)
        ? body.session
        : randomUUID();

    const stored = await this.commands
      .hget(boardAuthorMap(boardId), sessionId)
      .catch(() => null);
    const identity = parseIdentity(stored);

    let author = identity?.a ?? 0;
    if (!author) {
      const seq = await this.commands.incr(boardAuthorSeq(boardId)).catch(() => 0);
      author = seq > 0 ? ((seq - 1) % AUTHOR_MAX) + 1 : 1;
    }

    const name =
      typeof body.name === "string" && body.name.trim()
        ? sanitizeName(body.name)
        : (identity?.n ?? randomName());
    const color = isColor(body.color)
      ? (body.color as number)
      : (identity?.c ?? author % COLOR_COUNT);

    session.sessionId = sessionId;
    session.author = author;
    session.name = name;
    session.color = color;

    await this.commands
      .hset(boardAuthorMap(boardId), sessionId, JSON.stringify({ a: author, n: name, c: color }))
      .catch(() => {});
    await this.commands.expire(boardAuthorMap(boardId), AUTHOR_MAP_TTL_S).catch(() => {});

    let board: BoardRuntime;
    try {
      board = await this.ensureBoard(boardId);
    } catch (error) {
      log.error("hydration failed", { board: boardId, message: (error as Error).message });
      this.send(session, { t: "rejected", reason: "board unavailable, retrying" });
      session.socket.close(1013, "board unavailable");
      return;
    }

    if (session.socket.readyState !== WebSocket.OPEN) return;

    // Nothing may await between here and the snapshot: the queued ops go out
    // first, then the socket sees the board exactly as it stands and joins the
    // fan-out, so its first frame continues from the snapshot with no gap.
    this.flushBoard(board);
    this.send(session, {
      t: "welcome",
      author,
      board: boardId,
      pod: env.podId,
      replica: this.replicaIndex,
      replicas: this.replicaCount,
      leader: this.isLeader,
      release: env.release,
      region: env.region,
      strokes: board.state.strokeCount,
    });
    session.socket.send(Buffer.from(board.state.snapshot()), { binary: true });
    board.sessions.add(session);
    session.ready = true;

    void this.markPresence(session);
  }

  private onBegin(session: Session, board: BoardRuntime, body: Record<string, unknown>): void {
    const stroke = strokeId(body.stroke);
    if (stroke === null || strokeAuthor(stroke) !== session.author) return;

    const color = isColor(body.color) ? (body.color as number) : null;
    const width = Number(body.width);
    const x = coordinate(body.x);
    const y = coordinate(body.y);
    if (color === null || x === null || y === null) return;
    // `width` is an index into WIDTHS on the wire, not a stroke width in units.
    if (!Number.isInteger(width) || width < 0 || width >= WIDTHS.length) return;
    if (!this.charge(session, 1)) return;

    if (board.state.has(stroke)) {
      session.draft = { stroke, points: 0, complete: board.state.isComplete(stroke) };
      return;
    }
    if (session.draft?.stroke === stroke) return;

    session.draft = { stroke, points: 1, complete: false };
    this.publish(board, { t: OP_BEGIN, stroke, author: session.author, color, width, x, y });
  }

  private onPoints(session: Session, board: BoardRuntime, body: Record<string, unknown>): void {
    const stroke = strokeId(body.stroke);
    if (stroke === null || strokeAuthor(stroke) !== session.author) return;

    const from = Number(body.from);
    if (!Number.isInteger(from) || from < 0) return;

    const raw = body.p;
    if (!Array.isArray(raw) || !raw.length || raw.length % 2) return;
    if (raw.length >> 1 > MAX_POINTS_PER_MESSAGE) return;

    const batch = new Array<number>(raw.length);
    for (let i = 0; i < raw.length; i++) {
      const value = coordinate(raw[i]);
      if (value === null) return;
      batch[i] = value;
    }

    if (!this.charge(session, 1)) return;

    // The gateway's own view is the stream state plus whatever it has already
    // added and not yet tailed back, so a replayed batch is trimmed to its new
    // tail here and a wholly redundant one never reaches the stream at all.
    const draft = session.draft?.stroke === stroke ? session.draft : null;
    const have = Math.max(board.state.pointCount(stroke), draft ? draft.points : -1);
    if (have < 0) return;

    const tail = pointsTail(have, from, batch);
    if (!tail) return;

    if (draft) draft.points = have + (tail.length >> 1);
    this.publish(board, { t: OP_POINTS, stroke, from: have, pts: tail });
  }

  private onEnd(session: Session, board: BoardRuntime, body: Record<string, unknown>): void {
    const stroke = strokeId(body.stroke);
    if (stroke === null || strokeAuthor(stroke) !== session.author) return;

    const draft = session.draft?.stroke === stroke ? session.draft : null;
    if (board.state.pointCount(stroke) < 0 && !draft) return;
    if (board.state.isComplete(stroke) || draft?.complete) return;
    if (!this.charge(session, 1)) return;

    if (draft) draft.complete = true;
    this.publish(board, { t: OP_END, stroke });
  }

  private onErase(
    session: Session,
    board: BoardRuntime,
    body: Record<string, unknown>,
    erase: boolean,
  ): void {
    const raw = body.strokes;
    if (!Array.isArray(raw) || !raw.length) return;

    for (const value of raw.slice(0, MAX_ERASE_BATCH)) {
      const stroke = strokeId(value);
      if (stroke === null) continue;
      if (!board.state.has(stroke)) continue;
      if (board.state.isDeleted(stroke) !== erase) continue;
      if (!this.chargeErase(session)) return;
      this.publish(board, { t: erase ? OP_DELETE : OP_RESTORE, stroke });
    }
  }

  private onCursor(session: Session, body: Record<string, unknown>): void {
    const x = coordinate(body.x);
    const y = coordinate(body.y);
    if (x === null || y === null) return;
    session.cursor = {
      author: session.author,
      x,
      y,
      color: session.color,
      drawing: body.drawing === true,
    };
  }

  private charge(session: Session, cost: number): boolean {
    const now = Date.now();
    if (now - session.opsWindow >= 1000) {
      session.opsWindow = now;
      session.opsUsed = 0;
    }
    if (session.opsUsed + cost > env.opsPerSecond) return false;
    session.opsUsed += cost;
    return true;
  }

  private chargeErase(session: Session): boolean {
    const now = Date.now();
    if (now - session.eraseWindow >= 10_000) {
      session.eraseWindow = now;
      session.eraseUsed = 0;
    }
    if (session.eraseUsed >= env.erasesPer10s) return false;
    session.eraseUsed++;
    return this.charge(session, 1);
  }

  private publish(board: BoardRuntime, op: Op): void {
    board.lastActivity = Date.now();
    const payload = Buffer.from(encodeOp(op));
    const pending = this.commands
      .xadd(boardStream(board.id), "*", STREAM_FIELD, payload)
      .catch((error: Error) => {
        log.error("failed to append op", { board: board.id, message: error.message });
        return null;
      })
      .finally(() => this.inflight.delete(pending));
    this.inflight.add(pending);
  }

  private async ensureBoard(id: string): Promise<BoardRuntime> {
    const existing = this.boards.get(id);
    if (existing) {
      if (existing.hydrating) await existing.hydrating;
      return existing;
    }

    const board: BoardRuntime = {
      id,
      state: new BoardState(),
      sessions: new Set(),
      pending: [],
      tailId: EMPTY_CURSOR,
      hydrated: false,
      hydrating: null,
      lastActivity: Date.now(),
      presence: "",
    };
    this.boards.set(id, board);

    const hydrating = (async () => {
      await this.subscriber.subscribe(boardCursorChannel(id)).catch(() => {});
      await this.commands.zadd(KEY_BOARDS, Date.now(), id).catch(() => {});
      try {
        await this.hydrate(board);
        board.hydrated = true;
      } catch (error) {
        this.boards.delete(id);
        await this.subscriber.unsubscribe(boardCursorChannel(id)).catch(() => {});
        throw error;
      } finally {
        board.hydrating = null;
      }
    })();

    board.hydrating = hydrating;
    await hydrating;
    return board;
  }

  /**
   * A snapshot row is one read and a short replay, so it is the preferred way
   * in — but only while the stream still holds every op after the id the
   * snapshot was taken at. Compaction keeps advancing the cursor after a
   * snapshot is written, and trimming follows the cursor, so a snapshot left
   * alone long enough has its tail trimmed out from under it. Those ops are by
   * definition already committed, so the rebuild from the strokes table picks
   * them up instead. That path never needs the same check: trimming never goes
   * past the committed cursor, so every op after it is still in the stream.
   */
  private async hydrate(board: BoardRuntime): Promise<void> {
    const stream = boardStream(board.id);
    const snapshot = await this.db.loadSnapshot(board.id);

    let strokes: StoredStroke[] | null = null;
    let cursor = EMPTY_CURSOR;
    let source = "snapshot";

    if (snapshot) {
      const head = await this.commands.xrange(stream, "-", "+", "COUNT", 1);
      const firstId: string | undefined = head[0]?.[0];
      if (!firstId || compareIds(firstId, snapshot.lastOpId) <= 0) {
        strokes = decodeSnapshot(snapshot.payload);
        cursor = snapshot.lastOpId;
      }
    }

    if (!strokes) {
      const rows = await this.db.loadBoard(board.id);
      strokes = rows.strokes;
      cursor = rows.lastOpId;
      source = "strokes";
    }

    board.state.reset(strokes);
    board.tailId = cursor;

    let replayed = 0;
    for (;;) {
      const entries = await this.commands.xrangeBuffer(
        stream,
        `(${board.tailId}`,
        "+",
        "COUNT",
        REPLAY_COUNT,
      );
      if (!entries.length) break;
      replayed += entries.length;
      this.applyEntries(board, entries, false);
      if (entries.length < REPLAY_COUNT) break;
    }

    log.info("board hydrated", {
      board: board.id,
      source,
      strokes: board.state.strokeCount,
      replayed,
      at: board.tailId,
    });
  }

  /**
   * Every replica reads the same stream in the same order, so this is where the
   * shared board actually comes from — the leader is not in the path at all.
   */
  private async tailLoop(): Promise<void> {
    while (!this.shuttingDown) {
      const boards = [...this.boards.values()].filter((board) => board.hydrated);
      if (!boards.length) {
        await sleep(TAIL_BLOCK_MS);
        continue;
      }

      try {
        const keys = boards.map((board) => boardStream(board.id));
        const ids = boards.map((board) => board.tailId);
        const reply = await this.tail.xreadBuffer(
          "COUNT",
          TAIL_COUNT,
          "BLOCK",
          TAIL_BLOCK_MS,
          "STREAMS",
          ...keys,
          ...ids,
        );
        if (!reply) continue;

        for (const [key, entries] of reply) {
          const board = this.boards.get(boardFromStream(key.toString()));
          if (!board) continue;
          this.applyEntries(board, entries, true);
          board.lastActivity = Date.now();
        }
      } catch (error) {
        if (this.shuttingDown) return;
        log.error("stream tail failed", { message: (error as Error).message });
        await sleep(250);
      }
    }
  }

  private applyEntries(
    board: BoardRuntime,
    entries: [id: Buffer, fields: Buffer[]][],
    collect: boolean,
  ): void {
    for (const [id, fields] of entries) {
      board.tailId = id.toString();
      const payload = streamPayload(fields);
      if (!payload) continue;

      let op: Op;
      try {
        op = decodeOp(payload);
      } catch {
        continue;
      }

      if (board.state.apply(op) && collect) board.pending.push(op);
    }
  }

  private flushFanout(): void {
    for (const board of this.boards.values()) this.flushBoard(board);
  }

  private flushBoard(board: BoardRuntime): void {
    if (!board.pending.length) return;
    const ops = board.pending;
    board.pending = [];
    if (!board.sessions.size) return;

    for (let at = 0; at < ops.length; at += OPS_PER_FRAME) {
      const frame = Buffer.from(encodeOps(ops.slice(at, at + OPS_PER_FRAME)));
      for (const session of board.sessions) this.sendFrame(session, frame);
    }
  }

  private flushCursors(): void {
    for (const board of this.boards.values()) {
      const cursors: CursorWire[] = [];
      for (const session of board.sessions) {
        if (session.cursor) cursors.push(session.cursor);
      }
      if (!cursors.length) continue;
      void this.publisher
        .publish(boardCursorChannel(board.id), Buffer.from(encodeCursors(cursors)))
        .catch(() => {});
    }
  }

  private onCursorFrame(channel: string, payload: Buffer): void {
    const board = this.boards.get(boardFromCursorChannel(channel));
    if (!board) return;
    for (const session of board.sessions) {
      if (session.socket.readyState !== WebSocket.OPEN) continue;
      if (session.socket.bufferedAmount > SOCKET_BACKPRESSURE) continue;
      session.socket.send(payload, { binary: true });
    }
  }

  private async markPresence(session: Session): Promise<void> {
    await this.commands
      .zadd(boardPresence(session.board), Date.now(), presenceMember(session))
      .catch(() => {});
  }

  private async heartbeatPresence(): Promise<void> {
    const ready = [...this.sessions].filter((session) => session.ready);
    if (!ready.length) return;

    const now = Date.now();
    const pipeline = this.commands.multi();
    const boards = new Set<string>();
    for (const session of ready) {
      pipeline.zadd(boardPresence(session.board), now, presenceMember(session));
      boards.add(session.board);
    }
    for (const board of boards) pipeline.zadd(KEY_BOARDS, now, board);
    await pipeline.exec().catch(() => {});
  }

  private async pollPresence(): Promise<void> {
    const cutoff = Date.now() - PRESENCE_TTL_MS;
    for (const board of this.boards.values()) {
      if (!board.sessions.size) continue;
      const members = await this.commands
        .zrangebyscore(boardPresence(board.id), cutoff, "+inf")
        .catch(() => [] as string[]);

      const people: Person[] = [];
      for (const member of members) {
        const person = parsePresence(member);
        if (person) people.push(person);
      }
      people.sort((a, b) => a.author - b.author);

      const signature = JSON.stringify(people);
      if (signature === board.presence) continue;
      board.presence = signature;
      this.broadcast(board, { t: "presence", people });
    }
  }

  private async heartbeatReplica(): Promise<void> {
    const now = Date.now();
    try {
      await this.commands.zadd(KEY_REPLICAS, now, env.podId);
      await this.commands.zremrangebyscore(KEY_REPLICAS, "-inf", now - REPLICA_TTL_MS);
      const members = await this.commands.zrange(KEY_REPLICAS, 0, -1);
      const sorted = [...members].sort();
      const index = sorted.indexOf(env.podId);
      const replicaIndex = index >= 0 ? index + 1 : 1;
      const replicaCount = Math.max(sorted.length, 1);

      if (replicaIndex !== this.replicaIndex || replicaCount !== this.replicaCount) {
        this.replicaIndex = replicaIndex;
        this.replicaCount = replicaCount;
        for (const board of this.boards.values()) {
          this.broadcast(board, {
            t: "meta",
            replica: replicaIndex,
            replicas: replicaCount,
            leader: this.isLeader,
          });
        }
      }
    } catch (error) {
      log.error("replica heartbeat failed", { message: (error as Error).message });
    }
  }

  private async becomeLeader(): Promise<void> {
    this.leaderIntervals.push(
      setInterval(() => void this.compactAll(), COMPACT_MS),
      setInterval(() => void this.snapshotAll(), SNAPSHOT_MS),
      setInterval(() => void this.pruneBoards(), 1000),
    );
    void this.compactAll();
  }

  /**
   * A lease can be lost and won again, so the jobs the leader started have to go
   * with it. Two replicas draining the same stream would each hold their own
   * transaction open against the same cursor row.
   */
  private stepDown(): void {
    for (const timer of this.leaderIntervals) clearInterval(timer);
    this.leaderIntervals = [];
  }

  private async activeBoards(): Promise<string[]> {
    return this.commands.zrange(KEY_BOARDS, 0, -1).catch(() => [] as string[]);
  }

  private async compactAll(): Promise<void> {
    if (this.compacting) return;
    this.compacting = true;
    try {
      for (const board of await this.activeBoards()) {
        if (!this.isLeader && !this.shuttingDown) break;
        await this.compactBoard(board);
      }
    } catch (error) {
      log.error("compaction failed", { message: (error as Error).message });
    } finally {
      this.compacting = false;
    }
  }

  private async compactBoard(board: string): Promise<void> {
    const from = await this.db.readCursor(board);
    const entries = await this.commands.xrangeBuffer(
      boardStream(board),
      `(${from}`,
      "+",
      "COUNT",
      COMPACT_COUNT,
    );
    if (!entries.length) return;

    const ops: Op[] = [];
    for (const [, fields] of entries) {
      const payload = streamPayload(fields);
      if (!payload) continue;
      try {
        ops.push(decodeOp(payload));
      } catch {
        continue;
      }
    }

    const to = entries[entries.length - 1][0].toString();
    const applied = await this.db.compact(board, from, to, ops);
    if (!applied) {
      log.warn("compaction fenced out", { board, from });
      return;
    }
    await this.trimStream(board, to);
  }

  /** Only ever trims ops the transaction above has already committed. */
  private async trimStream(board: string, committed: string): Promise<void> {
    const retention = `${Date.now() - STREAM_RETAIN_MS}-0`;
    const minid = compareIds(retention, committed) < 0 ? retention : committed;
    await this.commands.xtrim(boardStream(board), "MINID", minid).catch(() => {});
  }

  private async snapshotAll(): Promise<void> {
    if (this.snapshotting) return;
    this.snapshotting = true;
    try {
      for (const board of await this.activeBoards()) {
        if (!this.isLeader) break;
        const strokes = await this.db.writeSnapshot(board);
        await this.db.trimStrokes(board);
        log.info("snapshot written", { board, strokes });
      }
    } catch (error) {
      log.error("snapshot failed", { message: (error as Error).message });
    } finally {
      this.snapshotting = false;
    }
  }

  private async pruneBoards(): Promise<void> {
    const now = Date.now();
    try {
      for (const board of await this.activeBoards()) {
        await this.commands.zremrangebyscore(
          boardPresence(board),
          "-inf",
          now - PRESENCE_TTL_MS,
        );
      }
      await this.commands.zremrangebyscore(KEY_BOARDS, "-inf", now - BOARD_IDLE_MS);
    } catch (error) {
      log.error("presence prune failed", { message: (error as Error).message });
    }
  }

  private reapBoards(): void {
    const cutoff = Date.now() - BOARD_IDLE_MS;
    for (const board of this.boards.values()) {
      if (board.sessions.size || board.hydrating) continue;
      if (board.lastActivity > cutoff) continue;
      this.boards.delete(board.id);
      void this.subscriber.unsubscribe(boardCursorChannel(board.id)).catch(() => {});
      log.info("board retired", { board: board.id });
    }
  }

  private pingSockets(): void {
    for (const session of this.sessions) {
      if (!session.alive) {
        session.socket.terminate();
        continue;
      }
      session.alive = false;
      session.socket.ping();
    }
  }

  /**
   * A socket too far behind to take an op frame cannot be allowed to skip one:
   * it would miss that stroke for good. Closing it is the cheap repair, since
   * reconnecting hands it a fresh snapshot.
   */
  private sendFrame(session: Session, frame: Buffer): void {
    if (session.socket.readyState !== WebSocket.OPEN) return;
    if (session.socket.bufferedAmount > SOCKET_BACKPRESSURE) {
      session.socket.close(1013, "too far behind");
      return;
    }
    session.socket.send(frame, { binary: true });
  }

  private send(session: Session, message: ServerMessage): void {
    if (session.socket.readyState !== WebSocket.OPEN) return;
    session.socket.send(JSON.stringify(message));
  }

  private broadcast(board: BoardRuntime, message: ServerMessage): void {
    if (!board.sessions.size) return;
    const payload = JSON.stringify(message);
    for (const session of board.sessions) {
      if (session.socket.readyState === WebSocket.OPEN) session.socket.send(payload);
    }
  }

  /**
   * The handoff a rolling deploy depends on. Ops reach the stream before the
   * process stops accepting anything, and the lease is handed back explicitly
   * so a successor picks up the durability work in milliseconds rather than
   * waiting out the full lease.
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const timer of this.intervals) clearInterval(timer);
    for (const timer of this.leaderIntervals) clearInterval(timer);
    this.intervals = [];
    this.leaderIntervals = [];

    await Promise.allSettled([...this.inflight]);

    if (this.isLeader) await this.compactAll();
    await this.lease.stop();

    for (const session of this.sessions) {
      session.socket.close(1012, "replica restarting");
      if (session.ready) {
        await this.commands
          .zrem(boardPresence(session.board), presenceMember(session))
          .catch(() => {});
      }
    }
    this.wss?.close();

    await this.commands.zrem(KEY_REPLICAS, env.podId).catch(() => {});
    await Promise.all([
      this.db.close(),
      this.commands.quit().catch(() => {}),
      this.subscriber.quit().catch(() => {}),
      this.publisher.quit().catch(() => {}),
      this.tail.quit().catch(() => {}),
    ]);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clientIp(request: IncomingMessage): string {
  if (env.trustProxy) {
    const forwarded = request.headers["x-forwarded-for"];
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    if (first) return first.split(",")[0].trim();
  }
  return request.socket.remoteAddress || "unknown";
}

function boardOf(request: IncomingMessage): string {
  const url = new URL(request.url || "/", "http://localhost");
  const board = url.searchParams.get("board") || DEFAULT_BOARD;
  return BOARD_ID.test(board) ? board : DEFAULT_BOARD;
}

function boardFromStream(key: string): string {
  return key.slice("wb:b:".length, -":ops".length);
}

function boardFromCursorChannel(channel: string): string {
  return channel.slice("wb:c:".length);
}

function streamPayload(fields: Buffer[]): Buffer | null {
  for (let i = 0; i + 1 < fields.length; i += 2) {
    if (fields[i].toString() === STREAM_FIELD) return fields[i + 1];
  }
  return null;
}

function compareIds(left: string, right: string): number {
  const [leftMs, leftSeq] = left.split("-");
  const [rightMs, rightSeq] = right.split("-");
  const ms = Number(leftMs) - Number(rightMs);
  if (ms !== 0) return ms;
  return Number(leftSeq || 0) - Number(rightSeq || 0);
}

function decodeSnapshot(payload: Buffer): StoredStroke[] | null {
  const copy = new Uint8Array(payload.byteLength);
  copy.set(payload);
  const frame = decodeFrame(copy.buffer);
  if (!frame || frame.kind !== FRAME_SNAPSHOT) return null;
  return frame.strokes.map((stroke) => ({ ...stroke, deleted: false }));
}

function presenceMember(session: Session): string {
  return `${session.author}:${session.color}:${session.name}`;
}

function parsePresence(member: string): Person | null {
  const first = member.indexOf(":");
  const second = member.indexOf(":", first + 1);
  if (first < 0 || second < 0) return null;
  const author = Number(member.slice(0, first));
  const color = Number(member.slice(first + 1, second));
  if (!Number.isInteger(author) || !Number.isInteger(color)) return null;
  return { author, color, name: member.slice(second + 1) };
}

function parseIdentity(raw: string | null): { a: number; n: string; c: number } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { a?: unknown; n?: unknown; c?: unknown };
    if (!Number.isInteger(parsed.a) || !(parsed.a as number)) return null;
    return {
      a: parsed.a as number,
      n: typeof parsed.n === "string" ? parsed.n : randomName(),
      c: isColor(parsed.c) ? (parsed.c as number) : 0,
    };
  } catch {
    return null;
  }
}

function isColor(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) < COLOR_COUNT;
}

function coordinate(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function strokeId(value: unknown): number | null {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 0xffffffff) return null;
  return number >>> 0;
}
