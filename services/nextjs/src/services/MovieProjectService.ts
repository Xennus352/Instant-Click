import { MovieProjectRepository } from "@/repositories/MovieProjectRepository";

export async function listOwnedMovieProjects(userId: string, cursor: string | undefined, limit: number) {
  const rows = await MovieProjectRepository.listOwned(userId, cursor, limit);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const items = page.map(({ assets, uploadSessions, ...project }) => ({
    ...project,
    asset: assets[0]
      ? { ...assets[0], sizeBytes: assets[0].sizeBytes?.toString() ?? null }
      : null,
    upload: uploadSessions[0] ?? null,
  }));
  return {
    items,
    nextCursor: hasMore ? page[page.length - 1]?.id ?? null : null,
  };
}
