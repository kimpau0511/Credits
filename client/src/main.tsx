import { trpc } from "@/lib/trpc";
import { AUTH_STORAGE_KEY, type AuthSession } from "@/lib/supabase";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import { createRoot } from "react-dom/client";
import superjson from "superjson";
import App from "./App";
import "./index.css";

const queryClient = new QueryClient();

const trpcClient = trpc.createClient({
  links: [
    httpBatchLink({
      url: "/api/trpc",
      transformer: superjson,
      headers() {
        try {
          const raw = localStorage.getItem(AUTH_STORAGE_KEY);
          const session = raw ? JSON.parse(raw) as AuthSession : undefined;
          return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {};
        } catch {
          return {};
        }
      },
    }),
  ],
});

createRoot(document.getElementById("root")!).render(
  <trpc.Provider client={trpcClient} queryClient={queryClient}>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </trpc.Provider>
);
