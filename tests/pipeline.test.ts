import { describe, expect, it } from 'vitest';
import { duplicatePipelineAction } from '../src/pipeline.js';

describe('duplicatePipelineAction', () => {
  it('cria conteúdo quando o produto ainda não possui conteúdo', () => {
    expect(duplicatePipelineAction(true, null)).toBe('create');
  });

  it('repete uma geração cuja falha foi confirmada', () => {
    expect(duplicatePipelineAction(true, 'failed')).toBe('retry');
  });

  it('não repete operações ativas, concluídas ou incertas', () => {
    expect(duplicatePipelineAction(true, 'generating')).toBe('none');
    expect(duplicatePipelineAction(true, 'awaiting_approval')).toBe('none');
    expect(duplicatePipelineAction(true, 'generation_uncertain')).toBe('none');
  });

  it('não inicia o pipeline sem confirmação explícita', () => {
    expect(duplicatePipelineAction(false, null)).toBe('none');
    expect(duplicatePipelineAction(false, 'failed')).toBe('none');
  });
});
