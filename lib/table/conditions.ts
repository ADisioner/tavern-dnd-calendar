// Standard D&D 5e conditions. These are visual markers; rules remain with the group.
export const CONDITION_IDS = ['blinded', 'charmed', 'deafened', 'exhaustion', 'frightened', 'grappled', 'incapacitated', 'invisible', 'paralyzed', 'petrified', 'poisoned', 'prone', 'restrained', 'stunned', 'unconscious'] as const;
export type ConditionId = typeof CONDITION_IDS[number];
export const CONDITIONS: Record<ConditionId, { label: string; short: string; color: string }> = {
  blinded: { label: 'Ослеплён', short: 'Осл', color: '#87b2c2' },
  charmed: { label: 'Очарован', short: 'Оч', color: '#c9939b' },
  deafened: { label: 'Оглохший', short: 'Гл', color: '#87b2c2' },
  exhaustion: { label: 'Истощение', short: 'Ист', color: '#d4b276' },
  frightened: { label: 'Испуган', short: 'Стр', color: '#b49bc9' },
  grappled: { label: 'Схвачен', short: 'Схв', color: '#d4b276' },
  incapacitated: { label: 'Недееспособен', short: 'Нед', color: '#b49bc9' },
  invisible: { label: 'Невидимый', short: 'Нев', color: '#87b2c2' },
  paralyzed: { label: 'Парализован', short: 'Пар', color: '#b49bc9' },
  petrified: { label: 'Окаменевший', short: 'Кам', color: '#b8ae9c' },
  poisoned: { label: 'Отравлен', short: 'Яд', color: '#a8bc8a' },
  prone: { label: 'Сбит с ног', short: 'Сн', color: '#d4b276' },
  restrained: { label: 'Опутан', short: 'Оп', color: '#d4b276' },
  stunned: { label: 'Ошеломлён', short: 'Ош', color: '#b49bc9' },
  unconscious: { label: 'Без сознания', short: 'Бс', color: '#c9939b' },
};
