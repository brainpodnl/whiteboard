export const PALETTE = {
  void: "#0c0b09",
  bone: "#fbfaf8",
  ash: "#6b6660",
  faint: "#a19b92",
  beam: "#4d7dff",
  teal: "#26aca9",
  ember: "#d4614c",
  gold: "#e0b64a",
  edge: "#2d2a25",
} as const;

/** Identity and pen colour in one. Ordered so consecutive joiners land on
 *  opposite sides of the wheel, and light enough that a 3px stroke still
 *  reads against the void. */
export const USER_COLORS: readonly string[] = [
  "#4d7dff",
  "#e0b64a",
  "#5fd08a",
  "#e88ab5",
  "#9fd44e",
  "#b07ce8",
  "#7fd6f0",
  "#f0906a",
];

export function userColor(index: number): string {
  const count = USER_COLORS.length;
  if (!Number.isFinite(index)) return USER_COLORS[0];
  return USER_COLORS[((Math.trunc(index) % count) + count) % count];
}
