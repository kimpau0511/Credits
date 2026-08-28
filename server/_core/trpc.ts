import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";

export type TrpcContext = { authorization?: string };

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
});

const authCache = new Map<string, { userId: string; email?: string; expiresAt: number }>();
const requestWindows = new Map<string, number[]>();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 30;

async function requireSupabaseUser(authorization?: string) {
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) throw new TRPCError({ code: "UNAUTHORIZED", message: "로그인이 필요합니다." });
  const cached = authCache.get(token);
  if (cached && cached.expiresAt > Date.now()) return cached;

  const supabaseUrl = process.env.VITE_SUPABASE_URL?.replace(/\/$/, "");
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Supabase 인증 설정이 누락되었습니다." });
  const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5_000),
  }).catch(() => undefined);
  if (!response?.ok) throw new TRPCError({ code: "UNAUTHORIZED", message: "로그인 세션이 만료되었습니다." });
  const user = await response.json() as { id?: string; email?: string };
  if (!user.id) throw new TRPCError({ code: "UNAUTHORIZED", message: "사용자 정보를 확인하지 못했습니다." });
  const allowedEmails = (process.env.ALLOWED_USER_EMAILS ?? "")
    .split(",")
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);
  if (allowedEmails.length && (!user.email || !allowedEmails.includes(user.email.toLowerCase()))) {
    throw new TRPCError({ code: "FORBIDDEN", message: "이 계정은 서비스 사용 권한이 없습니다." });
  }
  const authenticated = { userId: user.id, email: user.email, expiresAt: Date.now() + 60_000 };
  authCache.set(token, authenticated);
  return authenticated;
}

export const router = t.router;
export const protectedProcedure = t.procedure.use(async ({ ctx, next }) => {
  const { userId } = await requireSupabaseUser(ctx.authorization);
  const now = Date.now();
  const recent = (requestWindows.get(userId) ?? []).filter(timestamp => now - timestamp < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_MAX_REQUESTS) {
    throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요." });
  }
  recent.push(now);
  requestWindows.set(userId, recent);
  return next({ ctx: { ...ctx, userId } });
});
