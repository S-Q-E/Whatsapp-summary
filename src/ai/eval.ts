import type { EvalCase } from './evalFixtures.js';
import type { AnalyzeOutput, ConversationInput, ExistingTaskSummary } from './types.js';

/** id открытой задачи в eval-input (совпадает с heuristic-тестами). */
export const EVAL_OPEN_TASK_ID = 41;

export type CaseInput = {
  input: ConversationInput;
  /** внутренний id сообщения -> индекс в кейсе */
  msgIndexById: Map<number, number>;
};

/** Базовое время eval-прогона: 6 окт 2026, 09:00 Астаны. */
export const EVAL_BASE_TS = Date.UTC(2026, 9, 6, 4, 0, 0);

const DAY = 86_400_000;

/** Кейс -> ConversationInput: id сообщений 100+i, время по dayOffset/часам. */
export function caseInput(c: EvalCase, analyzedAt: number = EVAL_BASE_TS): CaseInput {
  const dayStart = analyzedAt - ((analyzedAt % DAY) + DAY) % DAY;
  const messages = c.messages.map((m, i) => ({
    id: 100 + i,
    direction: (m.from === 'doctor' ? 'outgoing' : 'incoming') as 'incoming' | 'outgoing',
    senderName: m.from === 'doctor' ? null : (m.name ?? 'Собеседник'),
    text: m.text,
    transcript: null,
    messageType: m.messageType ?? 'text',
    durationSec: null,
    timestamp: dayStart + (m.dayOffset ?? 0) * DAY + m.hour * 3_600_000 + m.minute * 60_000,
    whatsappMessageId: `eval-${c.id}-${i}`,
  }));
  const existingTasks: ExistingTaskSummary[] = c.openTask
    ? [{ id: EVAL_OPEN_TASK_ID, title: c.openTask.title, status: 'open' }]
    : [];
  return {
    input: {
      chatJid: `${c.id}@eval.test`,
      contactName: c.kind === 'group' ? 'Группа' : 'Пациент',
      messages,
      existingTasks,
      analyzedAt,
    },
    msgIndexById: new Map(messages.map((m, i) => [m.id, i] as [number, number])),
  };
}

export type ScoredCase = {
  id: string;
  description: string;
  knownGap: string | null;
  expectedCreates: number;
  expectedCompletes: number;
  expectedCancels: number;
  actualCreates: number;
  actualCompletes: number;
  actualCancels: number;
  matchedCreates: number;
  correctCompletes: number;
  correctCancels: number;
  falseActions: number;
  createPrecision: number | null;
  createRecall: number | null;
  needsReviewShare: number | null;
  /** needs_review среди фактических creates кейса (для микро-агрегата) */
  actualNeedsReview: number;
  dueOk: boolean;
  pass: boolean | null;
  notes: string[];
};

export function scoreCase(c: EvalCase, out: AnalyzeOutput, ctx: CaseInput): ScoredCase {
  const notes: string[] = [];
  if (c.expect.knownGap) {
    return {
      id: c.id, description: c.description, knownGap: c.expect.knownGap,
      expectedCreates: c.expect.creates.length, expectedCompletes: c.expect.completes.length,
      expectedCancels: c.expect.cancels.length,
      actualCreates: out.tasks.filter((t) => t.action === 'create').length,
      actualCompletes: out.tasks.filter((t) => t.action === 'complete').length,
      actualCancels: out.tasks.filter((t) => t.action === 'cancel').length,
      matchedCreates: 0, correctCompletes: 0, correctCancels: 0, falseActions: 0,
      createPrecision: null, createRecall: null, needsReviewShare: null, actualNeedsReview: 0, dueOk: true,
      pass: null, notes: [`известный гэп контракта: ${c.expect.knownGap}`],
    };
  }

  // creates: жадное сопоставление по индексу сообщения (с учётом кратности)
  const remaining = [...c.expect.creates];
  let matched = 0;
  let actualNeedsReview = 0;
  const expectedReview = new Set(c.expect.needsReview ?? []);
  const expectedDue = new Set(c.expect.dueDated ?? []);
  let dueOk = true;
  let falseActions = 0;

  for (const t of out.tasks) {
    if (t.action !== 'create') continue;
    const idx = t.messageId === null ? -1 : (ctx.msgIndexById.get(t.messageId) ?? -1);
    const pos = remaining.indexOf(idx);
    if (idx !== -1 && pos !== -1) {
      remaining.splice(pos, 1);
      matched += 1;
      if (t.status === 'needs_review') actualNeedsReview += 1;
      if (expectedReview.has(idx) && t.status !== 'needs_review') {
        notes.push(`create@${idx}: ожидался needs_review`);
      }
      if (!expectedReview.has(idx) && t.status === 'needs_review') {
        notes.push(`create@${idx}: лишний needs_review`);
      }
      if (expectedDue.has(idx) && !t.dueAt) {
        dueOk = false;
        notes.push(`create@${idx}: нет dueAt`);
      }
    } else {
      falseActions += 1;
    }
  }
  const actualCreates = out.tasks.filter((t) => t.action === 'create').length;
  const needsReviewShare = actualCreates > 0
    ? out.tasks.filter((t) => t.action === 'create' && t.status === 'needs_review').length / actualCreates
    : null;

  const actualCompletes = out.tasks.filter((t) => t.action === 'complete');
  const actualCancels = out.tasks.filter((t) => t.action === 'cancel');
  const correctCompletes = actualCompletes.filter(
    (t) => t.taskId === EVAL_OPEN_TASK_ID && t.messageId !== null && c.expect.completes.includes(ctx.msgIndexById.get(t.messageId) ?? -1),
  ).length;
  const correctCancels = actualCancels.filter(
    (t) => t.taskId === EVAL_OPEN_TASK_ID && t.messageId !== null && c.expect.cancels.includes(ctx.msgIndexById.get(t.messageId) ?? -1),
  ).length;
  falseActions += actualCompletes.length - correctCompletes + (actualCancels.length - correctCancels);

  const expectedCreates = c.expect.creates.length;
  const precision = actualCreates > 0 ? matched / actualCreates : expectedCreates === 0 ? 1 : 0;
  const recall = expectedCreates > 0 ? matched / expectedCreates : 1;
  const reviewOk = [...expectedReview].every((idx) =>
    out.tasks.some(
      (t) => t.action === 'create' && t.messageId !== null && ctx.msgIndexById.get(t.messageId) === idx && t.status === 'needs_review',
    ),
  );

  const pass =
    precision === 1 &&
    recall === 1 &&
    correctCompletes === c.expect.completes.length &&
    correctCancels === c.expect.cancels.length &&
    falseActions === 0 &&
    reviewOk &&
    dueOk;

  return {
    id: c.id, description: c.description, knownGap: null,
    expectedCreates, expectedCompletes: c.expect.completes.length, expectedCancels: c.expect.cancels.length,
    actualCreates, actualCompletes: actualCompletes.length, actualCancels: actualCancels.length,
    matchedCreates: matched, correctCompletes, correctCancels, falseActions,
    createPrecision: precision, createRecall: recall, needsReviewShare, actualNeedsReview, dueOk,
    pass, notes,
  };
}

export type EvalMetrics = {
  cases: number;
  evaluated: number;
  gaps: number;
  createPrecision: number | null;
  createRecall: number | null;
  closeAccuracy: number | null;
  cancelAccuracy: number | null;
  falseTaskRate: number | null;
  needsReviewShare: number | null;
};

export function scoreAll(scored: ScoredCase[]): EvalMetrics {
  const ev = scored.filter((s) => s.pass !== null);
  let match = 0;
  let act = 0;
  let exp = 0;
  let correctClose = 0;
  let expClose = 0;
  let correctCancel = 0;
  let expCancel = 0;
  let falseN = 0;
  let totalActual = 0;
  let nrCreates = 0;
  let allCreates = 0;
  for (const s of ev) {
    match += s.matchedCreates;
    act += s.actualCreates;
    exp += s.expectedCreates;
    correctClose += s.correctCompletes;
    expClose += s.expectedCompletes;
    correctCancel += s.correctCancels;
    expCancel += s.expectedCancels;
    falseN += s.falseActions;
    totalActual += s.actualCreates + s.actualCompletes + s.actualCancels;
    nrCreates += s.actualNeedsReview;
    allCreates += s.actualCreates;
  }
  const needsReviewShare = allCreates > 0 ? nrCreates / allCreates : null;
  return {
    cases: scored.length,
    evaluated: ev.length,
    gaps: scored.length - ev.length,
    createPrecision: act > 0 ? match / act : exp === 0 ? 1 : 0,
    createRecall: exp > 0 ? match / exp : 1,
    closeAccuracy: expClose > 0 ? correctClose / expClose : null,
    cancelAccuracy: expCancel > 0 ? correctCancel / expCancel : null,
    falseTaskRate: totalActual > 0 ? falseN / totalActual : 0,
    needsReviewShare,
  };
}

export type EvalResultFile = {
  date: string;
  promptVersion: string;
  provider: string;
  model: string;
  metrics: EvalMetrics;
  cases: ScoredCase[];
};

export type EvalCompare = {
  metricDeltas: Record<string, { base: number | null; other: number | null; delta: number | null }>;
  improved: string[];
  regressed: string[];
  unchanged: string[];
};

export function compareEvals(base: EvalResultFile, other: EvalResultFile): EvalCompare {
  const keys = ['createPrecision', 'createRecall', 'closeAccuracy', 'cancelAccuracy', 'falseTaskRate', 'needsReviewShare'] as const;
  const metricDeltas: EvalCompare['metricDeltas'] = {};
  for (const k of keys) {
    const b = base.metrics[k] ?? null;
    const o = other.metrics[k] ?? null;
    metricDeltas[k] = { base: b, other: o, delta: b !== null && o !== null ? o - b : null };
  }
  const byId = (f: EvalResultFile): Map<string, boolean | null> =>
    new Map(f.cases.map((c) => [c.id, c.pass]));
  const bm = byId(base);
  const om = byId(other);
  const improved: string[] = [];
  const regressed: string[] = [];
  const unchanged: string[] = [];
  for (const [id, b] of bm) {
    if (!om.has(id)) continue;
    const o = om.get(id);
    if (b === o) unchanged.push(id);
    else if (o === true || (b === false && o === null)) improved.push(id);
    else regressed.push(id);
  }
  return { metricDeltas, improved, regressed, unchanged };
}
