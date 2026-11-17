import { describe, expect, it } from "vitest";
import { defaultPrefs } from "./backgroundStore";
import { layerVars, lookFromPrefs } from "./backgroundLook";

describe("backgroundLook", () => {
  it("resolves the default prefs into the window's current look", () => {
    const look = lookFromPrefs(defaultPrefs());

    expect(look.texture.id).toBe("none");
    expect(look.intensity).toBe(0);
    expect(look.gradient).toBe("fade_to_theme");
    expect(look.chromeOpacity).toBe(0.72);
    expect(layerVars(look, "empty", true)).toEqual({ "--wp-vis": "0.9", "--wp-chrome-alpha": "72%" });
    expect(layerVars(look, "session", true)).toEqual({ "--wp-vis": "0.2", "--wp-chrome-alpha": "72%" });
  });

  it("keeps the chrome opaque and the scrim off with no wallpaper", () => {
    const look = lookFromPrefs(defaultPrefs());
    expect(layerVars(look, "empty", false)).toEqual({ "--wp-vis": "1", "--wp-chrome-alpha": "100%" });
  });

  it("intensity falls back to the texture's own default", () => {
    const look = lookFromPrefs({ ...defaultPrefs(), texture: "hex", intensity: null });
    expect(look.texture.id).toBe("hex");
    expect(look.intensity).toBe(0.8);

    const explicit = lookFromPrefs({ ...defaultPrefs(), texture: "hex", intensity: 0.3 });
    expect(explicit.intensity).toBe(0.3);
  });
});
