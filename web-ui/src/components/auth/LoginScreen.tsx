import "./LoginScreen.css";

interface LoginScreenProps {
  onSuccess: () => void;
}

// All non-Tauri browsers (LAN and tunnel) see this notice — no token form.
// Tauri auto-login via __VST_TOKEN__ injection is handled in useAuth.ts.
export function LoginScreen(_props: LoginScreenProps) {
  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="login-card__brand">Vibe Station</div>
        <div className="login-card__divider" />
        <p style={{ textAlign: "center", color: "var(--fg-muted)", fontSize: "var(--font-size-sm)", lineHeight: 1.5 }}>
          Open the desktop app → <strong>Settings</strong> → <strong>Remote Access</strong> → <strong>Show QR</strong> and scan it with your phone.
        </p>
      </div>
    </div>
  );
}
