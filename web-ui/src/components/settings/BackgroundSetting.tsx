import { useSyncExternalStore } from "react";
import { Picker } from "@/components/background/Picker";
import { getBackgroundStore } from "@/components/background/backgroundStore";
import { VisibilitySection } from "@/components/background/VisibilitySection";
import { SectionHeader } from "./SectionHeader";
import { SettingsRow } from "./SettingsRow";
import "./backgroundSetting.css";

/**
 * Settings › Background. The picker owns the image/texture choices; this panel
 * adds the two device-level switches (per-agent wallpapers, visibility) that
 * the picker deliberately does not carry.
 */

/**
 * The per-agent switch. The drawn track keeps the design's 36×20
 * (`BackgroundDialog.dc.html` `st-switch`); the button itself is the hit area,
 * so a phone gets 44px of tappable height without a bigger drawn track (CUJ7).
 */
function OwnWallpaperToggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label="Own wallpaper per agent"
      className="bg-own-switch"
      onClick={() => onChange(!checked)}
    >
      <span aria-hidden className="bg-own-switch__track">
        <span className="bg-own-switch__knob" />
      </span>
    </button>
  );
}

export function BackgroundSetting() {
  const store = getBackgroundStore();
  const prefs = useSyncExternalStore(store.subscribe, store.getState, store.getState);

  return (
    <div className="bg-setting">
      <SectionHeader
        title="Background"
        description="Solid, or one wallpaper behind the whole window with a texture over it."
      />

      <Picker mode="app" pickLabel="Picked at first run" />

      <SettingsRow
        label="Own wallpaper per agent"
        description={
          prefs.agentWallpapers
            ? "Each new agent gets a random wallpaper and keeps it in its worktree."
            : "Agents use the app background."
        }
        control={
          <OwnWallpaperToggle
            checked={prefs.agentWallpapers}
            onChange={(v) => store.patch({ agentWallpapers: v })}
          />
        }
      />

      <p className="settings-help">
        For one worktree or project, open its options menu and choose Wallpaper.
      </p>

      <VisibilitySection />
    </div>
  );
}
