import { useState } from "react";
import { Globe, Plus, Smartphone } from "lucide-react";
import { BrowserPanel } from "./BrowserPanel";
import { EmulatorPanel } from "./EmulatorPanel";

/**
 * Devices tool — hosts the web browser and connected emulators/devices as
 * sub-tabs (one live view at a time). "Web" is always present; device entries
 * come from the server once device streaming lands. Sub-tabs + bodies are
 * placeholders for now.
 */
type DeviceTab = { id: string; label: string; kind: "web" | "device" };

const PLACEHOLDER_TABS: DeviceTab[] = [
  { id: "web", label: "Web", kind: "web" },
  // Sample device entry — replaced by real connected devices later.
  { id: "emulator", label: "Emulator", kind: "device" },
];

export function DevicesPanel() {
  const [active, setActive] = useState<string>("web");
  const tabs = PLACEHOLDER_TABS;
  const current = tabs.find((t) => t.id === active) ?? tabs[0]!;

  return (
    <div className="devices-panel">
      <div className="devices-panel__tabs" role="tablist" aria-label="Devices">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={t.id === active}
            data-active={t.id === active}
            className="devices-tab"
            onClick={() => setActive(t.id)}
          >
            {t.kind === "web" ? <Globe size={13} aria-hidden /> : <Smartphone size={13} aria-hidden />}
            <span>{t.label}</span>
          </button>
        ))}
        <button type="button" className="devices-tab devices-tab--add" aria-label="Connect device" disabled title="Connect a device (coming soon)">
          <Plus size={13} aria-hidden />
        </button>
      </div>
      <div className="devices-panel__body">
        {current.kind === "web" ? <BrowserPanel /> : <EmulatorPanel />}
      </div>
    </div>
  );
}
