import { z } from "zod";
import { publicProcedure, router } from "./_core/trpc";
import { analyzeMusic, getCreatorProfile, searchMusicCandidates } from "./musicAnalysis";

export const appRouter = router({
  music: router({
    analyze: publicProcedure
      .input(z.object({
        title: z.string().trim().min(1, "곡 제목을 입력해 주세요.").max(160),
        artist: z.string().trim().max(160).optional(),
        isrc: z.string().trim().min(6).max(32).optional(),
        mbid: z.string().uuid().optional(),
      }))
      .mutation(async ({ input }) => analyzeMusic(input)),
    searchCandidates: publicProcedure
      .input(z.object({
        title: z.string().trim().min(1, "곡 제목을 입력해 주세요.").max(160),
        artist: z.string().trim().max(160).optional(),
      }))
      .mutation(({ input }) => searchMusicCandidates(input)),
    creatorProfile: publicProcedure
      .input(z.object({
        creatorId: z.string().trim().min(3).max(180),
        name: z.string().trim().min(1).max(200),
        roles: z.array(z.enum(["아티스트", "작사", "작곡", "작사·작곡", "편곡", "프로듀싱", "연주", "기타"])).min(1),
        externalIpi: z.string().trim().min(3).max(64).optional(),
        externalMbid: z.string().trim().min(8).max(64).optional(),
      }))
      .query(({ input }) => getCreatorProfile(input)),
  }),
});

export type AppRouter = typeof appRouter;
