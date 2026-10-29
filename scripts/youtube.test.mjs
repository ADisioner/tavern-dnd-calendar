import test from 'node:test';
import assert from 'node:assert/strict';
const youtube = await import('../lib/table/youtube.ts').catch(() => ({}));

test('YouTube links are reduced to safe video IDs from supported URL forms', () => {
  for (const [url, expected] of [
    ['dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ?t=25', 'dQw4w9WgXcQ'],
    ['https://youtu.be/FC1pMjDdjng?list=RDFC1pMjDdjng', 'FC1pMjDdjng'],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=abc', 'dQw4w9WgXcQ'],
    ['https://youtube.com/shorts/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://music.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
  ]) assert.equal(youtube.parseYouTubeVideoId?.(url), expected);
  for (const url of ['https://evil.example/watch?v=dQw4w9WgXcQ', 'http://youtu.be/dQw4w9WgXcQ', 'https://youtube.com/playlist?list=abc', 'garbage'])
    assert.equal(youtube.parseYouTubeVideoId?.(url), null);
});

test('YouTube status lookup returns the source title, uses the server key and rejects missing, restricted or unverified videos', async () => {
  let requestUrl;
  const fetcher = async url => { requestUrl = new URL(url); return { ok: true, json: async () => ({ items: [{ id: 'dQw4w9WgXcQ', snippet: { title: 'Название из YouTube' }, status: { embeddable: true, madeForKids: false } }] }) }; };
  assert.deepEqual(await youtube.getYouTubeVideoStatus?.('server-key', 'dQw4w9WgXcQ', fetcher), { title: 'Название из YouTube', embeddable: true, madeForKids: false });
  assert.equal(requestUrl.searchParams.get('key'), 'server-key');
  assert.equal(requestUrl.searchParams.get('part'), 'id,status,snippet');
  await assert.rejects(youtube.getYouTubeVideoStatus?.(undefined, 'dQw4w9WgXcQ', fetcher), /ключ/);
  await assert.rejects(youtube.getYouTubeVideoStatus?.('key', 'dQw4w9WgXcQ', async () => ({ ok: true, json: async () => ({ items: [] }) })), /статус/);
});
