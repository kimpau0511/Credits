import { FormEvent, useState } from "react";
import { LoaderCircle, LockKeyhole } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";

export default function Login() {
  const auth = useAuth();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault(); setPending(true); setMessage("");
    try {
      if (mode === "login") await auth.login(email.trim(), password);
      else {
        const result = await auth.register(email.trim(), password);
        if (result === "confirmation-required") setMessage("확인 이메일을 보냈습니다. 이메일 인증 후 로그인해 주세요.");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "로그인하지 못했습니다.");
    } finally { setPending(false); }
  }

  return <main className="grid min-h-screen bg-[#101010] text-white lg:grid-cols-[1.1fr_.9fr]">
    <section className="flex min-h-[42vh] flex-col justify-between border-b border-white/15 bg-[#191918] p-8 lg:min-h-screen lg:border-b-0 lg:border-r lg:p-14">
      <strong className="text-xl">C/S</strong>
      <div><p className="text-[10px] font-mono tracking-[.18em] text-white/45">MUSIC CREDIT INTELLIGENCE</p><h1 className="mt-5 max-w-xl text-5xl font-black leading-[.9] tracking-[-.06em] sm:text-7xl">수집한 곡이<br />리서치 자산이 됩니다.</h1><p className="mt-7 max-w-lg text-sm leading-7 text-white/55">곡을 검색하면 크레딧이 사용자별 수집함에 저장되고, 반복 참여자와 협업 패턴을 자동으로 정리합니다.</p></div>
      <p className="text-xs text-white/35">CREATOR SIGNAL · PRIVATE RESEARCH WORKSPACE</p>
    </section>
    <section className="flex items-center justify-center p-6 sm:p-12"><form onSubmit={submit} className="w-full max-w-md border border-white/20 bg-[#181818] p-7 sm:p-10">
      <LockKeyhole className="size-7" /><p className="mt-8 text-[10px] font-mono tracking-[.15em] text-white/45">{mode === "login" ? "MEMBER LOGIN" : "CREATE ACCOUNT"}</p><h2 className="mt-3 text-3xl font-black">{mode === "login" ? "리서치 공간 로그인" : "계정 만들기"}</h2>
      {!auth.configured && <div className="mt-6 border border-amber-300/40 bg-amber-300/10 p-4 text-xs leading-5 text-amber-100">Supabase 연결 전입니다. 배포 환경에 VITE_SUPABASE_URL과 VITE_SUPABASE_ANON_KEY를 등록하면 로그인이 활성화됩니다.</div>}
      <label className="mt-8 block border-b border-white/25 pb-3"><span className="text-[10px] text-white/45">EMAIL</span><input type="email" required value={email} onChange={event => setEmail(event.target.value)} className="mt-2 w-full bg-transparent text-sm outline-none" placeholder="name@company.com" /></label>
      <label className="mt-5 block border-b border-white/25 pb-3"><span className="text-[10px] text-white/45">PASSWORD</span><input type="password" required minLength={8} value={password} onChange={event => setPassword(event.target.value)} className="mt-2 w-full bg-transparent text-sm outline-none" placeholder="8자 이상" /></label>
      {message && <p className="mt-5 border border-white/20 p-3 text-xs leading-5 text-white/65">{message}</p>}
      <button disabled={pending || !auth.configured} className="mt-7 flex min-h-14 w-full items-center justify-center bg-white text-sm font-bold text-black disabled:opacity-40">{pending ? <LoaderCircle className="size-5 animate-spin" /> : mode === "login" ? "로그인" : "가입하기"}</button>
      <button type="button" onClick={() => { setMode(mode === "login" ? "register" : "login"); setMessage(""); }} className="mt-5 w-full text-xs text-white/50 hover:text-white">{mode === "login" ? "처음 사용하시나요? 계정 만들기" : "이미 계정이 있나요? 로그인"}</button>
    </form></section>
  </main>;
}
