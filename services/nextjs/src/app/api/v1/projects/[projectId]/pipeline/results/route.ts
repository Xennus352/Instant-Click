import { errorResponse } from "@/lib/http/api-response";
import { requireSession } from "@/lib/middleware/auth-session";
import { pipelinePathSchema } from "@/lib/schemas/pipeline";
import { getMoviePipelineResults } from "@/services/PipelineService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: { projectId: string } }) {
  try {
    const session = await requireSession(request.headers);
    const { projectId } = pipelinePathSchema.parse(context.params);
    const data = await getMoviePipelineResults(session.user.id, projectId);
    return Response.json({ data }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
