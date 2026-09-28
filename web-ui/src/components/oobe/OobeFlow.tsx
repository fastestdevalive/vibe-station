import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { ApiInstance } from "@/api";
import { OobeStep1Location } from "./OobeStep1Location";
import { OobeStep2Modes } from "./OobeStep2Modes";
import { OobeStep3Doctor } from "./OobeStep3Doctor";
import "./OobeFlow.css";

/** Total OOBE step count. A single source of truth so the step indicator
 *  ("Step N of TOTAL_STEPS") and the "is there a previous step" check stay
 *  correct if a 3rd step is ever added — nothing else in this file hardcodes
 *  "2". */
const TOTAL_STEPS = 3;

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
  const [step, setStep] = useState<1 | 2 | 3>(currentStep);

  return (
    <div className="oobe-screen">
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
              <button
                type="button"
                className="oobe-back-link"
                onClick={() => setStep((s) => (s - 1) as 1 | 2 | 3)}
              >
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
            ) : (
              <OobeStep3Doctor api={api} onCompleted={onCompleted} />
            )}
          </motion.div>
        </AnimatePresence>
      </motion.div>
    </div>
  );
}
