import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('safety configuration', () => {
  it('keeps external side effects disabled in safe mode', async () => {
    vi.stubEnv('SNAPGEN_MODE', 'mock');
    vi.stubEnv('PUBLISH_MODE', 'mock');
    vi.stubEnv('ALLOW_PAID_OPERATIONS', 'false');
    vi.stubEnv('ALLOW_REAL_PUBLISHING', 'false');
    const { config, validateLiveConfiguration } = await import('../src/config.js');

    expect(config.ALLOW_PAID_OPERATIONS).toBe(false);
    expect(config.ALLOW_REAL_PUBLISHING).toBe(false);
    expect(validateLiveConfiguration()).toEqual([]);
  });
});
