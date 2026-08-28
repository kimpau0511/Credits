import { createContext, ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { AUTH_STORAGE_KEY, AuthSession, refreshSession, signIn, signOut, signUp, supabaseConfigured } from "@/lib/supabase";

type AuthContextValue = {
  configured: boolean;
  loading: boolean;
  session?: AuthSession;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<"signed-in" | "confirmation-required">;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AuthSession>();
  const [loading, setLoading] = useState(supabaseConfigured);

  useEffect(() => {
    if (!supabaseConfigured) { setLoading(false); return; }
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) { setLoading(false); return; }
    const stored = JSON.parse(raw) as AuthSession;
    refreshSession(stored.refresh_token).then(next => {
      setSession(next);
      localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(next));
    }).catch(() => localStorage.removeItem(AUTH_STORAGE_KEY)).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!session) return;
    const timer = window.setTimeout(() => {
      refreshSession(session.refresh_token).then(next => {
        setSession(next);
        localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(next));
      }).catch(() => {
        setSession(undefined);
        localStorage.removeItem(AUTH_STORAGE_KEY);
      });
    }, Math.max((session.expires_in - 60) * 1000, 30_000));
    return () => window.clearTimeout(timer);
  }, [session]);

  const value = useMemo<AuthContextValue>(() => ({
    configured: supabaseConfigured,
    loading,
    session,
    login: async (email, password) => {
      const next = await signIn(email, password);
      setSession(next);
      localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(next));
    },
    register: async (email, password) => {
      const result = await signUp(email, password);
      const next = "access_token" in result ? result : undefined;
      if (!next) return "confirmation-required";
      setSession(next);
      localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(next));
      return "signed-in";
    },
    logout: async () => {
      if (session) await signOut(session.access_token).catch(() => undefined);
      setSession(undefined);
      localStorage.removeItem(AUTH_STORAGE_KEY);
    },
  }), [loading, session]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("AuthProvider is missing");
  return value;
}
