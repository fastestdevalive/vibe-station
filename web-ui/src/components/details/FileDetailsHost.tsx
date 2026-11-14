import type { ApiInstance } from "@/api";
import { FileDetailsDialog } from "./FileDetailsDialog";
import { useDetailsStore } from "./detailsStore";

/** Mounted once in ToolPanel (tools-pane-rework B7.3): renders whatever `detailsStore` holds. */
export function FileDetailsHost({ api }: { api: ApiInstance }) {
  const target = useDetailsStore((s) => s.target);
  const close = useDetailsStore((s) => s.close);
  if (!target) return null;
  return <FileDetailsDialog api={api} target={target} onClose={close} />;
}
