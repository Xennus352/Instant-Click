import { errorResponse } from "@/lib/http/api-response";
import { requireSession } from "@/lib/middleware/auth-session";
import { pipelinePathSchema, pipelineStartSchema } from "@/lib/schemas/pipeline";
import { getIdempotencyKey } from "@/lib/schemas/credits";
import { readJson } from "@/lib/http/api-response";
import { retryMoviePipeline } from "@/services/PipelineService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: { projectId: string } }) {
  try {
    const session = await requireSession(request.headers);
    const { projectId } = pipelinePathSchema.parse(context.params);
    const idempotencyKey = getIdempotencyKey(request);
    if (!idempotencyKey) throw new TypeError("A valid Idempotency-Key header is required");
    pipelineStartSchema.parse(await readJson(request));
    const data = await retryMoviePipeline(session.user.id, projectId, idempotencyKey);
    return Response.json({ data }, { status: 202, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
