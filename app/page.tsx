import Whiteboard from "@/components/Whiteboard";
import { DEFAULT_BOARD } from "@/shared/constants";

export default function Page() {
  return <Whiteboard board={DEFAULT_BOARD} />;
}
