"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Canvas, { type Tool } from "@/components/Canvas";
import Entry from "@/components/Entry";
import { BrainpodMark } from "@/components/Marks";
import Presence from "@/components/Presence";
import StatusBadge from "@/components/StatusBadge";
import Toolbar from "@/components/Toolbar";
import { Board, type Intent } from "@/lib/board";
import { Net, type HudState } from "@/lib/net";
import type { RemoteCursor, Renderer } from "@/lib/render";
import { COLOR_COUNT } from "@/shared/constants";
import { randomName, sanitizeName } from "@/shared/names";
import type { Person } from "@/shared/protocol";

type Identity = { session: string; name: string; color: number };

const IDLE_HUD: HudState = {
  connection: "connecting",
  rtt: 0,
  region: "",
  replica: 1,
  replicas: 1,
  leader: false,
  release: "",
  pod: "",
};

const NO_CURSORS: RemoteCursor[] = [];

export default function Whiteboard({ board: name }: { board: string }) {
  const board = useMemo(() => new Board(), []);
  const rendererRef = useRef<Renderer | null>(null);
  const cursorsRef = useRef<RemoteCursor[]>(NO_CURSORS);
  const netRef = useRef<Net | null>(null);
  const peopleRef = useRef<Person[]>([]);

  const [identity, setIdentity] = useState<Identity | null>(null);
  const [net, setNet] = useState<Net | null>(null);
  const [joined, setJoined] = useState(false);
  const [author, setAuthor] = useState(0);
  const [people, setPeople] = useState<Person[]>([]);
  const [hud, setHud] = useState<HudState>(IDLE_HUD);
  const [notice, setNotice] = useState<string | null>(null);

  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState(0);
  const [width, setWidth] = useState(1);
  const [sticker, setSticker] = useState(0);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  useEffect(() => {
    setIdentity(loadIdentity());
  }, []);

  useEffect(() => {
    if (identity) setColor(identity.color);
  }, [identity]);

  useEffect(() => {
    if (!identity) return;

    const socket = new Net(name, identity, {
      onWelcome: (self) => setAuthor(self),
      onSnapshot: (strokes) => {
        board.snapshot(strokes);
        rendererRef.current?.setStrokes(board.strokes());
      },
      onOps: (ops) => {
        const renderer = rendererRef.current;
        const changes = board.apply(ops);
        if (!renderer || !changes.length) return;

        if (changes.some((change) => change.kind === "rebake")) {
          renderer.setStrokes(board.strokes());
          return;
        }

        for (const change of changes) {
          if (change.kind === "begin") renderer.begin(change.stroke);
          else if (change.kind === "points") renderer.extend(change.stroke);
          else if (change.kind === "end") renderer.end(change.stroke);
          else if (change.kind === "stamp") renderer.stamp(change.stroke);
        }
      },
      onCursors: (cursors) => {
        cursorsRef.current = cursors
          .filter((cursor) => cursor.author !== socket.author)
          .map((cursor) => ({
            author: cursor.author,
            x: cursor.x,
            y: cursor.y,
            color: cursor.color,
            drawing: cursor.drawing,
            name:
              peopleRef.current.find((person) => person.author === cursor.author)
                ?.name ?? "",
          }));
      },
      onPresence: (list) => {
        peopleRef.current = list;
        setPeople(list);
      },
      onHud: setHud,
      onRejected: setNotice,
    });

    netRef.current = socket;
    setNet(socket);
    socket.connect();

    return () => {
      socket.close();
      netRef.current = null;
      cursorsRef.current = NO_CURSORS;
    };
  }, [board, identity, name]);

  const syncHistory = useCallback(() => {
    setCanUndo(board.canUndo);
    setCanRedo(board.canRedo);
  }, [board]);

  const send = useCallback((intent: Intent) => {
    const socket = netRef.current;
    if (!socket) return;
    if (intent.kind === "erase") socket.erase(intent.strokes);
    else socket.restore(intent.strokes);
  }, []);

  const undo = useCallback(() => {
    const intent = board.undo();
    if (!intent) return;
    send(intent);
    rendererRef.current?.setStrokes(board.strokes());
    syncHistory();
  }, [board, send, syncHistory]);

  const redo = useCallback(() => {
    const intent = board.redo();
    if (!intent) return;
    send(intent);
    rendererRef.current?.setStrokes(board.strokes());
    syncHistory();
  }, [board, send, syncHistory]);

  const onReady = useCallback(
    (renderer: Renderer) => renderer.setStrokes(board.strokes()),
    [board],
  );

  const start = useCallback((chosen: string, swatch: number) => {
    const next = { session: sessionId(), name: sanitizeName(chosen), color: swatch };
    saveIdentity(next);
    setIdentity((current) =>
      current && current.name === next.name && current.color === next.color
        ? current
        : next,
    );
    setColor(swatch);
    setJoined(true);
  }, []);

  return (
    <main className="relative h-full w-full">
      <Canvas
        board={board}
        net={net}
        rendererRef={rendererRef}
        cursorsRef={cursorsRef}
        tool={tool}
        color={color}
        width={width}
        sticker={sticker}
        enabled={joined && author !== 0}
        onReady={onReady}
        onHistory={syncHistory}
      />

      <header className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between gap-3 p-3 sm:p-4">
        <a
          href="https://brainpod.io"
          target="_blank"
          rel="noreferrer"
          className="pointer-events-auto flex items-center gap-2.5 rounded-full border border-edge bg-hull/80 py-1.5 pr-4 pl-3 backdrop-blur-sm"
        >
          <BrainpodMark className="h-3.5 w-auto text-bone" />
          <span className="hud-label">{name}</span>
        </a>

        {joined ? (
          <Presence people={people} self={author} className="pointer-events-auto" />
        ) : null}
      </header>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex flex-col items-center gap-2.5 p-3 sm:p-4">
        {notice ? (
          <p className="pointer-events-auto rounded-full border border-ember/30 bg-ember/10 px-3 py-1.5 text-note text-ember">
            {notice}
          </p>
        ) : null}

        {joined ? (
          <Toolbar
            tool={tool}
            color={color}
            width={width}
            sticker={sticker}
            canUndo={canUndo}
            canRedo={canRedo}
            onTool={setTool}
            onColor={setColor}
            onWidth={setWidth}
            onSticker={setSticker}
            onUndo={undo}
            onRedo={redo}
            className="pointer-events-auto"
          />
        ) : null}

        <div className="flex w-full items-end justify-between gap-3">
          <StatusBadge hud={hud} className="pointer-events-auto" />
          <p className="hud-label hidden lg:block">
            P pen · E eraser · S sticker · 1–8 pick · ⌘Z undo
          </p>
        </div>
      </div>

      {identity && !joined ? (
        <Entry name={identity.name} color={identity.color} onStart={start} />
      ) : null}
    </main>
  );
}

const SESSION_KEY = "wb:session";
const NAME_KEY = "wb:name";
const COLOR_KEY = "wb:color";

/**
 * Held in sessionStorage rather than memory so a socket that comes back after a
 * replica disappears reintroduces the same person, with the same colour.
 */
function sessionId(): string {
  const stored = sessionStorage.getItem(SESSION_KEY);
  if (stored) return stored;
  const minted = crypto.randomUUID();
  sessionStorage.setItem(SESSION_KEY, minted);
  return minted;
}

function loadIdentity(): Identity {
  const stored = Number(sessionStorage.getItem(COLOR_KEY));
  return {
    session: sessionId(),
    name: sessionStorage.getItem(NAME_KEY) || randomName(),
    color:
      Number.isInteger(stored) && stored >= 0 && stored < COLOR_COUNT
        ? stored
        : Math.floor(Math.random() * COLOR_COUNT),
  };
}

function saveIdentity(identity: Identity): void {
  sessionStorage.setItem(NAME_KEY, identity.name);
  sessionStorage.setItem(COLOR_KEY, String(identity.color));
}
