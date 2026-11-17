import type { LookView } from "./backgroundLook";

/**
 * The miniature app window drawn over the Picker preview (design
 * `Picker.dc.html:92-135`): glass sidebar with traffic lights, tab strip, the
 * centre content of the view it shows, and a status bar. Static decoration
 * only — no buttons, links or focus stops, and `aria-hidden`, because the
 * preview's accessible description is the frame's `aria-label`.
 */
export function MiniWindowChrome({ view }: { view: LookView }): React.JSX.Element {
  return (
    <div className="wp-mini" aria-hidden="true">
      <div className="wp-mini__side wp-mini__glass">
        <div className="wp-mini__lights">
          <span className="wp-mini__light wp-mini__light--close" />
          <span className="wp-mini__light wp-mini__light--minimize" />
          <span className="wp-mini__light wp-mini__light--zoom" />
        </div>
        <span className="wp-mini__brand">vibe-station</span>
        <span className="wp-mini__bar wp-mini__bar--on" />
        <span className="wp-mini__bar" />
        <span className="wp-mini__bar wp-mini__bar--short" />
        <span className="wp-mini__bar wp-mini__bar--section" />
        <span className="wp-mini__bar" />
        <span className="wp-mini__bar wp-mini__bar--short" />
      </div>

      <div className="wp-mini__tabs wp-mini__glass">
        <span className="wp-mini__tab is-on">Agent</span>
        <span className="wp-mini__tab">Terminal</span>
        <span className="wp-mini__tab">Files</span>
      </div>

      <div className={view === "session" ? "wp-mini__center wp-mini__center--session" : "wp-mini__center"}>
        {view === "empty" ? (
          <>
            <span className="wp-mini__title">What should we build?</span>
            <div className="wp-mini__composer">
              <span>Message the agent…</span>
              <span className="wp-mini__send" />
            </div>
            <span className="wp-mini__quote">Build something epic</span>
          </>
        ) : (
          <>
            <span className="wp-mini__card wp-mini__card--short" />
            <span className="wp-mini__card" />
            <div className="wp-mini__composer">
              <span>Message the agent…</span>
              <span className="wp-mini__send" />
            </div>
          </>
        )}
      </div>

      <div className="wp-mini__status wp-mini__glass" />
    </div>
  );
}
