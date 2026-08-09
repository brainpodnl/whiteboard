import {
  CURSOR_MS,
  FRAME_CURSORS,
  FRAME_OPS,
  FRAME_SNAPSHOT,
  MAX_POINTS_PER_MESSAGE,
  OP_BEGIN,
  OP_END,
  OP_POINTS,
  OP_STAMP,
  POINT_FLUSH_MS,
} from "@/shared/constants";
import {
  decodeFrame,
  strokeAuthor,
  type ClientMessage,
  type CursorWire,
  type Op,
  type Person,
  type ServerMessage,
  type Stroke,
} from "@/shared/protocol";

export type Connection = "connecting" | "online" | "offline";

export type HudState = {
  connection: Connection;
  rtt: number;
  region: string;
  replica: number;
  replicas: number;
  leader: boolean;
  release: string;
  pod: string;
};

export type NetHandlers = {
  onWelcome: (author: number) => void;
  onSnapshot: (strokes: Stroke[]) => void;
  onOps: (ops: Op[]) => void;
  onCursors: (cursors: CursorWire[]) => void;
  onPresence: (people: Person[]) => void;
  onHud: (hud: HudState) => void;
  onRejected: (reason: string) => void;
};

export type Identity = { session: string; name: string; color: number };

/**
 * A stroke the local user is drawing or has just finished, held until the
 * server has echoed every one of its points back. `sent` is optimistic and
 * rewinds to `acked` on a new socket; `acked` only ever advances on an echo,
 * so a batch lost with a dying replica is re-sent rather than assumed landed.
 */
type Pending = {
  /** A sticker: one message, no points and no end, but the same replay rules. */
  stamp: boolean;
  color: number;
  width: number;
  pts: number[];
  sent: number;
  acked: number;
  beginSent: boolean;
  beginAcked: boolean;
  ended: boolean;
  endSent: boolean;
  endAcked: boolean;
};

const PING_MS = 2000;
const RECONNECT_MIN_MS = 200;
const RECONNECT_MAX_MS = 2000;

export class Net {
  private socket: WebSocket | null = null;
  private pending = new Map<number, Pending>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private closed = false;

  private authorId = 0;
  private cursorPending: { x: number; y: number; drawing: boolean } | null = null;
  private cursorSentAt = 0;

  private hud: HudState = {
    connection: "connecting",
    rtt: 0,
    region: "",
    replica: 1,
    replicas: 1,
    leader: false,
    release: "",
    pod: "",
  };

  constructor(
    private readonly board: string,
    private readonly identity: Identity,
    private readonly handlers: NetHandlers,
  ) {}

  get author(): number {
    return this.authorId;
  }

  connect(): void {
    this.closed = false;
    this.open();
    this.timers.push(
      setInterval(() => this.flush(), POINT_FLUSH_MS),
      setInterval(() => this.flushCursor(), CURSOR_MS),
      setInterval(() => this.ping(), PING_MS),
    );
  }

  close(): void {
    this.closed = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close();
    this.socket = null;
  }

  begin(stroke: number, color: number, width: number, x: number, y: number): void {
    this.pending.set(stroke, {
      stamp: false,
      color,
      width,
      pts: [x, y],
      sent: 0,
      acked: 0,
      beginSent: false,
      beginAcked: false,
      ended: false,
      endSent: false,
      endAcked: false,
    });
    this.flush();
  }

  stamp(stroke: number, sticker: number, size: number, x: number, y: number): void {
    this.pending.set(stroke, {
      stamp: true,
      color: sticker,
      width: size,
      pts: [x, y],
      sent: 1,
      acked: 1,
      beginSent: false,
      beginAcked: false,
      ended: true,
      endSent: true,
      endAcked: false,
    });
    this.flush();
  }

  points(stroke: number, pts: number[]): void {
    const entry = this.pending.get(stroke);
    if (!entry || entry.ended) return;
    for (const value of pts) entry.pts.push(value);
  }

  end(stroke: number): void {
    const entry = this.pending.get(stroke);
    if (!entry) return;
    entry.ended = true;
    this.flush();
  }

  erase(strokes: number[]): void {
    if (strokes.length) this.send({ t: "erase", strokes });
  }

  restore(strokes: number[]): void {
    if (strokes.length) this.send({ t: "restore", strokes });
  }

  cursor(x: number, y: number, drawing: boolean): void {
    this.cursorPending = { x, y, drawing };
  }

  private url(): string {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${location.host}/ws?board=${encodeURIComponent(this.board)}`;
  }

  private open(): void {
    this.setHud({ connection: this.attempt === 0 ? "connecting" : this.hud.connection });

    const socket = new WebSocket(this.url());
    socket.binaryType = "arraybuffer";
    this.socket = socket;

    socket.onopen = () => {
      this.attempt = 0;
      this.setHud({ connection: "online" });
      this.send({
        t: "hello",
        session: this.identity.session,
        name: this.identity.name,
        color: this.identity.color,
      });
      this.rewind();
      this.flush();
    };

    socket.onmessage = (event) => {
      if (typeof event.data === "string") this.onControl(event.data);
      else this.onFrame(event.data as ArrayBuffer);
    };

    socket.onclose = () => {
      if (this.socket === socket) this.socket = null;
      if (this.closed) return;
      this.setHud({ connection: "offline" });
      this.scheduleReconnect();
    };

    socket.onerror = () => socket.close();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const backoff = Math.min(RECONNECT_MIN_MS * 2 ** this.attempt, RECONNECT_MAX_MS);
    this.attempt++;
    this.reconnectTimer = setTimeout(
      () => {
        this.reconnectTimer = null;
        if (!this.closed) this.open();
      },
      backoff + Math.random() * 100,
    );
  }

  /** A new socket has to assume nothing it sent on the old one arrived. */
  private rewind(): void {
    for (const entry of this.pending.values()) {
      entry.sent = entry.acked;
      entry.beginSent = entry.beginAcked;
      entry.endSent = entry.endAcked;
    }
  }

  private flush(): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;

    for (const [stroke, entry] of this.pending) {
      if (!entry.beginSent) {
        this.send(
          entry.stamp
            ? {
                t: "stamp",
                stroke,
                sticker: entry.color,
                size: entry.width,
                x: entry.pts[0],
                y: entry.pts[1],
              }
            : {
                t: "begin",
                stroke,
                color: entry.color,
                width: entry.width,
                x: entry.pts[0],
                y: entry.pts[1],
              },
        );
        entry.beginSent = true;
        if (entry.sent < 1) entry.sent = 1;
      }

      if (entry.stamp) continue;

      const total = entry.pts.length >> 1;
      while (entry.sent < total) {
        const count = Math.min(MAX_POINTS_PER_MESSAGE, total - entry.sent);
        this.send({
          t: "pts",
          stroke,
          from: entry.sent,
          p: entry.pts.slice(entry.sent * 2, (entry.sent + count) * 2),
        });
        entry.sent += count;
      }

      if (entry.ended && !entry.endSent && entry.sent >= total) {
        this.send({ t: "end", stroke });
        entry.endSent = true;
      }
    }
  }

  private flushCursor(): void {
    const next = this.cursorPending;
    if (!next) return;
    const now = Date.now();
    if (now - this.cursorSentAt < CURSOR_MS) return;
    this.cursorSentAt = now;
    this.cursorPending = null;
    this.send({ t: "cursor", x: next.x, y: next.y, drawing: next.drawing });
  }

  private ping(): void {
    this.send({ t: "ping", c: Date.now() });
  }

  private send(message: ClientMessage): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(message));
  }

  private onControl(raw: string): void {
    let message: ServerMessage;
    try {
      message = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }

    switch (message.t) {
      case "welcome":
        this.authorId = message.author;
        this.setHud({
          pod: message.pod,
          replica: message.replica,
          replicas: message.replicas,
          leader: message.leader,
          release: message.release,
          region: message.region,
          connection: "online",
        });
        this.handlers.onWelcome(message.author);
        return;
      case "meta":
        this.setHud({
          replica: message.replica,
          replicas: message.replicas,
          leader: message.leader,
        });
        return;
      case "presence":
        this.handlers.onPresence(message.people);
        return;
      case "pong":
        this.setHud({ rtt: Math.max(0, Date.now() - message.c) });
        return;
      case "rejected":
        this.handlers.onRejected(message.reason);
        return;
    }
  }

  private onFrame(data: ArrayBuffer): void {
    const frame = decodeFrame(data);
    if (!frame) return;

    if (frame.kind === FRAME_OPS) {
      this.observe(frame.ops);
      this.handlers.onOps(frame.ops);
      return;
    }

    if (frame.kind === FRAME_SNAPSHOT) {
      this.reconcile(frame.strokes);
      this.handlers.onSnapshot(frame.strokes);
      return;
    }

    if (frame.kind === FRAME_CURSORS) {
      this.handlers.onCursors(frame.cursors);
    }
  }

  /** Our own ops coming back are the only proof the server has them. */
  private observe(ops: Op[]): void {
    for (const op of ops) {
      if (strokeAuthor(op.stroke) !== this.authorId) continue;
      const entry = this.pending.get(op.stroke);
      if (!entry) continue;

      if (op.t === OP_STAMP) {
        entry.beginAcked = true;
        entry.endAcked = true;
        entry.acked = 1;
      } else if (op.t === OP_BEGIN) {
        entry.beginAcked = true;
        if (entry.acked < 1) entry.acked = 1;
      } else if (op.t === OP_POINTS) {
        entry.acked = Math.max(entry.acked, op.from + (op.pts.length >> 1));
      } else if (op.t === OP_END) {
        entry.endAcked = true;
      }
      this.retire(op.stroke, entry);
    }
  }

  private reconcile(strokes: Stroke[]): void {
    for (const stroke of strokes) {
      const entry = this.pending.get(stroke.id);
      if (!entry) continue;
      entry.beginAcked = true;
      entry.acked = Math.max(entry.acked, stroke.pts.length >> 1);
      if (stroke.complete) entry.endAcked = true;
      this.retire(stroke.id, entry);
    }
  }

  private retire(stroke: number, entry: Pending): void {
    if (entry.endAcked && entry.acked >= entry.pts.length >> 1) {
      this.pending.delete(stroke);
    }
  }

  private setHud(patch: Partial<HudState>): void {
    this.hud = { ...this.hud, ...patch };
    this.handlers.onHud(this.hud);
  }
}
