import { ProjectProcessingScreen } from '@/components/project-processing-screen';

export default function ProjectProcessingPage({
  params,
}: {
  params: { projectId: string };
}) {
  return <ProjectProcessingScreen projectId={params.projectId} />;
}
