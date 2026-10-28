// Existing single-role memberships remain valid; combined roles use the same column.
export type CampaignRole = 'master' | 'player';
export function hasCampaignRole(member: { role: string } | null | undefined, role: CampaignRole): boolean {
  return member?.role.split(',').includes(role) ?? false;
}
export function campaignRoleLabel(member: { role: string }): string {
  if (hasCampaignRole(member, 'master')) return hasCampaignRole(member, 'player') ? 'ДМ и игрок' : 'ДМ';
  return 'Игрок';
}
// The table's permission protocol uses the highest role, independently of player status.
export function tableRole(member: { role: string }): CampaignRole {
  return hasCampaignRole(member, 'master') ? 'master' : 'player';
}
