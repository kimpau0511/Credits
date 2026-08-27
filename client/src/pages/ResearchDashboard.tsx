import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, LoaderCircle, Network, RefreshCw } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { loadSavedTracks, SavedCredit, SavedTrack } from "@/lib/researchStore";

const creatorRoles = ["작사", "작곡", "작사·작곡", "편곡", "프로듀싱"];
function displayDate(value?: string) { return value ? value.replace(/-/g, ".") : "—"; }
function splitArtists(value: string) { return value.split(/,|&| feat\.? | with /i).map(item => item.trim()).filter(Boolean); }

type CreatorStat = {
  key: string;
  name: string;
  credits: SavedCredit[];
  tracks: SavedTrack[];
  compositionCount: number;
  lyricCount: number;
  combinedCount: number;
  recentCount: number;
};

export default function ResearchDashboard({ onBack }: { onBack: () => void }) {
  const { session } = useAuth();
  const [tracks, setTracks] = useState<SavedTrack[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedKey, setSelectedKey] = useState<string>();

  async function load() {
    if (!session) return;
    setLoading(true); setError("");
    try { setTracks(await loadSavedTracks(session.access_token)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "수집 데이터를 불러오지 못했습니다."); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, [session?.access_token]);

  const analytics = useMemo(() => {
    const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - 3);
    const creators = new Map<string, { name: string; credits: SavedCredit[]; tracks: Map<string, SavedTrack> }>();
    const albums = new Map<string, number>(); const genres = new Map<string, number>(); const artists = new Map<string, number>();
    const edgeCounts = new Map<string, { names: [string, string]; count: number }>();
    for (const track of tracks) {
      albums.set(track.album || "앨범 미확인", (albums.get(track.album || "앨범 미확인") ?? 0) + 1);
      for (const genre of track.genres ?? []) genres.set(genre, (genres.get(genre) ?? 0) + 1);
      for (const artist of splitArtists(track.artist)) artists.set(artist, (artists.get(artist) ?? 0) + 1);
      const creative = track.credits.filter(credit => creatorRoles.includes(credit.role));
      for (const credit of creative) {
        const current = creators.get(credit.creator_key) ?? { name: credit.name, credits: [], tracks: new Map<string, SavedTrack>() };
        current.credits.push(credit); current.tracks.set(track.id, track); creators.set(credit.creator_key, current);
      }
      const unique = Array.from(new Map(creative.map(credit => [credit.creator_key, credit])).values());
      for (let left = 0; left < unique.length; left += 1) for (let right = left + 1; right < unique.length; right += 1) {
        const pair = [unique[left], unique[right]].sort((a, b) => a.creator_key.localeCompare(b.creator_key));
        const key = `${pair[0].creator_key}|${pair[1].creator_key}`; const current = edgeCounts.get(key);
        edgeCounts.set(key, { names: [pair[0].name, pair[1].name], count: (current?.count ?? 0) + 1 });
      }
    }
    const creatorStats: CreatorStat[] = Array.from(creators.entries()).map(([key, value]) => {
      const creatorTracks = Array.from(value.tracks.values());
      const rolesByTrack = creatorTracks.map(track => track.credits.filter(credit => credit.creator_key === key).map(credit => credit.role));
      return {
        key, name: value.name, credits: value.credits, tracks: creatorTracks,
        compositionCount: rolesByTrack.filter(roles => roles.some(role => ["작곡", "작사·작곡"].includes(role))).length,
        lyricCount: rolesByTrack.filter(roles => roles.some(role => ["작사", "작사·작곡"].includes(role))).length,
        combinedCount: rolesByTrack.filter(roles => roles.includes("작사·작곡") || (roles.includes("작사") && roles.includes("작곡"))).length,
        recentCount: creatorTracks.filter(track => track.release_date && new Date(track.release_date) >= cutoff).length,
      };
    }).sort((a, b) => b.tracks.length - a.tracks.length || a.name.localeCompare(b.name));
    return {
      creatorStats,
      albums: Array.from(albums.entries()).sort((a, b) => b[1] - a[1]),
      genres: Array.from(genres.entries()).sort((a, b) => b[1] - a[1]),
      artists: Array.from(artists.entries()).sort((a, b) => b[1] - a[1]),
      edges: Array.from(edgeCounts.values()).sort((a, b) => b.count - a.count),
    };
  }, [tracks]);

  const selected = analytics.creatorStats.find(creator => creator.key === selectedKey);
  const selectedArtists = selected ? Array.from(selected.tracks.reduce((map, track) => {
    for (const artist of splitArtists(track.artist)) map.set(artist, (map.get(artist) ?? 0) + 1); return map;
  }, new Map<string, number>()).entries()).sort((a, b) => b[1] - a[1]) : [];

  return <main className="min-h-screen bg-[#101010] px-5 py-8 text-white sm:px-8">
    <div className="mx-auto max-w-7xl"><header className="flex flex-wrap items-center justify-between gap-4 border-b border-white/20 pb-6"><div><button onClick={onBack} className="mb-5 flex items-center gap-2 text-xs text-white/55 hover:text-white"><ArrowLeft className="size-3.5" />곡 검색으로 돌아가기</button><p className="text-[10px] font-mono tracking-[.16em] text-white/45">MY RESEARCH COLLECTION</p><h1 className="mt-2 text-4xl font-black tracking-[-.05em]">수집 크레딧 분석</h1></div><button onClick={() => void load()} className="flex items-center gap-2 border border-white/25 px-4 py-2 text-xs"><RefreshCw className="size-3.5" />새로고침</button></header>
      {loading ? <div className="py-32 text-center"><LoaderCircle className="mx-auto size-7 animate-spin" /><p className="mt-4 text-sm text-white/55">수집 데이터를 분석하고 있습니다.</p></div> : error ? <p className="mt-8 border border-white/25 p-5 text-sm">{error}</p> : !tracks.length ? <div className="mt-10 border border-white/20 bg-[#181818] p-10"><h2 className="text-2xl font-black">아직 수집한 곡이 없습니다.</h2><p className="mt-3 text-sm text-white/55">곡을 검색하고 분석하면 자동으로 이 공간에 저장됩니다.</p></div> : <>
        <section className="mt-8 grid gap-px bg-white/15 sm:grid-cols-2 lg:grid-cols-4">{[["수집 곡", tracks.length], ["반복 등장 인물", analytics.creatorStats.filter(item => item.tracks.length > 1).length], ["확인 아티스트", analytics.artists.length], ["공동작업 연결", analytics.edges.length]].map(([label, value]) => <div key={String(label)} className="bg-[#181818] p-6"><p className="text-[10px] font-mono text-white/45">{label}</p><strong className="mt-3 block text-4xl">{value}</strong></div>)}</section>
        <section className="mt-8 grid gap-8 xl:grid-cols-[1.15fr_.85fr]"><div className="border border-white/20 bg-[#181818] p-6"><p className="text-[10px] font-mono text-white/45">REPEATED CREATORS</p><h2 className="mt-2 text-2xl font-black">반복 참여 작곡·작사가</h2><div className="mt-6 overflow-x-auto"><table className="w-full min-w-[650px] text-left text-xs"><thead className="border-b border-white/20 text-white/45"><tr><th className="py-3">인물</th><th>전체</th><th>작곡</th><th>작사</th><th>동시</th><th>최근 3개월</th></tr></thead><tbody>{analytics.creatorStats.map(creator => <tr key={creator.key} onClick={() => setSelectedKey(creator.key)} className="cursor-pointer border-b border-white/10 hover:bg-white hover:text-black"><td className="py-4 font-bold">{creator.name}</td><td>{creator.tracks.length}</td><td>{creator.compositionCount}</td><td>{creator.lyricCount}</td><td>{creator.combinedCount}</td><td>{creator.recentCount}</td></tr>)}</tbody></table></div></div>
          <div className="space-y-8"><Rank title="아티스트별 참여 횟수" items={analytics.artists} /><Rank title="앨범별 참여 횟수" items={analytics.albums} /><Rank title="장르별 참여" items={analytics.genres.length ? analytics.genres : [["장르 미확인", tracks.length]]} /></div></section>
        <section className="mt-8 border border-white/20 bg-[#181818] p-6"><div className="flex items-center gap-3"><Network className="size-5" /><div><p className="text-[10px] font-mono text-white/45">CO-WRITER NETWORK</p><h2 className="mt-1 text-2xl font-black">가장 많이 함께 작업한 조합</h2></div></div><div className="mt-6 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{analytics.edges.slice(0, 12).map((edge, index) => <div key={`${edge.names.join("-")}-${index}`} className="border border-white/15 p-4"><span className="text-sm font-bold">{edge.names[0]} × {edge.names[1]}</span><strong className="mt-3 block text-2xl">{edge.count}<small className="ml-1 text-xs font-normal text-white/45">곡</small></strong></div>)}</div></section>
        {selected && <section className="mt-8 grid border border-black/20 bg-[#ecece8] text-black lg:grid-cols-[.7fr_1.3fr]"><div className="bg-black p-7 text-white"><p className="text-[10px] font-mono text-white/45">CREATOR IN MY COLLECTION</p><h2 className="mt-4 text-4xl font-black">{selected.name}</h2><p className="mt-6 text-sm text-white/60">내가 수집한 곡에서 {selected.tracks.length}회 등장</p><div className="mt-8 grid grid-cols-2 gap-3"><Metric label="작곡" value={selected.compositionCount} /><Metric label="작사" value={selected.lyricCount} /><Metric label="작사+작곡" value={selected.combinedCount} /><Metric label="최근 3개월" value={selected.recentCount} /></div></div><div className="grid gap-7 p-7 md:grid-cols-2"><div><p className="text-[10px] font-mono text-black/45">최근 수집 작업</p><div className="mt-4 space-y-3">{[...selected.tracks].sort((a, b) => (b.release_date ?? "").localeCompare(a.release_date ?? "")).slice(0, 8).map(track => <div key={track.id} className="border-b border-black/15 pb-3 text-sm"><strong>{track.title}</strong><span className="mt-1 block text-xs text-black/50">{track.artist} · {displayDate(track.release_date)}</span></div>)}</div></div><div><p className="text-[10px] font-mono text-black/45">함께한 아티스트 규모 · 내 수집함 기준</p><div className="mt-4 space-y-3">{selectedArtists.slice(0, 8).map(([artist, count]) => <div key={artist}><div className="flex justify-between text-sm"><strong>{artist}</strong><span>{count}곡</span></div><div className="mt-1 h-1.5 bg-black/10"><div className="h-full bg-black" style={{ width: `${Math.max(count / Math.max(selectedArtists[0]?.[1] ?? 1, 1) * 100, 5)}%` }} /></div></div>)}</div><p className="mt-5 text-[11px] leading-5 text-black/50">현재 ‘규모’는 내 수집함에 저장된 곡 수 기준입니다. 월간 청취자·팔로워 규모는 Spotify 등 별도 데이터 공급자 연결 시 추가할 수 있습니다.</p></div></div></section>}
      </>}
    </div>
  </main>;
}

function Rank({ title, items }: { title: string; items: Array<[string, number]> }) {
  const max = Math.max(items[0]?.[1] ?? 1, 1);
  return <div className="border border-white/20 bg-[#181818] p-5"><p className="text-[10px] font-mono text-white/45">{title}</p><div className="mt-4 space-y-3">{items.slice(0, 6).map(([name, count]) => <div key={name}><div className="flex justify-between text-xs"><span className="truncate">{name}</span><b>{count}</b></div><div className="mt-1.5 h-1 bg-white/10"><div className="h-full bg-white" style={{ width: `${Math.max(count / max * 100, 5)}%` }} /></div></div>)}</div></div>;
}

function Metric({ label, value }: { label: string; value: number }) { return <div className="border border-white/20 p-3"><span className="text-[10px] text-white/45">{label}</span><strong className="mt-1 block text-2xl">{value}</strong></div>; }
