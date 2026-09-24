import { useState } from "react";
import ErrorBoundary from "./components/ErrorBoundary";
import { AuthProvider, useAuth } from "./contexts/AuthContext";
import { LanguageProvider } from "./contexts/LanguageContext";
import Home from "./pages/Home";
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
  if (auth.loading) return <div className="flex min-h-screen items-center justify-center bg-[#101010] text-sm text-white/60">저장된 데이터를 불러오고 있습니다.</div>;
  return <div className="min-h-screen bg-[#101010]">
    <div className="fixed inset-x-0 top-0 z-50 flex h-12 items-center border-b border-white/15 bg-black px-5 text-white sm:px-8"><div className="flex items-center gap-5"><strong className="text-sm">CReadits Search</strong><button onClick={() => setView("search")} className={view === "search" ? "text-xs text-white" : "text-xs text-white/45"}>곡 검색</button><button onClick={() => setView("library")} className={view === "library" ? "text-xs text-white" : "text-xs text-white/45"}>내 수집 분석</button></div></div>
    <div className="pt-12">{view === "search" ? <Home /> : <ResearchDashboard onBack={() => setView("search")} />}</div>
  </div>;
}

export default App;
