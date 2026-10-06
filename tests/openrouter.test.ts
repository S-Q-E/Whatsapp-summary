import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OpenRouterProvider } from '../src/ai/providers/openrouter.js';
import type { ConversationInput } from '../src/ai/types.js';

const INPUT: ConversationInput = {
  chatJid: 'demo@s.whatsapp.net',
  contactName: 'Пациент',
  messages: [
    {
      id: 11,
      direction: 'incoming',
      senderName: 'Пациент',
      text: 'Посмотрите мои анализы?',
      messageType: 'text',
      durationSec: null,
      timestamp: 1_700_000_000_000,
      whatsappMessageId: 'm1',
    },
    {
      id: 12,
      direction: 'outgoing',
      senderName: null,
      text: 'Посмотрю вечером и напишу.',
      messageType: 'text',
      durationSec: null,
      timestamp: 1_700_000_100_000,
      whatsappMessageId: 'm2',
    },
  ],
  existingTasks: [],
  analyzedAt: 1_700_000_200_000,
};

const tasksJson = (actions: unknown): string => JSON.stringify({ actions });

type TestContext = { after: (fn: () => void) => void };

function stubFetch(
  t: TestContext,
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): { calls: Array<{ url: string; init: RequestInit }> } {
  const orig = globalThis.fetch;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return handler(String(url), init ?? {});
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = orig;
  });
  return { calls };
}

const jsonResponse = (obj: unknown, status = 200): Response =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

describe('OpenRouterProvider', () => {
  it('строит корректный запрос: URL, auth, заголовки, json-режим', async (t) => {
    const { calls } = stubFetch(t, () =>
      jsonResponse({ choices: [{ message: { content: '{"actions": []}' } }] }),
    );
    const p = new OpenRouterProvider({
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'openai/gpt-4o-mini',
      apiKey: 'sk-test-key',
      appTitle: 'Test App',
      siteUrl: 'https://example.com',
    });
    const out = await p.analyzeConversation(INPUT);
    assert.deepEqual(out, { tasks: [], dropped: [] });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, 'https://openrouter.ai/api/v1/chat/completions');
    const headers = calls[0]!.init.headers as Record<string, string>;
    assert.equal(headers['Authorization'], 'Bearer sk-test-key');
    assert.equal(headers['X-Title'], 'Test App');
    assert.equal(headers['HTTP-Referer'], 'https://example.com');
    const body = JSON.parse(calls[0]!.init.body as string) as Record<string, unknown>;
    assert.equal(body['model'], 'openai/gpt-4o-mini');
    assert.equal(body['temperature'], 0);
    assert.deepEqual(body['response_format'], { type: 'json_object' });
    const msgs = body['messages'] as Array<{ role: string; content: string }>;
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0]!.role, 'system');
    assert.equal(msgs[1]!.role, 'user');
    assert.match(msgs[1]!.content, /Посмотрю вечером/); // контекст переписки уехал в API
  });

  it('не шлёт опциональные заголовки, если они пустые', async (t) => {
    stubFetch(t, () => jsonResponse({ choices: [{ message: { content: '{"actions": []}' } }] }));
    const p = new OpenRouterProvider({ apiKey: 'sk-test-key', appTitle: '', siteUrl: '' });
    await p.analyzeConversation(INPUT);
  });

  it('парсит задачи из ответа', async (t) => {
    stubFetch(t, () =>
      jsonResponse({
        choices: [
          {
            message: {
              content: tasksJson([
                {
                  type: 'create',
                  taskId: null,
                  title: 'Посмотреть анализы',
                  status: 'open',
                  confidence: 0.9,
                  dueText: 'сегодня вечером',
                  evidenceMessageId: 'm12',
                },
              ]),
            },
          },
        ],
      }),
    );
    const p = new OpenRouterProvider({ apiKey: 'sk-test-key' });
    const out = await p.analyzeConversation(INPUT);
    assert.equal(out.tasks.length, 1);
    assert.equal(out.tasks[0]!.title, 'Посмотреть анализы');
    assert.equal(out.tasks[0]!.dueText, 'сегодня вечером');
    assert.equal(out.tasks[0]!.messageId, 12);
    assert.equal(p.name, 'openrouter');
    assert.equal(p.model, 'openai/gpt-4o-mini');
  });

  it('требует ключ и не светит его в ошибке', async (t) => {
    stubFetch(t, () => jsonResponse({}));
    const p = new OpenRouterProvider({ apiKey: '' });
    await assert.rejects(() => p.analyzeConversation(INPUT), /OPENROUTER_API_KEY is not set/);
  });

  it('HTTP-ошибка: статус в тексте, ключа в тексте нет', async (t) => {
    stubFetch(t, () => new Response('insufficient credits', { status: 402 }));
    const p = new OpenRouterProvider({ apiKey: 'sk-secret-key' });
    let caught: unknown;
    try {
      await p.analyzeConversation(INPUT);
    } catch (e) {
      caught = e;
    }
    assert.match((caught as Error).message, /OpenRouter HTTP 402/);
    assert.ok(!(caught as Error).message.includes('sk-secret-key'));
  });

  it('API-ошибка в теле ответа', async (t) => {
    stubFetch(t, () => jsonResponse({ error: { message: 'model not found', code: 404 } }));
    const p = new OpenRouterProvider({ apiKey: 'sk-test-key' });
    await assert.rejects(() => p.analyzeConversation(INPUT), /model not found/);
  });

  it('пустой content — понятная ошибка без ключа', async (t) => {
    stubFetch(t, () => jsonResponse({ choices: [{ message: { content: '' } }] }));
    const p = new OpenRouterProvider({ apiKey: 'sk-secret-key' });
    let caught: unknown;
    try {
      await p.analyzeConversation(INPUT);
    } catch (e) {
      caught = e;
    }
    assert.match((caught as Error).message, /empty content/);
    assert.ok(!(caught as Error).message.includes('sk-secret-key'));
  });

  it('недоступность сети — причина без ключа', async (t) => {
    const orig = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new Error('fetch failed'))) as typeof fetch;
    t.after(() => {
      globalThis.fetch = orig;
    });
    const p = new OpenRouterProvider({ apiKey: 'sk-secret-key' });
    let caught: unknown;
    try {
      await p.analyzeConversation(INPUT);
    } catch (e) {
      caught = e;
    }
    assert.match((caught as Error).message, /OpenRouter unreachable/);
    assert.ok(!(caught as Error).message.includes('sk-secret-key'));
  });
});
