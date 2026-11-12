import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { Navigate } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";

export default function ProtectedRoute({
  children,
}: {
  children: React.ReactNode;
}) {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    supabase.auth
      .getSession()
      .then(({ data }) => setSession(data.session))
      .catch(() => setSession(null))
      .finally(() => setLoading(false));

    const { data: listener } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        setSession(session);
      }
    );

    return () => listener.subscription.unsubscribe();
  }, []);

  if (loading)
    return (
      <div className="h-screen w-full flex items-center justify-center bg-[#090808]">
        <div className="w-8 h-8 border-2 border-[#ff5330] border-t-transparent rounded-full animate-spin" />
      </div>
    );

  if (!session) return <Navigate to="/login" replace />;

  return <>{children}</>;
}