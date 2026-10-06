import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FIXTURES } from '../src/ai/fixtures.js';
import { HeuristicProvider } from '../src/ai/providers/heuristic.js';
import type { ConversationInput } from '../src/ai/types.js';

const provider = new HeuristicProvider();

function toInput(fixtureId: string): ConversationInput {
  const f = FIXTURES.find((x) => x.id === fixtureId)!;
  return {
    chatJid: f.chatJid,
    contactName: f.contactPushName,
    messages: f.messages.map((m, i) => ({
      id: 100 + i,
      direction: m.direction,
      senderName: m.senderName,
      text: m.text,
      messageType: m.messageType,
      transcript: null,
      durationSec: null,
      timestamp: 1_700_000_000_000 + m.minuteOffset * 60_000,
      whatsappMessageId: `t-${fixtureId}-${i}`,
    })),
    // completion-report: известная открытая задача, которую закрывает отчёт
    existingTasks:
      fixtureId === 'completion-report'
        ? [{ id: 41, title: 'Посмотреть анализы', status: 'open' as const }]
        : [],
    analyzedAt: 1_700_000_000_000,
  };
}

describe('HeuristicProvider на синтетических переписках', () => {
  for (const f of FIXTURES) {
    it(`${f.id}: ожидаем ${f.expectTasks} задач [${f.expectStatuses.join(',')}]`, async () => {
      const out = await provider.analyzeConversation(toInput(f.id));
      assert.equal(out.tasks.length, f.expectTasks, JSON.stringify(out.tasks));
      assert.deepEqual(out.tasks.map((t) => t.status), f.expectStatuses);
      for (const t of out.tasks) {
        assert.ok(t.confidence >= 0 && t.confidence <= 1);
        assert.ok(t.title.length > 0);
      }
    });
  }

  it('благодарность и вопрос про приём не дают задач (критично)', async () => {
    const thanks = await provider.analyzeConversation(toInput('thanks-only'));
    const q = await provider.analyzeConversation(toInput('reception-question'));
    assert.equal(thanks.tasks.length, 0);
    assert.equal(q.tasks.length, 0);
  });

  it('обещание содержит dueText, выполнение — complete по id', async () => {
    const p = await provider.analyzeConversation(toInput('analyses-evening'));
    assert.ok(p.tasks[0]?.title.toLowerCase().includes('анализы'));
    assert.equal(p.tasks[0]?.dueText, 'сегодня вечером');
    assert.equal(p.tasks[0]?.messageId, 101);
    const c = await provider.analyzeConversation(toInput('completion-report'));
    assert.equal(c.tasks[0]?.action, 'complete');
    assert.equal(c.tasks[0]?.taskId, 41);
    assert.equal(c.tasks[0]?.status, 'done');
  });
});
