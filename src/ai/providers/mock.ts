import { PROMPT_VERSION } from '../prompts.js';
import type { AIProvider, AnalyzeOutput, ConversationInput } from '../types.js';

/**
 * Тестовый провайдер: возвращает заранее заданные ответы по chatJid.
 * Используется только в automated tests — бизнес-логика сервиса
 * проверяется без живой модели.
 */
export class MockProvider implements AIProvider {
  readonly name = 'mock';
  readonly model = 'mock-test-v1';
  readonly promptVersion = PROMPT_VERSION;
  readonly calls: ConversationInput[] = [];

  constructor(private readonly byChat: Record<string, AnalyzeOutput> = {}) {}

  async analyzeConversation(input: ConversationInput, opts?: { signal?: AbortSignal }): Promise<AnalyzeOutput> {
    this.calls.push(input);
    opts?.signal?.throwIfAborted();
    const out = this.byChat[input.chatJid] ?? { tasks: [] };
    // глубокая копия, чтобы сервис не мутировал фикстуры
    return JSON.parse(JSON.stringify(out)) as AnalyzeOutput;
  }
}
