import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { HeuristicProvider } from './providers/heuristic.js';
import { MockProvider } from './providers/mock.js';
import { OllamaProvider } from './providers/ollama.js';
import { OpenRouterProvider } from './providers/openrouter.js';
import type { AIProvider } from './types.js';

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
    return new AutoProvider(primary, new HeuristicProvider());
  }
  throw new Error(`Unknown AI provider "${k}" (expected auto|openrouter|ollama|heuristic|mock)`);
}

/**
 * auto: пробует облако/локальную модель; при недоступности — честный fallback
 * на эвристику с warning в лог. Задачи всё равно помечены своим model,
 * подмены LLM незаметно не происходит.
 */
class AutoProvider implements AIProvider {
  readonly name = 'auto';
  readonly model: string;
  readonly promptVersion: string;
  private used: AIProvider | null = null;

  constructor(
    private readonly primary: AIProvider,
    private readonly fallback: AIProvider,
  ) {
    this.model = `${primary.model}+${fallback.model}`;
    this.promptVersion = primary.promptVersion;
  }

  async analyzeConversation(input: Parameters<AIProvider['analyzeConversation']>[0]) {
    if (this.used) return this.used.analyzeConversation(input);
    try {
      const out = await this.primary.analyzeConversation(input);
      this.used = this.primary;
      return out;
    } catch (err) {
      logger.warn(
        { err: (err as Error).message },
        'primary AI provider failed, falling back to local heuristic (results will be marked as heuristic)',
      );
      this.used = this.fallback;
      return this.fallback.analyzeConversation(input);
    }
  }
}
