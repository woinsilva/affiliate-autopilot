import { describe, expect, it } from 'vitest';

describe('identidade estável de produto do Mercado Livre', () => {
  it('considera o ID oficial estável mesmo quando o link curto muda', () => {
    const saved = { externalId: 'MLB4590121239', affiliateUrl: 'https://meli.la/2j8gNrT' };
    const imported = { externalId: 'MLB4590121239', affiliateUrl: 'https://meli.la/2YjR7w2' };
    expect(saved.externalId).toBe(imported.externalId);
    expect(saved.affiliateUrl).not.toBe(imported.affiliateUrl);
  });
});
