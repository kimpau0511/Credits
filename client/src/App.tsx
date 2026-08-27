import { useState } from "react";
import ErrorBoundary from "./components/ErrorBoundary";
import { AuthProvider, useAuth } from "./contexts/AuthContext";
import { LanguageProvider } from "./contexts/LanguageContext";
import Home from "./pages/Home";
import Login from "./pages/Login";
import ResearchDashboard from "./pages/ResearchDashboard";

function App() {
  return (
    <ErrorBoundary>
      <AuthProvider><LanguageProvider><Workspace /></LanguageProvider></AuthProvider>
    </ErrorBoundary>
  );
}

function Workspace() {
  const auth = useAuth();
  const [view, setView] = useState<"search" | "library">("search");
  if (auth.loading) return <div className="flex min-h-screen items-center justify-center bg-[#101010] text-sm text-white/60">로그인 상태를 확인하고 있습니다.</div>;
  if (!auth.session) return <Login />;
  return <div className="min-h-screen bg-[#101010]">
    <div className="fixed inset-x-0 top-0 z-50 flex h-12 items-center justify-between border-b border-white/15 bg-black px-5 text-white sm:px-8"><div className="flex items-center gap-5"><strong className="text-sm">CREATOR SIGNAL</strong><button onClick={() => setView("search")} className={view === "search" ? "text-xs text-white" : "text-xs text-white/45"}>곡 검색</button><button onClick={() => setView("library")} className={view === "library" ? "text-xs text-white" : "text-xs text-white/45"}>내 수집 분석</button></div><div className="flex items-center gap-3"><span className="hidden text-[10px] text-white/40 sm:inline">{auth.session.user.email}</span><button onClick={() => void auth.logout()} className="border border-white/25 px-3 py-1.5 text-[10px]">로그아웃</button></div></div>
    <div className="pt-12">{view === "search" ? <Home /> : <ResearchDashboard onBack={() => setView("search")} />}</div>
  </div>;
}

export default App;
