import { errorResponse, readJson } from "@/lib/http/api-response";
import { internalServiceAuthError } from "@/lib/middleware/internal-service";
import { pipelineWorkerEventSchema } from "@/lib/schemas/pipeline";
import { processPipelineWorkerEvent } from "@/services/PipelineService";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const jobIdSchema = z.string().regex(/^pipeline_[a-f\d]{24}_[a-f\d]{32}_(audio-extract|asr|understand|recap|narrate|subtitle|render)$/i);

export async function POST(request: Request, context: { params: { jobId: string } }) {
  try {
    const authError = internalServiceAuthError(request);
    if (authError) return authError;
    const jobId = jobIdSchema.parse(context.params.jobId);
    const event = pipelineWorkerEventSchema.parse(await readJson(request, 8 * 1024 * 1024));
    const data = await processPipelineWorkerEvent(jobId, event);
    return Response.json({ data }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
