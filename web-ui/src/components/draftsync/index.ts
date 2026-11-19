export {
  DRAFT_TEXT_DEBOUNCE_MS,
  MAX_DRAFT_TEXT_BYTES,
  KEEPALIVE_MAX_BYTES,
  GLOBAL_NEW_SCOPE,
  pickerScope,
  scheduleScope,
} from "./constants";
export { getClientId } from "./clientId";
export { decideRemote, onOwnAck } from "./reconcile";
export type { ScopeState } from "./reconcile";
export { ensureDraftTextSync, appendDraftText, setDraftText } from "./engine";
export type { DraftBinding } from "./engine";
export { useDraftText } from "./useDraftText";
