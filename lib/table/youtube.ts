const videoIdPattern = /^[a-zA-Z0-9_-]{11}$/;

export function parseYouTubeVideoId(input: string): string | null {
  const value = input.trim();
  if (videoIdPattern.test(value)) return value;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase();
  if (host === 'youtu.be' || host === 'www.youtu.be') {
    const id = url.pathname.split('/').filter(Boolean)[0] ?? '';
    return videoIdPattern.test(id) ? id : null;
  }
  if (!['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(host)) return null;
  const segments = url.pathname.split('/').filter(Boolean);
  const id = url.pathname === '/watch' ? url.searchParams.get('v') ?? ''
    : ['embed', 'shorts', 'live'].includes(segments[0] ?? '') ? segments[1] ?? '' : '';
  return videoIdPattern.test(id) ? id : null;
}

export type YouTubeStatusFetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;
export type YouTubeVideoStatus = { title: string; embeddable: boolean; madeForKids: boolean };

export async function getYouTubeVideoStatus(apiKey: string | undefined, videoId: string, fetcher: YouTubeStatusFetcher = fetch): Promise<YouTubeVideoStatus> {
  if (!apiKey?.trim()) throw new Error('Не настроен серверный ключ YouTube Data API.');
  if (!videoIdPattern.test(videoId)) throw new Error('Некорректный идентификатор YouTube-видео.');
  const url = new URL('https://www.googleapis.com/youtube/v3/videos');
  url.search = new URLSearchParams({ part: 'id,status,snippet', id: videoId, key: apiKey.trim() }).toString();
  const response = await fetcher(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error('Не удалось проверить видео через YouTube Data API.');
  const payload = await response.json() as { items?: { id?: string; snippet?: { title?: string }; status?: { embeddable?: boolean; madeForKids?: boolean } }[] };
  const video = payload.items?.find(item => item.id === videoId);
  if (!video || !video.snippet?.title?.trim() || typeof video.status?.embeddable !== 'boolean' || typeof video.status.madeForKids !== 'boolean')
    throw new Error('YouTube не вернул подтверждённый статус видео для встраивания.');
  return { title: video.snippet.title.trim(), embeddable: video.status.embeddable, madeForKids: video.status.madeForKids };
}
