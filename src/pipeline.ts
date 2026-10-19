export type DuplicatePipelineAction = 'create' | 'retry' | 'none';

export function duplicatePipelineAction(startPipeline: boolean, contentStatus: string | null): DuplicatePipelineAction {
  if (!startPipeline) return 'none';
  if (contentStatus === null) return 'create';
  if (contentStatus === 'failed') return 'retry';
  return 'none';
}
