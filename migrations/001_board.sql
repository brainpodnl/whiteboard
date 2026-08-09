create table if not exists boards (
  id          text primary key,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists strokes (
  board_id    text   not null,
  stroke_id   bigint not null,
  author      int    not null,
  color       smallint not null,
  width       smallint not null,
  points      bytea  not null,
  complete    boolean not null default false,
  deleted     boolean not null default false,
  seq         bigserial not null,
  created_at  timestamptz not null default now(),
  primary key (board_id, stroke_id)
);

create index if not exists strokes_board_live_idx
  on strokes (board_id, seq) where not deleted;

-- How far the leader has drained a board's Valkey op log. Advanced in the same
-- transaction as the stroke rows it covers, so a leader that dies mid-compaction
-- has its successor resume from the last committed op rather than skipping one.
create table if not exists board_cursor (
  board_id    text primary key,
  last_op_id  text not null,
  updated_at  timestamptz not null default now()
);

-- The leader's periodic pack of a whole board, so a replica hydrates a board
-- with one row read and a short stream replay instead of a full table scan.
create table if not exists board_snapshots (
  board_id    text primary key,
  last_op_id  text not null,
  strokes     int  not null,
  payload     bytea not null,
  updated_at  timestamptz not null default now()
);
