import { env } from '../../config/env.js';
import { buildPrompt, PROMPT_VERSION } from '../prompts.js';
import type { AIProvider, AnalyzeOutput, ConversationInput } from '../types.js';
import { parseModelActions } from '../validate.js';

export type OpenRouterOptions = {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  timeoutMs?: number;
  temperature?: number;
  appTitle?: string;
  siteUrl?: string;
};

type OpenRouterChatResponse = {
  choices?: Array<{ message?: { content?: string | null } }>;
  error?: { message?: string; code?: number | string };
};

/**
 * Облачный провайдер через OpenRouter (OpenAI-совместимый API).
 * Для ноутбука без ресурсов под Ollama: вся тяжёлая работа на стороне API.
 * temperature=0 — детерминированная экстракция; response_format json_object —
 * модель обязана вернуть JSON (наш validate.ts всё равно проверяет строго).
 *
 * Ключ никогда не попадает в логи и тексты ошибок — только факт его отсутствия.
 */
export class OpenRouterProvider implements AIProvider {
  readonly name = 'openrouter';
  readonly model: string;
  readonly promptVersion = PROMPT_VERSION;

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly temperature: number;
  private readonly appTitle: string;
  private readonly siteUrl: string;

  constructor(opts: OpenRouterOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? env.openrouterUrl).replace(/\/$/, '');
    this.model = opts.model ?? env.openrouterModel;
    this.apiKey = opts.apiKey ?? env.openrouterApiKey;
    this.timeoutMs = opts.timeoutMs ?? env.aiTimeoutMs;
    this.temperature = opts.temperature ?? env.aiTemperature;
    this.appTitle = opts.appTitle ?? env.openrouterAppTitle;
    this.siteUrl = opts.siteUrl ?? env.openrouterSiteUrl;
  }

  async analyzeConversation(input: ConversationInput, opts?: { signal?: AbortSignal }): Promise<AnalyzeOutput> {
    if (!this.apiKey) {
      throw new Error(
        'OPENROUTER_API_KEY is not set. Get a key at https://openrouter.ai/keys and put it into .env',
      );
    }
    opts?.signal?.throwIfAborted();
    const { system, user } = buildPrompt(input, env.timezone);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
    if (this.appTitle) headers['X-Title'] = this.appTitle;
    if (this.siteUrl) headers['HTTP-Referer'] = this.siteUrl;

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        signal: opts?.signal
          ? AbortSignal.any([AbortSignal.timeout(this.timeoutMs), opts.signal])
          : AbortSignal.timeout(this.timeoutMs),
        body: JSON.stringify({
          model: this.model,
          temperature: this.temperature,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      });
    } catch (err) {
      throw new Error(`OpenRouter unreachable (${this.baseUrl}). Cause: ${(err as Error).message}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OpenRouter HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    const data = (await res.json()) as OpenRouterChatResponse;
    if (data.error) {
      throw new Error(`OpenRouter error: ${data.error.message ?? JSON.stringify(data.error).slice(0, 200)}`);
    }
    const content = data.choices?.[0]?.message?.content ?? '';
    if (!content) throw new Error('OpenRouter returned empty content');
    const { actions, dropped } = parseModelActions(content, input);
    return { tasks: actions, dropped };
  }
}
