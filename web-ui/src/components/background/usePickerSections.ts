import { useState, useSyncExternalStore } from "react";
import { getBackgroundStore } from "./backgroundStore";

export interface PickerSection {
  open: boolean;
  toggle: () => void;
}

export interface PickerSections {
  wallpaper: PickerSection;
  texture: PickerSection;
  gradient: PickerSection;
}

/**
 * Disclosure state for the Picker's Wallpaper/Texture/Gradient sections.
 *
 * Settings (no `initialOpen`) reads and writes `store.sections`, so the open /
 * closed state is remembered per device. Onboarding passes `initialOpen`: it
 * gets local state instead, so opening Wallpaper there never overwrites what
 * Settings remembers.
 */
export function usePickerSections(initialOpen?: {
  wallpaper?: boolean;
  texture?: boolean;
  gradient?: boolean;
}): PickerSections {
  const store = getBackgroundStore();
  const prefs = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const [local, setLocal] = useState(() => ({
    wallpaper: initialOpen?.wallpaper === true,
    texture: initialOpen?.texture === true,
    gradient: initialOpen?.gradient === true,
  }));

  if (initialOpen !== undefined) {
    return {
      wallpaper: {
        open: local.wallpaper,
        toggle: () => setLocal((s) => ({ ...s, wallpaper: !s.wallpaper })),
      },
      texture: {
        open: local.texture,
        toggle: () => setLocal((s) => ({ ...s, texture: !s.texture })),
      },
      gradient: {
        open: local.gradient,
        toggle: () => setLocal((s) => ({ ...s, gradient: !s.gradient })),
      },
    };
  }

  return {
    wallpaper: {
      open: prefs.sections.wallpaper,
      toggle: () => store.setSection("wallpaper", !prefs.sections.wallpaper),
    },
    texture: {
      open: prefs.sections.texture,
      toggle: () => store.setSection("texture", !prefs.sections.texture),
    },
    gradient: {
      open: prefs.sections.gradient,
      toggle: () => store.setSection("gradient", !prefs.sections.gradient),
    },
  };
}
