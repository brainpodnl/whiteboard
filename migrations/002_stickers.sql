-- Stickers share the strokes table with ink: same id space, same z-order, same
-- erase and restore. `kind` is the only thing that tells a reader which one a
-- row is, and 0 is ink, so every row written before this migration is correct
-- without being rewritten.
alter table strokes
  add column if not exists kind smallint not null default 0;
