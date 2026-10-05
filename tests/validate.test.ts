import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AIValidationError, parseModelOutput } from '../src/ai/validate.js';

describe('parseModelOutput — строгий JSON-контракт', () => {
  it('принимает валидный результат с create и update', () => {
    const out = parseModelOutput(`{"tasks": [
      {"action":"create","matchTitle":null,"title":"Посмотреть анализы","description":"Обещание вечером","status":"pending","deadline":null,"deadlineText":"сегодня вечером","confidence":0.9,"sourceMessageId":"MSG1"},
      {"action":"update","matchTitle":"Посмотреть анализы","title":"Посмотреть анализы","description":null,"status":"completed","deadline":null,"deadlineText":null,"confidence":0.95,"sourceMessageId":"MSG9"}
    ]}`);
    assert.equal(out.tasks.length, 2);
    assert.equal(out.tasks[0]?.status, 'pending');
    assert.equal(out.tasks[1]?.action, 'update');
  });

  it('пустой список — валидный ответ (благодарности/вопросы)', () => {
    assert.deepEqual(parseModelOutput('{"tasks": []}'), { tasks: [] });
  });

  it('срезает ```json-ограждения', () => {
    const out = parseModelOutput('```json\n{"tasks": []}\n```');
    assert.deepEqual(out, { tasks: [] });
  });

  it('отклоняет неверный status', () => {
    assert.throws(
      () => parseModelOutput('{"tasks": [{"action":"create","title":"X","status":"done","confidence":0.5}]}'),
      AIValidationError,
    );
  });

  it('отклоняет confidence вне 0..1', () => {
    assert.throws(
      () => parseModelOutput('{"tasks": [{"action":"create","title":"X","status":"pending","confidence":1.5}]}'),
      AIValidationError,
    );
  });

  it('отклоняет пустой title', () => {
    assert.throws(
      () => parseModelOutput('{"tasks": [{"action":"create","title":"  ","status":"pending","confidence":0.5}]}'),
      AIValidationError,
    );
  });

  it('отклоняет мусор вместо JSON', () => {
    assert.throws(() => parseModelOutput('конечно, посмотрю вечером!'), AIValidationError);
  });

  it('отклоняет невалидный deadline, null — ок', () => {
    assert.throws(
      () => parseModelOutput('{"tasks": [{"action":"create","title":"X","status":"pending","confidence":0.5,"deadline":"когда-нибудь"}]}'),
      AIValidationError,
    );
    const ok = parseModelOutput(
      '{"tasks": [{"action":"create","title":"X","status":"pending","confidence":0.5,"deadline":"2026-10-06T20:00:00+06:00"}]}',
    );
    assert.equal(ok.tasks[0]?.deadline, '2026-10-06T20:00:00+06:00');
  });

  it('срезает лишние поля модели', () => {
    const out = parseModelOutput('{"tasks": [{"action":"create","title":"X","status":"pending","confidence":0.5,"extra":"drop me"}],"foo":1}');
    assert.deepEqual(out, {
      tasks: [{ action: 'create', matchTitle: null, title: 'X', description: null, status: 'pending', deadline: null, deadlineText: null, confidence: 0.5, sourceMessageId: null }],
    });
  });
});
