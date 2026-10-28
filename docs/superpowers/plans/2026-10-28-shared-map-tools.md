# Shared Map Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Общая кисть, множественное выделение и постоянные группы на игровом столе.
**Architecture:** Схема сцены хранит drawings и token.groupId. Команды сцены атомарно меняют рисунки/группы, существующий транспорт использует канонический токен группы для lease и распространяет движение на все связанные токены. Canvas управляет локальными жестами; TableApp — выбором и инструментами.
**Tech Stack:** TypeScript, React, Konva, Zod, Node test, D1/R2.
**Spec:** docs/superpowers/specs/2026-10-28-shared-map-tools.md

## Global Constraints

Сохранить совместимость сцен, серверную авторизацию, приватность подготовки мастера, старые сочетания клавиш и контрольные копии. Не добавлять зависимости. Исключить секреты и runtime из checkpoint. Завершить собственные процессы после тестов.

## Review Focus

- Два участника берут разные фигуры одной группы: только один lease.
- Группа у края карты: расстояния между фигурами сохраняются.
- Рисование/рамка при масштабе и сдвиге: координаты мира.
- Повтор/устаревшие команды: нет воскрешения удалённых фигур и штрихов.
- СКМ/пробел и текстовые поля: нет случайного рисования/удаления.

### Task 1: Схема и команды сцены

Files: lib/table/scene.ts; new lib/table/selection.ts; scripts/table-scene.test.mjs; scripts/table-geometry.test.mjs.
Interfaces: token.groupId?: string; scene.drawings defaults []; Drawing {id,color,width,points:number[]}; commands draw {drawing}, erase {drawingId}, group {tokenIds}, ungroup {tokenIds}, remove-many {tokens:{tokenId,expectedVersion}[]}. group uses command.id as groupId; includes all existing groups intersecting selection. ungroup clears whole intersecting groups. Export linkedTokens(scene, token): TableToken[] (canonical sorted by id), boundedGroupPoint(scene,token,point): Point. move shifts full linked group by one clamped delta, increments every changed token version.
- [x] Add failing cases for persistence compatibility, groups, clamped movement, stale versions, shared draw/erase/remove, secret scene isolation.
- [x] Implement validated commands, bounded points/length/count, no mutation of input; tests green.

### Task 2: Групповое движение через транспорт

Files: app/table/use-table-room.ts; lib/table/motion.ts; lib/table/hosted-room.ts; scripts/table-server.mjs; scripts/table-motion.test.mjs; scripts/hosted-table-checks.mjs.
Consumes linkedTokens/boundedGroupPoint. Existing startMotion/previewMotion/endMotion public signatures remain unchanged. Client canonicalizes all group motion to linkedTokens()[0]; adjusts input position by anchor offsets. Server rejects noncanonical motion-start and checks any group mutation against active leases. Frame consumption updates linked tracks, committed event includes tokens array for changed group, consumers merge full array. Moving different figures of one group cannot create independent leases. Pending removal concurrency guards must remain intact. Group/remove-many/ungroup must not mutate moving groups.
- [x] Add failing transport tests for simultaneous grabs and full group convergence/persistence.
- [x] Implement, verify existing tests plus hosted integration.

### Task 3: Жесты Canvas

Files: app/table/table-canvas.tsx; scripts/table-input.test.mjs.
Interfaces: tool union 'select'|'pan'|'draw'|'erase'; optional selectedIds:string[], onSelect(id, additive?:boolean), onSelectMany(ids,additive?:boolean), brushColor:string, brushWidth:number, onDraw(drawing), onErase(drawingId). Keep selectedId backwards compatible. Drawing from scene.drawings; layer below tokens; temporary draft. Frame selection in world coords calls onSelectMany, Shift additive. Clicking/tapping token calls onSelect with modifier; group drag uses existing callbacks. Maintain SКМ capture and Space overrides, no token drag in draw/erase. Helper lib/table/selection.ts can supply rectangle membership.
- [x] Add focused failing interaction cases, implement drawing/eraser/selection with mouse and single touch, preserve pinch and pan.
- [x] Verify input tests and TypeScript.

### Task 4: Панель и клавиатура

Files: app/table/table-app.tsx; app/table/use-token-keyboard.ts; app/table/table.css; scripts/table-keyboard.test.mjs.
Own selectedIds with primary last item, filter through scene current tokens; Shift toggles whole persistent group; group/ungroup selection buttons; brush tools/options inherit current CSS. removeToken callback sends remove-many for current selection with token versions; single preserves remove. Inspector edit form for primary token, multi count and controls. Delete ignores repeat, inputs/dialogs, offline/pending and modifiers.
- [x] Extend keyboard tests; implement panel and selection orchestration.
- [x] Integrate all tasks; review and run npm test, TypeScript, production build, hosted integration and representative browser checks.
- [x] Update Russian knowledge and journal; checkpoint; publish through Sites and connected GitHub only; verify deployment and stop owned runtimes.

Проверено: 104 теста, TypeScript, production build, hosted integration, браузер. Публикация завершается родительским агентом.
