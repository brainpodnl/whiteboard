import { notFound } from "next/navigation";
import Whiteboard from "@/components/Whiteboard";
import { BOARD_ID } from "@/shared/constants";

export default async function Page({
  params,
}: {
  params: Promise<{ board: string }>;
}) {
  const { board } = await params;
  if (!BOARD_ID.test(board)) notFound();
  return <Whiteboard board={board} />;
}
