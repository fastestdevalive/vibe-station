import { type FormEvent, useState } from "react";
import { api, ApiError } from "@/api";
import "./LoginScreen.css";

interface LoginScreenProps {
  onSuccess: () => void;
}

export function LoginScreen({ onSuccess }: LoginScreenProps) {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!token.trim() || loading) return;

    setLoading(true);
    setError(null);

    try {
      await api.login(token.trim());
      onSuccess();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setError("Incorrect token. Try again.");
      } else if (err instanceof ApiError && err.status === 429) {
        setError("Too many attempts. Wait a minute and try again.");
      } else {
        setError("Could not connect to daemon. Is it running?");
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="login-card__brand">Vibe Station</div>
        <div className="login-card__divider" />

        <form onSubmit={(e) => void handleSubmit(e)} noValidate>
          <div className="login-field">
            <label className="login-field__label" htmlFor="vst-token">
              Access token
            </label>
            <input
              id="vst-token"
              className={`login-field__input${error ? " login-field__input--error" : ""}`}
              type="password"
              value={token}
              onChange={(e) => {
                setToken(e.target.value);
                if (error) setError(null);
              }}
              placeholder="Paste your token here"
              autoComplete="off"
              autoFocus
              disabled={loading}
            />
            {error && <p className="login-field__error">{error}</p>}
          </div>

          <button
            type="submit"
            className="login-btn"
            disabled={loading || !token.trim()}
          >
            {loading ? "Logging in…" : "Login"}
          </button>
        </form>

        <p className="login-card__hint">
          Find your token in the terminal where you ran{" "}
          <code>vst daemon start</code>
        </p>
      </div>
    </div>
  );
}
