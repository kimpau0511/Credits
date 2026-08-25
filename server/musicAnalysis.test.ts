import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildBriefing,
  buildCooccurrenceNetwork,
  consolidateMusicCredits,
  normalizeCreditRole,
  normalizeCreditsFmRole,
  selectBestCreditsRecording,
  type MusicCredit,
} from "./musicAnalysis.ts";

const credits: MusicCredit[] = [
  { creatorId: "a", name: "A", role: "아티스트", source: "MusicBrainz" },
  { creatorId: "b", name: "B", role: "작곡", source: "MusicBrainz" },
  { creatorId: "c", name: "C", role: "프로듀싱", source: "MusicBrainz" },
];

describe("music credit normalization", () => {
  it("maps known relationship labels into the credit taxonomy", () => {
    assert.equal(normalizeCreditRole("composer"), "작곡");
    assert.equal(normalizeCreditRole("lyricist"), "작사");
    assert.equal(normalizeCreditRole("writer"), "작사·작곡");
    assert.equal(normalizeCreditRole("producer"), "프로듀싱");
    assert.equal(normalizeCreditRole("unknown"), "기타");
  });

  it("selects a title and artist match and maps Credits.fm roles", () => {
    const result = selectBestCreditsRecording([
      { isrc: "other", title: "BANG BANG BANG", artist_names: ["Other"] },
      { isrc: "target", title: "뱅뱅뱅 (BANG BANG BANG)", artist_names: ["BIGBANG"] },
    ], "뱅뱅뱅", "BIGBANG");
    assert.equal(result?.isrc, "target");
    assert.equal(normalizeCreditsFmRole("ComposerLyricist"), "작사·작곡");
    assert.equal(normalizeCreditsFmRole("arranger", "producer"), "편곡");
  });

  it("keeps the missing-credit state explicit", () => {
    const briefing = buildBriefing(
      { id: "missing", title: "Untitled work", artist: "Unknown artist" },
      [],
      "limited",
    );
    assert.match(briefing, /확정된 송라이팅 크레딧을 찾지 못했습니다/);
    assert.match(briefing, /상세 송라이팅 크레딧이 제한적입니다/);
    assert.match(briefing, /검색 결과를 데이터베이스나 파일에 저장하지 않으며/);
  });

  it("aggregates repeated creator co-occurrences without duplicate nodes", () => {
    const network = buildCooccurrenceNetwork([credits, credits.slice(0, 2)]);
    assert.equal(network.nodes.length, 3);
    assert.equal(network.nodes.find(node => node.id === "a")?.appearances, 2);
    assert.equal(
      network.edges.find(edge => edge.source === "a" && edge.target === "b")?.weight,
      2,
    );
  });

  it("merges stage and legal names into one creator with combined roles", () => {
    const result = consolidateMusicCredits([
      { creatorId: "mbid:gdragon", externalMbid: "gdragon", name: "G-DRAGON", role: "아티스트", source: "Credits.fm" },
      { creatorId: "ipi:123", externalIpi: "123", name: "권지용", role: "작사", source: "Credits.fm" },
      { creatorId: "ipi:123", externalIpi: "123", name: "Kwon Ji-yong", role: "작곡", source: "Credits.fm" },
    ]);
    assert.deepEqual([...new Set(result.map(credit => credit.creatorId))], ["ipi:123"]);
    assert.deepEqual([...new Set(result.map(credit => credit.name))], ["G-DRAGON"]);
    assert.deepEqual(result.map(credit => credit.role).sort(), ["아티스트", "작곡", "작사"].sort());
  });
});
