import { z } from 'zod';

export const DICE_SIDES = [4, 6, 8, 10, 12, 20, 100] as const;
export const rollModeSchema = z.enum(['normal', 'advantage', 'disadvantage']);
export const rollVisibilitySchema = z.enum(['public', 'private', 'gm']);
export type RollMode = z.infer<typeof rollModeSchema>;
export const dieSchema = z.object({ sides: z.number().int(), value: z.number().int(), kept: z.boolean(), sign: z.union([z.literal(1), z.literal(-1)]) }).strict();
export const rollRecordSchema = z.object({ id: z.string().uuid(), authorId: z.string().uuid(), authorName: z.string().max(80),
  npc: z.string().max(80).optional(), visibility: rollVisibilitySchema, formula: z.string().max(160), mode: rollModeSchema,
  dice: z.array(dieSchema).max(40), modifier: z.number().int(), total: z.number().int(), createdAt: z.number().int() }).strict();
export type RollRecord = z.infer<typeof rollRecordSchema>;

// Rejection sampling avoids modulo bias, in both Workers and Node.
export function randomDie(sides: number): number {
  if (!Number.isInteger(sides) || sides < 2 || sides > 100) throw new Error('Некорректный кубик.');
  const limit = Math.floor(0x100000000 / sides) * sides, word = new Uint32Array(1);
  do { crypto.getRandomValues(word); } while (word[0] >= limit);
  return word[0] % sides + 1;
}
export function percentileValue(tens: number, units: number) { return tens * 10 + units || 100; }
export function percentilePair(value: number) { return value === 100 ? [0, 0] : [Math.floor(value / 10), value % 10]; }
export function evaluateDice(input: string, mode: RollMode = 'normal', random = randomDie) {
  const formula = input.toLowerCase().replace(/\s/g, '');
  if (!formula || formula.length > 160 || !/^[+-]?(?:\d*d(?:100|20|12|10|8|6|4)|\d+)(?:[+-](?:\d*d(?:100|20|12|10|8|6|4)|\d+))*$/.test(formula)) throw new Error('Формула: например 2d6+3 или d20+5.');
  const terms = formula.match(/[+-]?[^+-]+/g)!;
  let physical = 0, modifier = 0;
  const groups: { count: number; sides: number; sign: 1 | -1 }[] = [];
  for (const term of terms) {
    const sign = term.startsWith('-') ? -1 : 1, text = term.replace(/^[+-]/, '');
    if (!text.includes('d')) { const value = Number(text); if (!Number.isSafeInteger(value) || value > 10000) throw new Error('Модификатор не больше 10000.'); modifier += sign * value; continue; }
    const [countText, sideText] = text.split('d'), count = Number(countText || 1), sides = Number(sideText);
    if (count < 1 || count > 40) throw new Error('От 1 до 40 кубиков.');
    if (mode !== 'normal' && sides !== 20) throw new Error('Преимущество и помеха применяются к d20.');
    physical += count * (sides === 100 || mode !== 'normal' ? 2 : 1);
    if (physical > 40) throw new Error('В лотке доступно до 40 физических кубиков.');
    groups.push({ count, sides, sign });
  }
  if (!groups.length) throw new Error('Добавьте хотя бы один кубик.');
  const dice: z.infer<typeof dieSchema>[] = [];
  for (const { count, sides, sign } of groups) for (let n = 0; n < count; n++) {
    const first = sides === 100 ? percentileValue(random(10) - 1, random(10) - 1) : random(sides);
    if (mode === 'normal') dice.push({ sides, value: first, sign, kept: true });
    else { const second = random(sides), takeFirst = mode === 'advantage' ? first >= second : first <= second;
      dice.push({ sides, value: first, sign, kept: takeFirst }, { sides, value: second, sign, kept: !takeFirst }); }
  }
  return { formula, mode, dice, modifier, total: modifier + dice.reduce((sum, die) => sum + (die.kept ? die.sign * die.value : 0), 0) };
}
export function canSeeRoll(roll: Pick<RollRecord, 'visibility' | 'authorId'>, actor: { userId: string; role: string }) {
  return roll.visibility === 'public' || actor.role === 'master' || roll.visibility === 'private' && roll.authorId === actor.userId;
}
