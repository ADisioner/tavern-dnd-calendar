export type LibraryAsset = {
  id: string; ownerId: string; ownerName: string; campaignId: string | null;
  name: string; kind: 'image' | 'token' | 'map' | 'document' | 'audio';
  mime: string; size: number; createdAt: number; archived?: boolean;
};
export const MAX_ASSET_BYTES = 8 * 1024 * 1024;
export function assetUrl(campaignId: string, assetId: string) {
  return '/api/table/library?campaign=' + encodeURIComponent(campaignId) + '&asset=' + encodeURIComponent(assetId);
}
