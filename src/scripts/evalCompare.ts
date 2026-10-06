import fs from 'node:fs';
import { logger } from '../config/logger.js';
import { compareEvals, type EvalResultFile } from '../ai/eval.js';

/**
 * npm run eval:compare -- --base=eval/results/A.json --other=eval/results/B.json
 *
 * Сравнение двух eval-прогонов (например, до/после смены промпта или модели):
 * дельты метрик + какие кейсы починились/сломались.
 */
function args(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const a of process.argv.slice(2)) {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    if (m) out[m[1]!] = m[2];
  }
  return out;
}

const LABELS: Record<string, string> = {
  createPrecision: 'precision создания',
  createRecall: 'recall создания',
  closeAccuracy: 'точность закрытия',
  cancelAccuracy: 'точность отмены',
  falseTaskRate: 'доля ложных',
  needsReviewShare: 'доля needs_review',
};

function fmt(n: number | null): string {
  return n === null ? '—' : n.toFixed(2);
}

async function main(): Promise<void> {
  const a = args();
  if (!a['base'] || !a['other']) {
    throw new Error('нужны --base=путь.json и --other=путь.json');
  }
  const base = JSON.parse(fs.readFileSync(a['base']!, 'utf-8')) as EvalResultFile;
  const other = JSON.parse(fs.readFileSync(a['other']!, 'utf-8')) as EvalResultFile;
  console.log(`\nbase : ${base.date} ${base.promptVersion} ${base.provider}/${base.model}`);
  console.log(`other: ${other.date} ${other.promptVersion} ${other.provider}/${other.model}\n`);

  const cmp = compareEvals(base, other);
  console.log('метрика'.padEnd(22) + 'base'.padStart(8) + 'other'.padStart(8) + 'delta'.padStart(8));
  for (const [k, v] of Object.entries(cmp.metricDeltas)) {
    const arrow = v.delta === null ? '' : v.delta > 0.0005 ? ' ▲' : v.delta < -0.0005 ? ' ▼' : '';
    console.log(
      (LABELS[k] ?? k).padEnd(22) + fmt(v.base).padStart(8) + fmt(v.other).padStart(8) + (fmt(v.delta) + arrow).padStart(8),
    );
  }
  console.log(`\nпочинилось (${cmp.improved.length}): ${cmp.improved.join(', ') || '—'}`);
  console.log(`сломалось (${cmp.regressed.length}): ${cmp.regressed.join(', ') || '—'}`);
  console.log(`без изменений: ${cmp.unchanged.length}`);
}

main().catch((err) => {
  logger.error({ err }, 'eval:compare failed');
  process.exit(1);
});
