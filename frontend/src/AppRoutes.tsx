import { lazy, Suspense, useEffect } from "react";
import { Routes, Route, useNavigate } from "react-router-dom";
import { supabase } from "./lib/supabase";
import ProtectedRoute from "./auth/ProtectedRoute";

// Route-level code splitting: the landing page never downloads Monaco, D3 or jsPDF.
const Landing = lazy(() => import("./pages/Landing"));
const Login = lazy(() => import("./pages/Login"));
const Signup = lazy(() => import("./pages/Signup"));
const Dashboard = lazy(() => import("./pages/Dashboard"));
const Analyze = lazy(() => import("./pages/Analyze"));
const Docs = lazy(() => import("./pages/Docs"));

function PageLoader() {
  return (
    <div className="h-screen w-full flex items-center justify-center bg-[#090808]">
      <div className="w-8 h-8 border-2 border-[#ff5330] border-t-transparent rounded-full animate-spin" />
    </div>
  );
}

export default function AppRoutes() {
  const navigate = useNavigate();

  useEffect(() => {
    const isAuthPage = () => window.location.pathname === "/login" || window.location.pathname === "/signup";

    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (data.session && isAuthPage()) navigate("/dashboard");
      })
      .catch(() => {});

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session && isAuthPage()) navigate("/dashboard");
    });
    return () => listener.subscription.unsubscribe();
  }, [navigate]);

  return (
    <Suspense fallback={<PageLoader />}>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/login" element={<Login />} />
        <Route path="/signup" element={<Signup />} />
        <Route path="/docs" element={<Docs />} />
        <Route path="/analyze" element={<Analyze />} />
        <Route
          path="/dashboard"
          element={
            <ProtectedRoute>
              <Dashboard />
            </ProtectedRoute>
          }
        />
        <Route path="*" element={<Landing />} />
      </Routes>
    </Suspense>
  );
}
