// D&D conditions plus manual concentration and death markers. Rules effects remain with the group.
export const CONDITION_IDS = ['blinded', 'charmed', 'deafened', 'exhaustion', 'frightened', 'grappled', 'incapacitated', 'invisible', 'paralyzed', 'petrified', 'poisoned', 'prone', 'restrained', 'stunned', 'unconscious', 'concentration', 'dead'] as const;
export type ConditionId = typeof CONDITION_IDS[number];
export const CONDITIONS: Record<ConditionId, { label: string; short: string; color: string; icon: string }> = {
  blinded: { label: 'Ослеплён', short: 'Осл', color: '#87b2c2', icon: 'M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6M4 20 20 4M9 12a3 3 0 0 0 3 3' },
  charmed: { label: 'Очарован', short: 'Оч', color: '#c9939b', icon: 'M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21l7.8-7.5 1.1-1.1a5.5 5.5 0 0 0-.1-7.8z' },
  deafened: { label: 'Оглохший', short: 'Гл', color: '#87b2c2', icon: 'M3 10a9 9 0 0 1 17.7-2.4c.8 3-1 4.5-3 6.2-1.5 1.3-2.7 2.2-2.7 4.2a3 3 0 0 1-6 0M9 10a3 3 0 0 1 6 0c0 1.5-.8 2.3-2 3.3M4 4l16 16' },
  exhaustion: { label: 'Истощение', short: 'Ист', color: '#d4b276', icon: 'M6 3h12M6 21h12M7 4c0 4 5 5 5 8s-5 4-5 8M17 4c0 4-5 5-5 8s5 4 5 8M9 8h6M9 16h6' },
  frightened: { label: 'Испуган', short: 'Стр', color: '#b49bc9', icon: 'M12 22a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8.5 10h.1M15.5 10h.1M9 16c1-2 5-2 6 0M12 2v2M3 5l2 2M21 5l-2 2' },
  grappled: { label: 'Схвачен', short: 'Схв', color: '#d4b276', icon: 'M10 13a5 5 0 0 0 7.1 0l3-3A5 5 0 0 0 13 2.9l-1.7 1.7M14 11a5 5 0 0 0-7.1 0l-3 3A5 5 0 0 0 11 21.1l1.7-1.7M8 16l8-8' },
  incapacitated: { label: 'Недееспособен', short: 'Нед', color: '#b49bc9', icon: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM8 8l8 8M16 8l-8 8' },
  invisible: { label: 'Невидимый', short: 'Нев', color: '#87b2c2', icon: 'M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM3 3l18 18' },
  paralyzed: { label: 'Парализован', short: 'Пар', color: '#b49bc9', icon: 'M12 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 9v6M7 12h10M9 21l3-6 3 6M4 4l16 16' },
  petrified: { label: 'Окаменевший', short: 'Кам', color: '#b8ae9c', icon: 'M12 2 20 7v10l-8 5-8-5V7l8-5zM12 2v20M4 7l8 5 8-5M4 17l8-5' },
  poisoned: { label: 'Отравлен', short: 'Яд', color: '#a8bc8a', icon: 'M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3M8 15h8M10 18h.1M14 18h.1' },
  prone: { label: 'Сбит с ног', short: 'Сн', color: '#d4b276', icon: 'M5 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM7 8l5 2 3 4M9 10l-4 4-3 1M13 10l5 1 3 4M6 17h14' },
  restrained: { label: 'Опутан', short: 'Оп', color: '#d4b276', icon: 'M7 8a4 4 0 1 1 8 0c0 2-1.5 3-3 4s-3 2-3 4a4 4 0 1 0 8 0M5 12h3M16 12h3M12 2v3M12 19v3' },
  stunned: { label: 'Ошеломлён', short: 'Ош', color: '#b49bc9', icon: 'm12 2 2.1 6.2L20 5l-3.2 5.9L23 13l-6.6 1.4L19 21l-6-3-3 5-1-6.8L2 18l4-5-5-3 6.8-.5L7 3l4 4 1-5z' },
  unconscious: { label: 'Без сознания', short: 'Бс', color: '#c9939b', icon: 'M4 10s2-3 5-3M15 7s3 0 5 3M9 15s3-2 6 0M4 4h5l-5 5h5M15 4h5l-5 5h5' },
  concentration: { label: 'Концентрация', short: 'Конц', color: '#87b2c2', icon: 'M12 3a9 9 0 1 0 9 9M12 7a5 5 0 1 0 5 5M12 11a1 1 0 1 0 1 1M18 2v6M15 5h6' },
  dead: { label: 'Смерть', short: 'Смерть', color: '#c9939b', icon: 'M12 3a8 8 0 0 0-8 8v4l2 2v3h12v-3l2-2v-4a8 8 0 0 0-8-8zM8 11h2M14 11h2M9 15h6M10 20v2M14 20v2' },
};
