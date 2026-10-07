import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { HeuristicProvider } from './providers/heuristic.js';
import { MockProvider } from './providers/mock.js';
import { OllamaProvider } from './providers/ollama.js';
import { OpenRouterProvider } from './providers/openrouter.js';
import type { AIProvider, AnalyzeOutput, ConversationInput } from './types.js';

export type ProviderKind = 'auto' | 'openrouter' | 'ollama' | 'heuristic' | 'mock';

/**
 * Точка замены провайдера: новый класс + одна ветка, без изменений
 * taskService и CLI.
 */
export function createProvider(kind?: string): AIProvider {
  const k = (kind ?? env.aiProvider).toLowerCase();
  if (k === 'openrouter') return new OpenRouterProvider();
  if (k === 'ollama') return new OllamaProvider();
  if (k === 'heuristic') return new HeuristicProvider();
  if (k === 'mock') return new MockProvider();
  if (k === 'auto') {
    // Облако в приоритете, если задан ключ: ноутбуку не тянуть модели локально.
    const primary = env.openrouterApiKey ? new OpenRouterProvider() : new OllamaProvider();
    return new AutoProvider(primary, new HeuristicProvider(), env.allowHeuristicFallback);
  }
  throw new Error(`Unknown AI provider "${k}" (expected auto|openrouter|ollama|heuristic|mock)`);
}

/**
 * auto: каждый вызов сначала пробует primary (без залипания:
 * временный сбой не переключает навсегда). Fallback на эвристику
 * ВЫКЛЮЧЕН по умолчанию (ALLOW_HEURISTIC_FALLBACK=false) — ошибка primary
 * пробрасывается наружу, сообщения остаются необработанными.
 * Если fallback включён: всё созданное эвристикой помечается needs_review,
 * чтобы грубое правило никогда не выглядело уверенным решением LLM.
 */
export class AutoProvider implements AIProvider {
  readonly name = 'auto';
  readonly model: string;
  readonly promptVersion: string;

  constructor(
    private readonly primary: AIProvider,
    private readonly fallback: AIProvider,
    private readonly allowFallback: boolean = false,
  ) {
    this.model = `${primary.model}+${fallback.model}`;
    this.promptVersion = primary.promptVersion;
  }

  async analyzeConversation(input: ConversationInput, opts?: { signal?: AbortSignal }): Promise<AnalyzeOutput> {
    try {
      return await this.primary.analyzeConversation(input, opts);
    } catch (err) {
      if (!this.allowFallback) throw err;
      opts?.signal?.throwIfAborted();
      logger.warn(
        { err: (err as Error).message },
        'primary AI provider failed, heuristic fallback (all created tasks marked needs_review)',
      );
      const out = await this.fallback.analyzeConversation(input, opts);
      return {
        tasks: out.tasks.map((t) =>
          t.action === 'create' ? { ...t, status: 'needs_review' as const } : t,
        ),
        dropped: out.dropped,
      };
    }
  }
}
