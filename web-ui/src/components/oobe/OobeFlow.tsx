import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { ApiInstance } from "@/api";
import { WindowBackground } from "@/components/background/WindowBackground";
import type { ScreenKind } from "@/components/background/resolveWallpaper";
import { OobeStep1Location } from "./OobeStep1Location";
import { OobeStep2Modes } from "./OobeStep2Modes";
import { OobeStepBackground } from "./OobeStepBackground";
import { OobeStep3Doctor } from "./OobeStep3Doctor";
import "./OobeFlow.css";

/** Total OOBE step count. A single source of truth so the step indicator
 *  ("Step N of TOTAL_STEPS") and the "is there a previous step" check stay
 *  correct — nothing else in this file hardcodes a number. */
const TOTAL_STEPS = 4;

/** Step 3 (Background) is client-only; the daemon's 1|2|3 maps 3 → 3, so a
 *  resumed onboarding lands on the background step instead of skipping it. */
type Step = 1 | 2 | 3 | 4;

/** Stable identity: `useBackground` re-resolves on every render otherwise. */
const APP_KIND: ScreenKind = { t: "app" };

interface OobeFlowProps {
  api: ApiInstance;
  currentStep: 1 | 2 | 3;
  defaultProjectsDir: string;
  vstHome: string;
  onStep1Confirmed: (dir: string) => void;
  onStep2Confirmed: () => void;
  onCompleted: () => void;
}

export function OobeFlow({
  api,
  currentStep,
  defaultProjectsDir,
  vstHome,
  onStep1Confirmed,
  onStep2Confirmed,
  onCompleted,
}: OobeFlowProps) {
  const [step, setStep] = useState<Step>(currentStep);

  return (
    <div className="oobe-screen">
      {/* The pick from step 3 shows behind this whole screen, the same layer the
          app mounts — so choosing a wallpaper is immediate, not a preview. */}
      <WindowBackground kind={APP_KIND} />
      {/* `layout` makes this box itself the thing that animates size —
          whichever direction the user moves (a wider/taller step 2 body vs.
          a narrower/shorter step 1 body), framer-motion interpolates from the
          old rect to the new one, so it always reads as the SAME box resizing
          rather than a hard cut between two differently-positioned layouts.
          Width is fixed (same card, every step) — only height changes. */}
      <motion.div className="oobe-card" layout transition={{ duration: 0.35, ease: "easeInOut" }}>
        <div className="oobe-step-header">
          <div className="oobe-step-header__slot">
            {step > 1 && (
              <button type="button" className="oobe-back-link" onClick={() => setStep((s) => (s - 1) as Step)}>
                ← Back
              </button>
            )}
          </div>
          <div className="oobe-step-indicator">
            Step {step} of {TOTAL_STEPS}
          </div>
          <div className="oobe-step-header__slot" />
        </div>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={step}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            {step === 1 ? (
              <OobeStep1Location
                api={api}
                defaultProjectsDir={defaultProjectsDir}
                vstHome={vstHome}
                onConfirmed={(dir) => {
                  // Apply the caller-supplied HTTP response directly to the
                  // gate (no re-fetch — Decision 6), then advance this
                  // screen's own local step.
                  onStep1Confirmed(dir);
                  setStep(2);
                }}
              />
            ) : step === 2 ? (
              <OobeStep2Modes
                api={api}
                onStep2Confirmed={() => {
                  onStep2Confirmed();
                  setStep(3);
                }}
              />
            ) : step === 3 ? (
              <OobeStepBackground onNext={() => setStep(4)} />
            ) : (
              <OobeStep3Doctor api={api} onCompleted={onCompleted} />
            )}
          </motion.div>
        </AnimatePresence>
      </motion.div>
    </div>
  );
}
