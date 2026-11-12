import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import "../styles/login.css";

export default function Login() {
  const navigate = useNavigate();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<{ kind: "error" | "ok"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const handleLogin = async () => {
    if (!email || !password) return setMessage({ kind: "error", text: "Enter your email and password." });
    setBusy(true);
    setMessage(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) return setMessage({ kind: "error", text: error.message });
    navigate("/dashboard");
  };

  const handleGitHub = async () => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "github",
      options: {
        redirectTo: `${window.location.origin}/dashboard`,
      },
    });

    if (error) setMessage({ kind: "error", text: error.message });
  };

  return (
    <div className="ca-login-root">
      <canvas className="ca-login-canvas" />
      <div className="ca-login-grid" />
      <div className="ca-login-orb ca-login-orb1" />
      <div className="ca-login-orb ca-login-orb2" />

      {/* LOGIN CARD */}
      <div className="ca-login-card">
        <div className="ca-login-logo">
          Code<span className="ca-login-accent">Lens</span>
        </div>

        <div className="ca-login-tagline">// visual code intelligence</div>

        <div className="ca-login-divider" />

        <div className="ca-login-label">Continue with</div>

        <button className="ca-github-btn" onClick={handleGitHub}>
          Sign in with GitHub
        </button>
        <div className="ca-email-box">
        <input
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />

        <input
          placeholder="Password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleLogin(); }}
        />
        </div>

        <button className="ca-github-btn" onClick={handleLogin} disabled={busy}>{busy ? "Signing in…" : "Login"}</button>
        {message && <div className={`ca-auth-msg ${message.kind}`}>{message.text}</div>}

        <button className="ca-back-btn" onClick={() => navigate("/signup")}>
          No account? Sign up
        </button>
      </div>
    </div>
  );
}