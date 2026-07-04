import { Smartphone } from "lucide-react";
import { ToolPlaceholder } from "./ToolPlaceholder";

/**
 * Placeholder for the device/emulator screen. Real implementation will stream a
 * connected Android emulator or physical device attached to the server.
 */
export function EmulatorPanel() {
  return (
    <ToolPlaceholder
      icon={<Smartphone size={28} />}
      title="Emulator / Device"
      description="Watch a live Android emulator or a device connected to the server. The agent will stream the screen here while it builds and tests on-device."
    />
  );
}
