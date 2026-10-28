import { z } from 'zod';
import { MAX_ASSET_BYTES } from './assets.ts';
import { CommandError } from './scene.ts';
export const assetInputSchema = z.object({ name: z.string().trim().min(1).max(100), kind: z.enum(['image', 'token', 'map', 'document', 'audio']), scope: z.enum(['personal', 'shared']) }).strict();
export function validateAssetUpload(raw: unknown, bytes: Uint8Array) {
  const input = assetInputSchema.parse(raw);
  if (!bytes.length || bytes.length > MAX_ASSET_BYTES) throw new CommandError('limit', 'Размер файла — до 8 МБ.');
  const ascii = (start: number, end: number) => new TextDecoder().decode(bytes.subarray(start, end));
  let mime: string;
  if ([137,80,78,71,13,10,26,10].every((value, i) => bytes[i] === value)) mime = 'image/png';
  else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) mime = 'image/jpeg';
  else if (['GIF87a','GIF89a'].includes(ascii(0,6))) mime = 'image/gif';
  else if (ascii(0,4) === 'RIFF' && ascii(8,12) === 'WEBP') mime = 'image/webp';
  else if (ascii(0,5) === '%PDF-') mime = 'application/pdf';
  else if (ascii(0,4) === 'OggS') mime = 'audio/ogg';
  else if (ascii(0,4) === 'RIFF' && ascii(8,12) === 'WAVE') mime = 'audio/wav';
  else if (ascii(0,3) === 'ID3' || bytes[0] === 255 && (bytes[1] & 0xe0) === 0xe0) mime = 'audio/mpeg';
  else throw new CommandError('invalid', 'Поддерживаются PNG, JPEG, WebP, GIF, PDF, MP3, OGG и WAV.');
  if (['image','map','token'].includes(input.kind) && !mime.startsWith('image/')) throw new CommandError('invalid', 'Для карты или токена выберите изображение.');
  if (input.kind === 'document' && mime !== 'application/pdf' || input.kind === 'audio' && !mime.startsWith('audio/')) throw new CommandError('invalid', 'Тип файла не соответствует материалу.');
  return { input, mime };
}
