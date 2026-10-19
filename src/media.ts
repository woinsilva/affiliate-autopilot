import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rename, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const mediaDirectory = process.env.MEDIA_DIRECTORY || '/app/media';
const maxImageBytes = 10 * 1024 * 1024;

export function mediaFilePath(contentId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(contentId)) throw new Error('Identificador de mídia inválido');
  return resolve(mediaDirectory, `${contentId}.mp4`);
}

export async function readMediaFile(contentId: string): Promise<Buffer> {
  return readFile(mediaFilePath(contentId));
}

async function downloadProductImage(url: string): Promise<Buffer> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'http2.mlstatic.com') throw new Error('A imagem não pertence ao CDN oficial do Mercado Livre');
  const response = await fetch(parsed, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`A imagem do anúncio respondeu HTTP ${response.status}`);
  const contentType = response.headers.get('content-type') ?? '';
  if (!/^image\/(jpeg|png|webp)/i.test(contentType)) throw new Error('O anúncio não retornou uma imagem válida');
  if (Number(response.headers.get('content-length') ?? 0) > maxImageBytes) throw new Error('Uma imagem do anúncio excede 10 MB');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > maxImageBytes) throw new Error('Uma imagem do anúncio está vazia ou excede 10 MB');
  return bytes;
}

async function runFfmpeg(args: string[]): Promise<void> {
  await new Promise<void>((done, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? done() : reject(new Error(`FFmpeg falhou (${code}): ${stderr.slice(-500)}`)));
  });
}

export async function renderProductSlideshow(contentId: string, imageUrls: string[]): Promise<string> {
  const urls = [...new Set(imageUrls)].slice(0, 5);
  if (urls.length < 2) throw new Error('O carrossel precisa de ao menos duas imagens do produto');
  const temp = await mkdtemp(join(tmpdir(), 'achadinhos-media-'));
  const output = mediaFilePath(contentId);
  const pending = join(temp, 'video.mp4');
  try {
    const inputs: string[] = [];
    for (let index = 0; index < urls.length; index += 1) {
      const path = join(temp, `image-${index}.img`);
      await writeFile(path, await downloadProductImage(urls[index]!));
      inputs.push(path);
    }
    const secondsPerImage = Math.max(2, Math.ceil(10 / inputs.length));
    const filter = inputs.map((_, index) => `[${index}:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p,trim=duration=${secondsPerImage},setpts=PTS-STARTPTS[v${index}]`).join(';')
      + `;${inputs.map((_, index) => `[v${index}]`).join('')}concat=n=${inputs.length}:v=1:a=0[out]`;
    await runFfmpeg([
      '-hide_banner', '-loglevel', 'error', '-y',
      ...inputs.flatMap((path) => ['-loop', '1', '-framerate', '24', '-t', String(secondsPerImage), '-i', path]),
      '-filter_complex', filter, '-map', '[out]', '-r', '24', '-c:v', 'libx264', '-preset', 'veryfast',
      '-crf', '25', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', pending,
    ]);
    await mkdir(mediaDirectory, { recursive: true });
    await rename(pending, output);
    return `/api/media/${contentId}.mp4`;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
