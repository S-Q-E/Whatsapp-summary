import { env } from '../../config/env.js';
import { buildPrompt, PROMPT_VERSION } from '../prompts.js';
import type { AIProvider, AnalyzeOutput, ConversationInput } from '../types.js';
import { parseModelOutput } from '../validate.js';

type OllamaChatResponse = {
  message?: { content?: string };
  error?: string;
};

/**
 * Первый реальный провайдер для локального теста: Ollama на localhost.
 * Требует запущенного `ollama serve` и скачанной модели (см. AI_MODEL).
 * temperature=0 — нам нужна детерминированная экстракция, а не креатив.
 */
export class OllamaProvider implements AIProvider {
  readonly name = 'ollama';
  readonly model: string;
  readonly promptVersion = PROMPT_VERSION;

  constructor(
    private readonly baseUrl: string = env.ollamaUrl,
    model: string = env.aiModel,
    private readonly timeoutMs: number = env.aiTimeoutMs,
  ) {
    this.model = model;
  }

  async analyzeConversation(input: ConversationInput): Promise<AnalyzeOutput> {
    const { system, user } = buildPrompt(input);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
        body: JSON.stringify({
          model: this.model,
          stream: false,
          format: 'json',
          options: { temperature: env.aiTemperature },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      });
    } catch (err) {
      throw new Error(
        `Ollama unreachable at ${this.baseUrl} (is 'ollama serve' running? model '${this.model}' pulled?). Cause: ${(err as Error).message}`,
      );
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Ollama HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    const data = (await res.json()) as OllamaChatResponse;
    if (data.error) throw new Error(`Ollama error: ${data.error}`);
    const content = data.message?.content ?? '';
    if (!content) throw new Error('Ollama returned empty content');
    return parseModelOutput(content);
  }
}
