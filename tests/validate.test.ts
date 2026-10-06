import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AIValidationError, parseModelActions } from '../src/ai/validate.js';
import type { ConversationInput } from '../src/ai/types.js';

const INPUT: ConversationInput = {
  chatJid: 'demo@s.whatsapp.net',
  contactName: 'Пациент',
  messages: [
    { id: 34, direction: 'outgoing', senderName: null, text: 'Посмотрю вечером', messageType: 'text', durationSec: null, timestamp: 1, whatsappMessageId: 'w1' },
    { id: 35, direction: 'outgoing', senderName: null, text: 'Посмотрела, всё в норме', messageType: 'text', durationSec: null, timestamp: 2, whatsappMessageId: 'w2' },
  ],
  existingTasks: [{ id: 12, title: 'Посмотреть анализы', status: 'open' }],
  analyzedAt: 3,
};

const wrap = (actions: unknown): string => JSON.stringify({ actions });

describe('parseModelActions — wire-контракт v3 (шаг 3)', () => {
  it('валидные create (m-ссылка) и complete (t-ссылка)', () => {
    const { actions, dropped } = parseModelActions(
      wrap([
        { type: 'create', taskId: null, title: 'Посмотреть анализы', description: 'd', status: 'open', dueAt: null, dueText: 'сегодня вечером', evidenceMessageId: 'm34', confidence: 0.9 },
        { type: 'complete', taskId: 't12', title: 'Посмотреть анализы', description: null, evidenceMessageId: 'm35', confidence: 0.95 },
      ]),
      INPUT,
    );
    assert.equal(dropped.length, 0);
    assert.equal(actions.length, 2);
    assert.equal(actions[0]?.messageId, 34);
    assert.equal(actions[0]?.status, 'open');
    assert.equal(actions[1]?.action, 'complete');
    assert.equal(actions[1]?.taskId, 12);
    assert.equal(actions[1]?.status, 'done');
    assert.equal(actions[1]?.messageId, 35);
  });

  it('пустой список — валидно', () => {
    assert.deepEqual(parseModelActions(wrap([]), INPUT), { actions: [], dropped: [] });
  });

  it('срезает ```json-ограждения', () => {
    const { actions } = parseModelActions('```json\n' + wrap([]) + '\n```', INPUT);
    assert.deepEqual(actions, []);
  });

  it('неизвестный taskId и messageId — действия отброшены, без текста', () => {
    const { actions, dropped } = parseModelActions(
      wrap([
        { type: 'complete', taskId: 't999', title: 'X', confidence: 0.9, evidenceMessageId: 'm35' },
        { type: 'create', taskId: null, title: 'Y', status: 'open', confidence: 0.5, evidenceMessageId: 'm404' },
        { type: 'create', taskId: null, title: 'Z', status: 'open', confidence: 0.5, evidenceMessageId: 'm34' },
      ]),
      INPUT,
    );
    assert.equal(actions.length, 1);
    assert.equal(actions[0]?.title, 'Z');
    assert.equal(dropped.length, 2);
    assert.ok(dropped[0]?.includes('t999'));
    assert.ok(dropped[1]?.includes('m404'));
    assert.ok(!dropped.join(' ').includes('Посмотр')); // никакого текста переписки
  });

  it('кривой формат ключей отбрасывается (m/x, пусто, число)', () => {
    const { actions, dropped } = parseModelActions(
      wrap([
        { type: 'complete', taskId: 't12x', title: 'X', confidence: 0.5 },
        { type: 'complete', taskId: 12, title: 'X', confidence: 0.5 },
        { type: 'create', taskId: null, title: 'Y', status: 'open', confidence: 0.5, evidenceMessageId: 'msg34' },
      ]),
      INPUT,
    );
    assert.equal(actions.length, 0);
    assert.equal(dropped.length, 3);
  });

  it('структурные ошибки — AIValidationError (повод для retry)', () => {
    assert.throws(() => parseModelActions('конечно, посмотрю!', INPUT), AIValidationError);
    assert.throws(() => parseModelActions(wrap({}), INPUT), AIValidationError);
    assert.throws(
      () => parseModelActions(wrap([{ type: 'update', taskId: null, title: 'X', confidence: 0.5 }]), INPUT),
      AIValidationError,
    );
    assert.throws(
      () => parseModelActions(wrap([{ type: 'create', taskId: 5, title: 'X', status: 'open', confidence: 0.5 }]), INPUT),
      AIValidationError,
    );
    assert.throws(
      () => parseModelActions(wrap([{ type: 'complete', title: 'X', confidence: 0.5 }]), INPUT),
      AIValidationError,
    );
    assert.throws(
      () => parseModelActions(wrap([{ type: 'create', taskId: null, title: '  ', status: 'open', confidence: 0.5 }]), INPUT),
      AIValidationError,
    );
    assert.throws(
      () => parseModelActions(wrap([{ type: 'create', taskId: null, title: 'X', status: 'done', confidence: 0.5 }]), INPUT),
      AIValidationError,
    );
    assert.throws(
      () => parseModelActions(wrap([{ type: 'create', taskId: null, title: 'X', status: 'open', confidence: 2 }]), INPUT),
      AIValidationError,
    );
    assert.throws(
      () => parseModelActions(wrap([{ type: 'create', taskId: null, title: 'X', status: 'open', confidence: 0.5, dueAt: 'когда-нибудь' }]), INPUT),
      AIValidationError,
    );
  });

  it('dueAt ISO проходит, лишние поля срезаются', () => {
    const { actions } = parseModelActions(
      wrap([{ type: 'create', taskId: null, title: 'X', status: 'open', confidence: 0.5, dueAt: '2026-10-06T20:00:00+05:00', extra: 1 }]),
      INPUT,
    );
    assert.equal(actions[0]?.dueAt, '2026-10-06T20:00:00+05:00');
    assert.ok(!('extra' in (actions[0] as object)));
  });
});
