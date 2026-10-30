export type CampaignRole = 'master' | 'player';

export function parseCampaignRoles(value: unknown): CampaignRole[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2 || value.some(role => role !== 'master' && role !== 'player') || new Set(value).size !== value.length) {
    throw new Error('Выберите одну или обе роли кампании.');
  }
  return (['master', 'player'] as const).filter(role => value.includes(role));
}

export function campaignRoleValue(roles: CampaignRole[]): string {
  return roles.join(',');
}
