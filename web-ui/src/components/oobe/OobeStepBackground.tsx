import { Picker } from "@/components/background/Picker";
import { useIsMobile } from "@/hooks/useIsMobile";

/**
 * Onboarding step 3 of 4: the first-run background. The picker itself owns every
 * write ("Picked for you" chip + Shuffle come from it); Skip and Continue both
 * advance, because skipping simply keeps the rolled pick — there is nothing to
 * undo and nothing to send to the daemon (the prefs are per client).
 */
export function OobeStepBackground({ onNext }: { onNext: () => void }) {
  const isMobile = useIsMobile();

  return (
    <div className="oobe-bg" data-testid="oobe-step-background">
      <div className="oobe-bg__scroll">
        <div>
          <h1 className="oobe-bg__title">Choose a background</h1>
          <p className="oobe-bg__lead">
            We picked a wallpaper and a texture for you. Keep them, shuffle, or choose another. You can change this
            later in Settings.
          </p>
        </div>
        <Picker mode="app" initialOpen={{ wallpaper: true, texture: false }} />
      </div>

      <div className="oobe-bg__foot">
        <button type="button" className="btn btn--ghost" onClick={onNext}>
          Skip
        </button>
        <span className="oobe-bg__hint">{isMobile ? "" : "Skip keeps the pick shown above."}</span>
        <button type="button" className="btn btn--primary" onClick={onNext}>
          Continue
        </button>
      </div>
    </div>
  );
}
