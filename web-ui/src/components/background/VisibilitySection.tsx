import { useSyncExternalStore } from "react";
import { CollapsibleSection } from "@/components/background/CollapsibleSection";
import { getBackgroundStore } from "./backgroundStore";
import {
  CHROME_TRANSPARENCY,
  opacityFromTransparency,
  transparencyFromOpacity,
} from "./chromeTransparency";
import "./visibilitySection.css";

/**
 * Settings › Background › Visibility: the three global sliders (empty chats,
 * running sessions, sidebar-and-bars transparency; stored as opacity, see chromeTransparency.ts).
 * They are device preferences, so they live in `backgroundStore` and apply to
 * every scope — only the image is per scope.
 *
 * The disclosure state is the store's own `sections.visibility`, read and
 * written here directly (the Picker's `usePickerSections` covers its own two
 * sections; importing it would tie this section to the Picker's lifecycle).
 */

interface SliderRowProps {
  id: string;
  label: string;
  description: string;
  /** Whole percent, already converted from storage by the caller. */
  percent: number;
  min: number;
  max: number;
  step: number;
  valueText: string;
  onPercentChange: (percent: number) => void;
}

function SliderRow({ id, label, description, percent, min, max, step, valueText, onPercentChange }: SliderRowProps) {
  return (
    <div className="bg-vis__row">
      <div className="bg-vis__main">
        <label className="bg-vis__label" htmlFor={id}>
          {label}
        </label>
        <div className="bg-vis__desc">{description}</div>
      </div>
      <div className="bg-vis__control">
        <input
          id={id}
          className="bg-vis__range"
          type="range"
          min={min}
          max={max}
          step={step}
          value={percent}
          aria-label={label}
          aria-valuetext={valueText}
          onChange={(e) => onPercentChange(Number(e.target.value))}
        />
        <span className="bg-vis__value">{percent}%</span>
      </div>
    </div>
  );
}

export function VisibilitySection() {
  const store = getBackgroundStore();
  const prefs = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const open = prefs.sections.visibility;

  const empty = Math.round(prefs.emptyVisibility * 100);
  const sessions = Math.round(prefs.sessionVisibility * 100);
  const chromeTransparency = transparencyFromOpacity(prefs.chromeOpacity);

  return (
    <CollapsibleSection
      id="bg-visibility"
      title="Visibility"
      summary={`Empty chats ${empty}% · Sessions ${sessions}% · Bars ${chromeTransparency}% transparent`}
      open={open}
      onToggle={() => store.setSection("visibility", !open)}
    >
      <SliderRow
        id="bg-vis-empty"
        label="Empty chats"
        description="New drafts and the empty view."
        percent={empty}
        min={20}
        max={100}
        step={5}
        valueText={`${empty}%`}
        onPercentChange={(p) => store.patch({ emptyVisibility: p / 100 })}
      />
      <SliderRow
        id="bg-vis-sessions"
        label="Sessions"
        description="Behind a running conversation. Lower keeps long transcripts easy to read."
        percent={sessions}
        min={10}
        max={100}
        step={5}
        valueText={`${sessions}%`}
        onPercentChange={(p) => store.patch({ sessionVisibility: p / 100 })}
      />
      <SliderRow
        id="bg-vis-chrome"
        label="Sidebar and bars transparency"
        description="Sidebar, tab strip and status bar. 0% hides the wallpaper behind them."
        min={CHROME_TRANSPARENCY.min}
        max={CHROME_TRANSPARENCY.max}
        step={CHROME_TRANSPARENCY.step}
        percent={chromeTransparency}
        valueText={`${chromeTransparency}% transparent`}
        onPercentChange={(p) => store.patch({ chromeOpacity: opacityFromTransparency(p) })}
      />
    </CollapsibleSection>
  );
}
