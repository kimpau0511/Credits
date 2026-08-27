const supabaseUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.replace(/\/$/, "");
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export type AuthUser = { id: string; email?: string };
export type AuthSession = { access_token: string; refresh_token: string; expires_in: number; user: AuthUser };

export const supabaseConfigured = Boolean(supabaseUrl && anonKey);

function endpoint(path: string) {
  if (!supabaseUrl || !anonKey) throw new Error("SUPABASE_NOT_CONFIGURED");
  return `${supabaseUrl}${path}`;
}

async function parseResponse<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.msg ?? body.message ?? body.error_description ?? body.error ?? `SUPABASE_${response.status}`);
  return body as T;
}

export async function signIn(email: string, password: string) {
  return parseResponse<AuthSession>(await fetch(endpoint("/auth/v1/token?grant_type=password"), {
    method: "POST",
    headers: { apikey: anonKey!, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  }));
}

export async function signUp(email: string, password: string) {
  return parseResponse<AuthSession | { user: AuthUser; session: null }>(await fetch(endpoint("/auth/v1/signup"), {
    method: "POST",
    headers: { apikey: anonKey!, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  }));
}

export async function refreshSession(refreshToken: string) {
  return parseResponse<AuthSession>(await fetch(endpoint("/auth/v1/token?grant_type=refresh_token"), {
    method: "POST",
    headers: { apikey: anonKey!, "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken }),
  }));
}

export async function signOut(accessToken: string) {
  await fetch(endpoint("/auth/v1/logout"), { method: "POST", headers: { apikey: anonKey!, Authorization: `Bearer ${accessToken}` } });
}

export async function supabaseRest<T>(path: string, accessToken: string, init?: RequestInit): Promise<T> {
  const response = await fetch(endpoint(`/rest/v1/${path}`), {
    ...init,
    headers: {
      apikey: anonKey!,
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (response.status === 204) return undefined as T;
  return parseResponse<T>(response);
}
