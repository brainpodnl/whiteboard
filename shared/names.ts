import { MAX_NAME_LENGTH } from "./constants";

const ADJECTIVES = [
  "brisk", "calm", "keen", "lucid", "quiet", "swift", "warm", "bright",
  "steady", "clever", "plain", "sharp",
];

const NOUNS = [
  "otter", "heron", "marten", "finch", "lynx", "hare", "raven", "vole",
  "swift", "pika", "shrike", "ibis",
];

export function randomName(): string {
  const adjective = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${adjective} ${noun}`;
}

export function sanitizeName(raw: unknown): string {
  if (typeof raw !== "string") return randomName();
  const cleaned = [...raw]
    .filter((char) => (char.codePointAt(0) ?? 0) >= 0x20)
    .join("")
    .trim()
    .slice(0, MAX_NAME_LENGTH);
  return cleaned || randomName();
}
