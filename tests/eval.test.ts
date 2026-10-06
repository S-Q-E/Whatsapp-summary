import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { caseInput, compareEvals, scoreAll, scoreCase, type ScoredCase } from '../src/ai/eval.js';
import type { AnalyzeOutput } from '../src/ai/types.js';
import { EVAL_CASES } from '../src/ai/evalFixtures.js';

const T = (id: string): NonNullable<ReturnType<typeof EVAL_CASES.find>> =>
  EVAL_CASES.find((c) => c.id === id)!;

function out(tasks: AnalyzeOutput['tasks']): AnalyzeOutput {
  return { tasks };
}

const mk = (
  action: 'create' | 'complete' | 'cancel',
  msgIdx: number | null,
  extra: Partial<AnalyzeOutput['tasks'][number]> = {},
): AnalyzeOutput['tasks'][number] => ({
  action,
  taskId: action === 'create' ? null : 41,
  title: 'T',
  description: null,
  status: action === 'create' ? 'open' : action === 'complete' ? 'done' : 'cancelled',
  dueAt: null,
  dueText: null,
  confidence: 0.9,
  messageId: msgIdx === null ? null : 100 + msgIdx,
  ...extra,
});

describe('eval: построение input', () => {
  it('id сообщений 100+i, открытая задача id 41, 27 кейсов', () => {
    assert.ok(EVAL_CASES.length >= 25);
    const { input, msgIndexById } = caseInput(T('promise-basic'), 1_000_000);
    assert.deepEqual(input.messages.map((m) => m.id), [100, 101]);
    assert.equal(msgIndexById.get(101), 1);
    assert.deepEqual(input.existingTasks, []);
    const withTask = caseInput(T('fulfill-report'), 1_000_000);
    assert.deepEqual(withTask.input.existingTasks, [{ id: 41, title: 'Посмотреть анализы', status: 'open' }]);
  });
});

describe('eval: скоринг кейса', () => {
  it('идеальный прогон — pass', () => {
    const c = T('promise-basic');
    const s = scoreCase(c, out([mk('create', 1)]), caseInput(c, 0));
    assert.equal(s.pass, true);
    assert.equal(s.createPrecision, 1);
    assert.equal(s.createRecall, 1);
  });

  it('лишняя задача — падает precision, falseActions растёт', () => {
    const c = T('thanks-noise');
    const s = scoreCase(c, out([mk('create', 0)]), caseInput(c, 0));
    assert.equal(s.pass, false);
    assert.equal(s.createPrecision, 0);
    assert.equal(s.falseActions, 1);
  });

  it('пропущенное обещание — падает recall', () => {
    const c = T('promise-basic');
    const s = scoreCase(c, out([]), caseInput(c, 0));
    assert.equal(s.createRecall, 0);
    assert.equal(s.pass, false);
  });

  it('закрытие чужой/не той задачей — неверно', () => {
    const c = T('fulfill-report');
    const wrong = mk('complete', 1);
    wrong.taskId = 999;
    const s = scoreCase(c, out([wrong]), caseInput(c, 0));
    assert.equal(s.correctCompletes, 0);
    assert.equal(s.pass, false);
  });

  it('needs_review и dueAt проверяются', () => {
    const c = T('ambiguous');
    const good = scoreCase(c, out([{ ...mk('create', 1), status: 'needs_review', confidence: 0.3 }]), caseInput(c, 0));
    assert.equal(good.pass, true);
    const bad = scoreCase(c, out([mk('create', 1)]), caseInput(c, 0));
    assert.equal(bad.pass, false);
    const d = T('document-send');
    const noDue = scoreCase(d, out([mk('create', 1)]), caseInput(d, 0));
    assert.equal(noDue.pass, false);
  });

  it('knownGap — вне метрик, pass null', () => {
    const c = T('reschedule');
    const s = scoreCase(c, out([mk('create', 1)]), caseInput(c, 0));
    assert.equal(s.pass, null);
  });
});

describe('eval: агрегаты и сравнение', () => {
  const fake = (id: string, tasks: AnalyzeOutput['tasks']): ScoredCase => {
    const c = T(id);
    return scoreCase(c, out(tasks), caseInput(c, 0));
  };

  it('scoreAll считает micro-precision/recall и доли', () => {
    const all = scoreAll([
      fake('promise-basic', [mk('create', 1)]),
      fake('thanks-noise', [mk('create', 0)]),
    ]);
    assert.equal(all.evaluated, 2);
    assert.equal(all.createPrecision, 0.5);
    assert.equal(all.createRecall, 1);
    assert.equal(all.falseTaskRate, 0.5);
  });

  it('compareEvals показывает дельты и регрессы', () => {
    const base = { metrics: { createPrecision: 0.5, createRecall: 1, customary: 0 }, cases: [{ id: 'a', pass: false }] };
    const other = { metrics: { createPrecision: 1, createRecall: 1, customary: 0 }, cases: [{ id: 'a', pass: true }] };
    const cmp = compareEvals(base as never, other as never);
    assert.equal(cmp.improved[0], 'a');
    assert.deepEqual(cmp.metricDeltas.createPrecision, { base: 0.5, other: 1, delta: 0.5 });
  });
});
