import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('custom SnapGen settings', () => {
  it('forwards the selected model, duration, format, resolution, and mode', async () => {
    vi.stubEnv('SNAPGEN_MODE', 'live');
    vi.stubEnv('ALLOW_PAID_OPERATIONS', 'true');
    vi.stubEnv('SNAPGEN_API_KEY', 'test-key');
    vi.stubEnv('SNAPGEN_BASE_URL', 'https://middleware.example');
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      void input;
      void init;
      return new Response(JSON.stringify({
        uuid: 'generation-1', status: 'processing', estimatedCredit: 12,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { generateVideo } = await import('../src/providers.js');

    const result = await generateVideo({
      title: 'Produto', script: 'Roteiro', imageUrl: 'https://example.com/product.jpg',
      model: 'seedance-2', duration: 8, aspectRatio: '9:16', resolution: '720p', mode: 'pro',
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({ model: 'seedance-2', duration: 8, aspect_ratio: '9:16', resolution: '720p', mode: 'pro' });
    expect(result.estimatedCredit).toBe(12);
  });
});
