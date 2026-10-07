import fs from 'node:fs';
import path from 'node:path';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { caseInput, EVAL_BASE_TS, scoreAll, scoreCase, type EvalResultFile } from '../ai/eval.js';
import { EVAL_CASES } from '../ai/evalFixtures.js';
import { PROMPT_VERSION } from '../ai/prompts.js';
import { createProvider } from '../ai/providerFactory.js';
import { OpenRouterProvider } from '../ai/providers/openrouter.js';
import { OllamaProvider } from '../ai/providers/ollama.js';
import type { AIProvider } from '../ai/types.js';
import { toIsoLocalDate } from '../digest/date.js';

/**
 * npm run eval -- --provider=openrouter --model=google/gemini-2.5-flash [--cases=id1,id2] [--out=path]
 *
 * Прогоняет eval-фикстуры через реальную модель, печатает таблицу по кейсам
 * и метрики, сохраняет результат в eval/results/<дата>-<промпт>-<модель>.json.
 * Без --model берётся модель из .env. Нужен OPENROUTER_API_KEY (или ollama).
 */
function args(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const a of process.argv.slice(2)) {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    if (m) out[m[1]!] = m[2];
  }
  return out;
}

function buildProvider(kind: string, model?: string): AIProvider {
  if (model && kind === 'openrouter') return new OpenRouterProvider({ model });
  if (model && kind === 'ollama') return new OllamaProvider(env.ollamaUrl, model);
  if (model) throw new Error(`--model поддерживается только для openrouter/ollama (провайдер: ${kind})`);
  return createProvider(kind);
}

function fmt(n: number | null): string {
  return n === null ? '—' : n.toFixed(2);
}

async function main(): Promise<void> {
  const a = args();
  const kind = (a['provider'] ?? env.aiProvider).toLowerCase();
  if (kind === 'auto') {
    throw new Error('для eval укажите провайдер явно: --provider=openrouter|ollama|heuristic');
  }
  const provider = buildProvider(kind, a['model']);
  const modelName = provider.model;
  const only = new Set((a['cases'] ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  const cases = EVAL_CASES.filter((c) => only.size === 0 || only.has(c.id));
  if (cases.length === 0) throw new Error('нет кейсов для прогона (проверьте --cases)');

  logger.info({ provider: provider.name, model: modelName, cases: cases.length }, 'eval start');
  const scored = [];
  for (const c of cases) {
    const ctx = caseInput(c, EVAL_BASE_TS);
    let out;
    try {
      out = await provider.analyzeConversation(ctx.input);
    } catch (err) {
      logger.error({ err, case: c.id }, 'провайдер упал на кейсе — засчитано как пусто');
      out = { tasks: [] };
    }
    scored.push(scoreCase(c, out, ctx));
  }

  const metrics = scoreAll(scored);
  console.log(`\nprovider=${provider.name} model=${modelName} prompt=${PROMPT_VERSION} cases=${metrics.evaluated}/${metrics.cases} gaps=${metrics.gaps}`);
  console.log('кейс'.padEnd(22) + 'P'.padStart(6) + 'R'.padStart(6) + 'close'.padStart(7) + 'false'.padStart(7) + 'статус');
  for (const s of scored) {
    const mark = s.pass === null ? 'GAP' : s.pass ? '✓' : '✗';
    const row =
      s.id.padEnd(22) +
      fmt(s.createPrecision).padStart(6) +
      fmt(s.createRecall).padStart(6) +
      fmt(s.correctCompletes / Math.max(1, s.expectedCompletes)).padStart(7) +
      String(s.falseActions).padStart(7) +
      `  ${mark}` +
      (s.notes.length > 0 ? `  // ${s.notes.join('; ')}` : '');
    console.log(row);
  }
  console.log(
    `\nprecision=${fmt(metrics.createPrecision)} recall=${fmt(metrics.createRecall)} ` +
      `closeAcc=${fmt(metrics.closeAccuracy)} cancelAcc=${fmt(metrics.cancelAccuracy)} ` +
      `ложные=${fmt(metrics.falseTaskRate)} needs_review=${fmt(metrics.needsReviewShare)} ` +
      `воскрешения=${metrics.falseResurrect} ложныеЗакрытия=${metrics.falseClose}`,
  );

  const safeModel = modelName.replace(/[^a-zA-Z0-9_.-]+/g, '_');
  const partial = only.size > 0 ? `-partial${cases.length}` : '';
  const file: EvalResultFile = {
    date: toIsoLocalDate(new Date()),
    promptVersion: PROMPT_VERSION,
    provider: provider.name,
    model: modelName,
    metrics,
    cases: scored,
  };
  const dir = 'eval/results';
  fs.mkdirSync(dir, { recursive: true });
  const outPath = a['out'] ?? path.join(dir, `${file.date}-${PROMPT_VERSION}-${safeModel}${partial}.json`);
  fs.writeFileSync(outPath, JSON.stringify(file, null, 2));
  console.log(`сохранено: ${outPath}`);
}

main().catch((err) => {
  logger.error({ err }, 'eval failed');
  process.exit(1);
});
