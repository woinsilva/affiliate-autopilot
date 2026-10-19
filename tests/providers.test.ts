import { describe, expect, it } from 'vitest';
import { createCopy, createProductVideoPrompt, mockMetrics, waitForInstagramContainer } from '../src/providers.js';

describe('safe deterministic providers', () => {
  it('adds affiliate disclosure to generated copy', () => {
    const result = createCopy('Produto teste', 'https://example.invalid/affiliate');
    expect(result.caption.toLowerCase()).toContain('afiliad');
    expect(result.caption).toContain('https://example.invalid/affiliate');
  });

  it('creates a clean product-only video prompt', () => {
    const prompt = createProductVideoPrompt('Panela de cerâmica');
    expect(prompt).toContain('Panela de cerâmica');
    expect(prompt).toContain('somente o produto');
    expect(prompt).toContain('Não inclua pessoas');
    expect(prompt).toContain('texto na tela');
    expect(prompt).toContain('menções a links');
    expect(prompt).toContain('composição do produto deve permanecer travada');
    expect(prompt).toContain('Não crie, remova, duplique');
    expect(prompt).toContain('sem rotação dos produtos');
  });

  it('generates stable mock metrics for idempotent tests', () => {
    expect(mockMetrics('publication-1')).toEqual(mockMetrics('publication-1'));
    expect(mockMetrics('publication-1').views).toBeGreaterThan(0);
  });

  it('waits for an Instagram video container to finish', async () => {
    const responses = [
      new Response(JSON.stringify({ id: 'container-1', status_code: 'IN_PROGRESS' }), { status: 200 }),
      new Response(JSON.stringify({ id: 'container-1', status_code: 'FINISHED' }), { status: 200 }),
    ];
    const requestedUrls: string[] = [];
    const fetchMock = (async (input: string | URL | Request) => {
      requestedUrls.push(String(input));
      return responses.shift()!;
    }) as typeof fetch;

    const result = await waitForInstagramContainer('container-1', fetchMock, async () => undefined);

    expect(result.status_code).toBe('FINISHED');
    expect(requestedUrls).toHaveLength(2);
    expect(requestedUrls[0]).toContain('graph.instagram.com');
  });

  it('stops when Instagram reports a container error', async () => {
    const fetchMock = (async () => new Response(JSON.stringify({ status_code: 'ERROR', status: 'Video rejected' }), { status: 200 })) as typeof fetch;

    await expect(waitForInstagramContainer('container-2', fetchMock, async () => undefined)).rejects.toThrow('Video rejected');
  });
});
