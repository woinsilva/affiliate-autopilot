import { describe, expect, it } from 'vitest';
import { normalizeOfficialProduct, officialProductSchema, parseListingVideoId, parseOfficialProductPreview } from '../src/official-links.js';

describe('official Mercado Livre links', () => {
  it('accepts official meli.la links and generates a stable id', () => {
    const parsed = officialProductSchema.parse({ affiliateUrl: 'https://meli.la/2j8gNrT', title: 'Jogo de panelas', channels: ['instagram'] });
    expect(normalizeOfficialProduct(parsed).generatedExternalId).toMatch(/^MANUAL-[A-F0-9]{20}$/);
    expect(normalizeOfficialProduct(parsed).generatedExternalId).toBe(normalizeOfficialProduct(parsed).generatedExternalId);
  });

  it('rejects third-party shorteners', () => {
    expect(() => officialProductSchema.parse({ affiliateUrl: 'https://bit.ly/falso', title: 'Produto falso' })).toThrow();
  });

  it('rejects non-Mercado Livre destinations', () => {
    expect(() => officialProductSchema.parse({ affiliateUrl: 'https://meli.la/abc', destinationUrl: 'https://example.com/item', title: 'Produto' })).toThrow();
  });

  it('accepts official Mercado Livre product subdomains', () => {
    expect(() => officialProductSchema.parse({
      affiliateUrl: 'https://meli.la/abc',
      destinationUrl: 'https://produto.mercadolivre.com.br/MLB-123456-produto-_JM',
      title: 'Produto oficial',
    })).not.toThrow();
  });

  it('does not accept domains that only imitate Mercado Livre', () => {
    expect(() => officialProductSchema.parse({
      affiliateUrl: 'https://meli.la/abc',
      destinationUrl: 'https://produto.mercadolivre.com.br.example.com/item',
      title: 'Produto falso',
    })).toThrow();
  });

  it('extracts the first official product card from the affiliate destination', () => {
    const html = `<script>{"polycards":[{"metadata":{"id":"MLB4590121239","url":"www.mercadolivre.com.br/panelas/up/MLBU1"},"pictures":{"pictures":[{"id":"815631-MLB109277052486_042026"}]},"components":[{"type":"title","title":{"text":"Jogo de panelas cerâmicas"}},{"type":"price","price":{"current_price":{"value":491.41,"currency":"BRL"}}}]}]}</script>`;
    expect(parseOfficialProductPreview(html, 'https://meli.la/2j8gNrT')).toMatchObject({
      externalId: 'MLB4590121239', title: 'Jogo de panelas cerâmicas', price: 491.41, currency: 'BRL',
      imageUrl: 'https://http2.mlstatic.com/D_NQ_NP_815631-MLB109277052486_042026-F.jpg',
      imageUrls: ['https://http2.mlstatic.com/D_NQ_NP_815631-MLB109277052486_042026-F.jpg'],
    });
  });

  it('keeps multiple official photos for a slideshow', () => {
    const html = `<script>{"polycards":[{"metadata":{"id":"MLB4590121239","url":"www.mercadolivre.com.br/panelas/up/MLBU1"},"pictures":{"pictures":[{"id":"815631-MLB109277052486_042026"},{"id":"945311-MLB116652919229_082026"}]},"components":[{"type":"title","title":{"text":"Jogo de panelas cerâmicas"}}]}]}</script>`;
    const product = parseOfficialProductPreview(html, 'https://meli.la/2j8gNrT');
    expect(product.imageUrls).toHaveLength(2);
    expect(officialProductSchema.parse({ affiliateUrl: product.affiliateUrl, title: product.title, imageUrls: product.imageUrls, mediaPreference: 'slideshow' }).mediaPreference).toBe('slideshow');
  });

  it('recognizes YouTube video identifiers returned by the official item API', () => {
    expect(parseListingVideoId('abc123;youtube')).toEqual({
      externalId: 'abc123',
      provider: 'youtube',
      previewUrl: 'https://www.youtube.com/watch?v=abc123',
    });
  });

  it('treats absent Mercado Livre video identifiers as no video', () => {
    expect(parseListingVideoId(null)).toBeNull();
    expect(parseListingVideoId('null')).toBeNull();
  });
});
