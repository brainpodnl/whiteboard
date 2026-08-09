/**
 * One fixed board for everyone. There is no pan or zoom: what you draw lands in
 * the same place on every screen in the room, which is the whole point of the
 * demo. The canvas fills the viewport with this rectangle, cropping whichever
 * axis does not match rather than leaving a letterbox.
 */
export const WORLD_W = 3840;
export const WORLD_H = 2160;

export const DEFAULT_BOARD = "lobby";
export const BOARD_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Replicas coalesce inbound ops and push them to their sockets at this rate. */
export const FANOUT_HZ = 20;
export const FANOUT_MS = 1000 / FANOUT_HZ;

/** Cursors are lossy by design, so they ride their own channel at the same rate. */
export const CURSOR_HZ = 20;
export const CURSOR_MS = 1000 / CURSOR_HZ;

/** The client batches pointer samples for this long before sending them up. */
export const POINT_FLUSH_MS = 40;

export const MAX_POINTS_PER_STROKE = 4000;
export const MAX_POINTS_PER_MESSAGE = 256;
export const MAX_STROKES_PER_BOARD = 20_000;

export const COLOR_COUNT = 8;
export const WIDTHS = [3, 6, 12, 26] as const;

/**
 * Stickers are applause, not annotation: the set is deliberately all-positive so
 * dropping one on someone's work can only ever read as encouragement.
 */
export const STICKERS = ["👍", "🎉", "❤️", "⭐", "🔥", "🙌", "✅", "💯"] as const;

/** World units across, indexed by the same control that picks a stroke width. */
export const STICKER_SIZES = [96, 144, 208, 300] as const;

export const KIND_INK = 0;
export const KIND_STICKER = 1;

export const OP_BEGIN = 1;
export const OP_POINTS = 2;
export const OP_END = 3;
export const OP_DELETE = 4;
export const OP_RESTORE = 5;
export const OP_STAMP = 6;

export const FRAME_SNAPSHOT = 1;
export const FRAME_OPS = 2;
export const FRAME_CURSORS = 3;

export const CURSOR_FLAG_DRAWING = 1;

export const KEY_LEADER = "wb:leader";
export const KEY_REPLICAS = "wb:replicas";
export const KEY_BOARDS = "wb:boards";

export const boardStream = (board: string) => `wb:b:${board}:ops`;
export const boardStrokeSeq = (board: string) => `wb:b:${board}:strokeseq`;
export const boardAuthorSeq = (board: string) => `wb:b:${board}:authorseq`;
export const boardAuthorMap = (board: string) => `wb:b:${board}:authors`;
export const boardPresence = (board: string) => `wb:b:${board}:presence`;
export const boardCursorChannel = (board: string) => `wb:c:${board}`;

export const LEASE_MS = 1500;
export const LEASE_RENEW_MS = 500;

/** How often the leader drains the Valkey op log into Postgres. */
export const COMPACT_MS = 750;
/** How often the leader rewrites a board's packed snapshot row. */
export const SNAPSHOT_MS = 15_000;
/**
 * Ops stay in the stream well past compaction: a replica that reconnects to
 * Valkey resumes from its own cursor, and only falls back to a Postgres reload
 * if it has fallen further behind than this.
 */
export const STREAM_RETAIN_MS = 120_000;

export const PRESENCE_TTL_MS = 8000;
export const PRESENCE_BEAT_MS = 2500;
export const REPLICA_TTL_MS = 6000;
export const REPLICA_BEAT_MS = 2000;

/** A board with no ops and no presence for this long stops being tailed. */
export const BOARD_IDLE_MS = 300_000;

export const MAX_NAME_LENGTH = 18;
