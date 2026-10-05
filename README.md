# WhatsApp AI Secretary — Ingestion + AI-анализ (read-only к WhatsApp)

Локальное приложение: подключается к WhatsApp через QR, читает входящие
и исходящие сообщения, сохраняет их в локальный SQLite и извлекает
из переписок обязательства врача в таблицу `tasks`.
Ничего не отправляет в WhatsApp.

Стек: Node.js 20+, TypeScript (ESM), Baileys 7.x, Drizzle ORM + better-sqlite3, pino, dotenv.

## Архитектурные решения (прочти перед запуском)

1. **Drizzle ORM + better-sqlite3 (не Prisma).**
   Для маленького локального приложения Drizzle легче: нет отдельного
   query-engine / бинарника, синхронный драйвер, SQL рядом с кодом,
   `drizzle-kit` только для будущих версионированных миграций.
   Таблицы создаются идемпотентно при старте (`CREATE TABLE IF NOT EXISTS`),
   поэтому первый запуск работает без отдельных `migrate`-шагов.
2. **Baileys 7.x, ESM-only.** В проекте `"type": "module"`, импорты Baileys
   через `import`. `printQRInTerminal` удалён — QR рендерим сами через
   `qrcode-terminal` из события `connection.update`.
3. **Дедупликация в БД, а не в памяти.** Уникальный индекс
   `UNIQUE(whatsapp_message_id, chat_jid)` + `INSERT ... ON CONFLICT DO NOTHING`,
   поэтому повторная доставка `messages.upsert` и пересечение
   realtime/history никогда не создают дублей. Один и тот же
   `whatsapp_message_id` в разных чатах — разные строки (так и должно быть).
4. **LID/PN-двойственность (новое в Baileys 7.x).** WhatsApp идентифицирует
   пользователя двумя JID: `xxx@s.whatsapp.net` (телефон) и `xxx@lid`.
   В БД храним нормализованный JID (`jidNormalizedUser`, без `:device`-суффикса),
   телефон извлекаем только из `s.whatsapp.net`. Никогда не сравниваем JID
   через `===` / `split('@')` — только хелперами Baileys.
5. **`markOnlineOnConnect: false` по умолчанию.** Сессия не притворяется
   активным foreground-устройством, и телефон жены продолжает получать
   push-уведомления. Для врача это важно.
6. **История выключена по умолчанию (`SYNC_FULL_HISTORY=false`).**
   Храним только новые realtime-сообщения + бэкфилл. Полную историю можно
   включить через `.env`, но первый старт тогда будет тяжёлым.
7. **Статусы/рассылки/каналы игнорируются** (`shouldIgnoreJid`:
   broadcast, newsletter, status). Лички и группы — сохраняются.
8. **AI отделён от бизнес-логики интерфейсом `AIProvider`.**
   Сервис задач (`src/ai/taskService.ts`) зависит только от
   `analyzeConversation()`. Новый провайдер (OpenRouter/Gemini/Claude) —
   это новый класс + одна ветка в `src/ai/providerFactory.ts`, без правок
   сервиса и CLI. Промпты версионируются (`PROMPT_VERSION` в `src/ai/prompts.ts`),
   каждая задача хранит `model` + `prompt_version` + `confidence`.

## Требования

- Node.js >= 20 (проверено на 20.x; better-sqlite3 зафиксирован на v11 именно под Node 20)
- Телефон с WhatsApp рядом (для сканирования QR)

## Установка

```bash
cd whatsapp_ai
npm install
cp .env.example .env   # при желании поправь пути и уровни логов
```

## Запуск

```bash
npm run dev     # разработка (tsx watch)
# или
npm run build && npm start
```

Проверка типов:

```bash
npm run typecheck
```

## Где появляется QR и как подключить WhatsApp

1. Запусти `npm run dev`.
2. В терминале увидишь:
   `WARN: QR received — scan with WhatsApp: Settings > Linked devices > Link a device`
   и ASCII QR-код ниже.
3. На телефоне: **WhatsApp → Настройки → Связанные устройства → Привязать устройство**,
   наведи камеру на QR в терминале.
4. После сканирования сокет принудительно переподключится
   (`restartRequired`) — это нормально, клиент переподключается сам.
   Увидишь `whatsapp connected`.
5. При следующих запусках QR **не** показывается — сессия переиспользуется
   из `AUTH_DIR`. QR появится снова только если сессия отозвана (401)
   или папка auth удалена.

## Где что хранится

| Что | Путь по умолчанию (меняется в `.env`) |
|---|---|
| SQLite БД | `./data/whatsapp.db` (`SQLITE_PATH`), режим WAL |
| Auth-сессия (Signal-ключи, эквивалент SSH-приватника) | `./data/auth` (`AUTH_DIR`), права `700` |
| Логи | stdout через pino (`LOG_LEVEL`, `LOG_PRETTY`) |

Auth-папка и `*.db` уже внесены в `.gitignore`. Никогда не коммить их.

## Как проверить, что сообщения сохраняются

1. После подключения попроси кого-нибудь написать на WhatsApp жены
   (или напиши сама себе со второго номера), плюс отправь сообщение
   с телефона жены — оба направления сохраняются.
2. В отдельном терминале выполни:

```bash
npm run db:stats
```

Увидишь счётчики `contacts / messages total / incoming / outgoing`,
разбивку по `message_type` и последние 5 сообщений (только метаданные).

3. Вручную через sqlite:

```bash
sqlite3 data/whatsapp.db "SELECT chat_jid, direction, message_type, datetime(timestamp/1000,'unixepoch') FROM messages ORDER BY timestamp DESC LIMIT 10;"
```

4. Проверка дедупликации: перезапусти приложение — повторная доставка
   тех же событий не увеличивает счётчик (`isNew=false`, `ON CONFLICT DO NOTHING`).

Что сохраняется для нетиповых сообщений: изображения/голосовые/документы
хранятся как `message_type=image/audio/document/...` с подписью (caption),
если она есть, и `NULL`-текстом, если её нет. Медиафайлы не скачиваются.

## Безопасное отключение

- **Обычная остановка (сессия сохраняется):** `Ctrl+C`.
  Сокет закрывается, БД закрывается, при следующем старте QR не нужен.
- **Полный выход (отвязать устройство):**
  ```bash
  npm run session:logout
  ```
  Отзывает сессию на стороне WhatsApp (запись пропадёт из «Связанных устройств»
  на телефоне) и удаляет локальную папку auth. Следующий запуск покажет новый QR.
  Тот же эффект вручную: удалить устройство в WhatsApp на телефоне
  + `rm -rf ./data/auth`.
- **401 loggedOut в логах** означает, что сессию отозвали с телефона.
  Приложение специально НЕ переподключается в цикле — удали auth-папку
  и просканируй QR заново.

## Приватность логов

- Полный текст сообщений **никогда** не логируется на уровне `info`.
- Короткий превью-фрагмент (≤120 символов) возможен только на `debug`
  и только при `LOG_MESSAGE_CONTENT=true` в `.env`.
- В обычных логах только метаданные: чат, отправитель, направление, тип, длина.

## Структура проекта

```
src/
  index.ts                 # entrypoint ingestion, graceful shutdown (SIGINT/SIGTERM)
  config/
    env.ts                 # dotenv + типизированные настройки (incl. AI_*)
    logger.ts              # pino + logStoredMessage без утечек текста
  database/
    schema.ts              # drizzle-схема contacts/messages/tasks + индексы
    db.ts                  # better-sqlite3 (WAL) + идемпотентный bootstrap DDL
  whatsapp/                # ingestion MVP — НЕ МЕНЯТЬ без необходимости
    connection.ts          # Baileys 7.x: auth, QR, reconnect, logout, подписки
    messageParser.ts       # WAMessage -> плоская структура (текст/группы/медиа-капшены)
    store.ts               # upsert contacts + idempotent INSERT messages
  ai/                      # этап 2: извлечение обязательств врача
    types.ts               # AIProvider, ConversationInput/Output, ExtractedTask
    prompts.ts             # PROMPT_VERSION + сборка промпта (JSON-контракт)
    validate.ts            # строгая валидация ответа модели (AIValidationError)
    providerFactory.ts     # createProvider(): auto|openrouter|ollama|heuristic|mock
    providers/
      openrouter.ts          # облако (chat/completions, json_object, ключ из .env)
      ollama.ts            # локальный Ollama (/api/chat, format json, t=0)
      heuristic.ts         # rule-based RU-фолбэк (честно помечен, не LLM)
      mock.ts              # canned-ответы для тестов
    fixtures.ts            # 6 синтетических переписок без ПДн
    taskService.ts         # bundles по chat_jid -> AI -> reconcile (create/update, без дублей)
  digest/                  # этап 3: дневной отчёт (только чтение, без отправки)
    types.ts               # DailyDigest, DigestStats, интерфейс DigestRenderer
    date.ts                # parseDayArg, границы дня, русские подписи дат
    builder.ts             # buildDigest: секции attention/promised/completed + статистика
    renderer.ts            # PlainTextDigestRenderer (Telegram/WhatsApp-safe plain text)
  utils/
    jid.ts                 # normalizeJid / phoneFromJid / isGroupJid
  scripts/
    stats.ts               # npm run db:stats — проверка, что ingestion работает
    logout.ts              # npm run session:logout — полный выход + wipe auth
    analyze.ts             # npm run analyze — анализ дня -> tasks -> печать
    seedDemo.ts            # npm run seed:demo — синтетические переписки в БД
    digest.ts              # npm run digest — дневной отчёт (builder + renderer)
tests/
  validate.test.ts         # JSON-контракт: valid/пусто/ограждения/плохие status, confidence, deadline
  reconcile.test.ts        # сверка: create/provenance/антидубль/completion/uncertain
  heuristicFixtures.test.ts# поведение на фикстурах: обещания->задачи, спасибо/вопросы->0
  digest.test.ts           # секции/статистика/порядок/нумерация/отсутствие текста переписок
```

## AI-анализ: как это работает

1. `npm run seed:demo` — кладёт 6 синтетических переписок сегодняшним днём
   (идемпотентно; выполняется один раз, повтор безопасен).
2. `npm run analyze` — берёт сообщения за сегодня, группирует по `chat_jid`,
   каждый чат целиком отдаёт провайдеру как контекст и сверяет результат с `tasks`.
3. Провайдер (`AI_PROVIDER` в `.env`):
   - `auto` (по умолчанию) — OpenRouter, если задан `OPENROUTER_API_KEY`,
     иначе Ollama; при недоступности честно откатывается на эвристику
     с warning (задачи помечены своим `model`);
   - `openrouter` — только облако (ключ обязателен, см. ниже);
   - `ollama` — только локальная модель (`OLLAMA_URL`, `AI_MODEL`, нужен
     `ollama serve` + `ollama pull qwen2.5:7b`);
   - `heuristic` — только локальные правила (офлайн-демо);
   - `mock` — только для тестов.
   Опции CLI: `--provider=... --date=YYYY-MM-DD --chat=<подстрока-jid>`.
4. Правила извлечения (и в промпте `task-extract-v1`, и в эвристике):
   задача = подтверждённое обязательство ВРАЧА; «спасибо» и ответы на вопросы
   задачами НЕ считаются; отчёт врача о выполнении переводит задачу
   в `completed` (update по названию, а не новая строка).
5. Проверки: `npm test` (36 тестов), `npm run typecheck`, `npm run build`.

Таблица `tasks`: `chat_jid, contact_id, title, description, source_message_id,`
`deadline` (ms epoch или NULL), `deadline_text` (исходная фраза),
`status` (pending|completed|cancelled|uncertain), `confidence` (0..1),
`model`, `prompt_version`, `created_at`, `updated_at`, `completed_at`.

Ограничения эвристики: понимает только явные глаголы 1-го лица
(«посмотрю», «отправлю», «уточню»); инфинитивы («скинуть») игнорирует
намеренно, чтобы не плодить ложные задачи.

### OpenRouter (облако, без локальных ресурсов)

1. Зарегистрируйся на https://openrouter.ai, возьми ключ на
   https://openrouter.ai/keys и пополни баланс на пару долларов
   (анализ переписок — это центы в день на `gpt-4o-mini`).
2. В `.env` впиши:
   ```
   AI_PROVIDER=auto
   OPENROUTER_API_KEY=sk-or-v1-...
   OPENROUTER_MODEL=openai/gpt-4o-mini
   ```
   Дешёвые альтернативы с русским языком: `anthropic/claude-haiku-4.5`,
   `google/gemini-2.5-flash`. Ключ никуда кроме openrouter.ai не уходит
   и никогда не пишется в логи (проверено тестами).
3. Прогони: `npm run analyze -- --chat=patient-demo` и смотри столбец
   `model=openrouter:...` в выводе. В задачах также запишутся `model`
   и `prompt_version` — всегда видно, чем посчитано.

## Daily Digest

```bash
npm run digest                        # отчёт за сегодня
npm run digest -- --date=2026-10-05   # отчёт за конкретную дату
```

Слой `src/digest/` — чистые данные + формат, без отправки:
- `builder.ts` (`buildDigest`) — только чтение SQLite: задачи раскладываются
  в 🔴 Требует внимания (срок прошёл/истекает сегодня, включая старые
  просроченные; `uncertain` — всегда), 🟡 Обещано (остальные открытые),
  ✅ Выполнено (завершённые в день отчёта); считает входящие за день,
  активные/выполненные/без срока и разбивку уверенности
  (high ≥ 0.8, medium 0.5–0.8, low < 0.5). Текст переписок в дайджест не попадает.
- `types.ts` (`DigestRenderer`) + `renderer.ts` (`PlainTextDigestRenderer`) —
  plain text + эмодзи без markdown-разметки: одинаково уйдёт и в Telegram,
  и в WhatsApp. Новый канал доставки = новый класс рендера, builder и CLI не меняются.

## Что дальше (не в этом этапе)

Доставка дайджеста в Telegram, веб-интерфейс, Docker.
