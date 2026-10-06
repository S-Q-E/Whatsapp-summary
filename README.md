# WhatsApp AI Secretary — Ingestion + AI-анализ (read-only к WhatsApp)

Локальное приложение: подключается к WhatsApp через QR, читает входящие
и исходящие сообщения, сохраняет их в локальный SQLite и извлекает
из переписок обязательства врача в таблицу `tasks`.
Ничего не отправляет в WhatsApp.

Стек: Node.js 20+, TypeScript (ESM), Baileys 7.x, Drizzle ORM + better-sqlite3, pino, dotenv.

## Архитектурные решения (прочти перед запуском)

1. **Drizzle ORM + better-sqlite3 (не Prisma).**
   Для маленького локального приложения Drizzle легче: нет отдельного
   query-engine / бинарника, синхронный драйвер, SQL рядом с кодом.
   Схема версионируется: `drizzle-kit generate` → `drizzle/0000_*.sql`,
   при старте выполняется программный `migrate()`. Старые БД, созданные
   до миграций, подхватываются baseline-стратегией без потери данных
   (журнал помечается применённым, недостающие таблицы достраиваются).
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

Локально:

```bash
npm install
npm run dev     # всё одним процессом: БД + WhatsApp + анализ + API (tsx watch)
npm run dev:ingest  # только ingestion без HTTP, для отладки
npm run dev:web     # фронтенд отдельно (proxy /api → :3000)
# или
npm run build && npm run build:web && npm start
```

В Docker (рекомендуется для постоянной работы):

```bash
docker compose up -d --build
docker compose logs -f
```

Проверка типов и тестов:

```bash
npm run typecheck
npm test
```

## Где появляется QR и как подключить WhatsApp

1. Запусти приложение (`npm run dev` или Docker), открой веб-интерфейс
   (`http://127.0.0.1:3000` → раздел «WhatsApp») — там большой QR,
   который обновляется сам.
2. На телефоне: **WhatsApp → Настройки → Связанные устройства → Привязать устройство**,
   наведи камеру на QR.
3. После сканирования сокет принудительно переподключится
   (`restartRequired`) — это нормально, клиент переподключается сам.
4. При следующих запусках QR **не** показывается — сессия переиспользуется
   из `AUTH_DIR`. QR появится снова только если сессия отозвана (401)
   или вызван `POST /api/whatsapp/logout` с `{"confirm": true}`.
5. В терминал QR больше не печатается (только в WEB); для standalone-режима
   с QR в терминале: `QR_TERMINAL=true npm run dev:ingest`.

## Где что хранится

| Что | Путь по умолчанию (меняется в `.env`) |
|---|---|
| SQLite БД | `./data/whatsapp.db` (`SQLITE_PATH`), режим WAL |
| Auth-сессия (Signal-ключи, эквивалент SSH-приватника) | `./data/auth` (`AUTH_DIR`), права `700` |
| Бэкапы БД | `./data/backups` (`BACKUP_DIR`), ротация последних `BACKUP_KEEP_N` |
| Логи | stdout через pino (`LOG_LEVEL`, `LOG_PRETTY`) |

Auth-папка, `*.db` и `.env` уже внесены в `.gitignore`. Никогда не коммить их.

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

Что сохраняется для нетиповых сообщений (честно, без обещаний):
- исчезающие/одноразовые/`documentWithCaption` разворачиваются до внутреннего
  текста через `normalizeMessageContent` — иначе текст терялся бы;
- изображения/видео/документы — `message_type` + подпись (caption), если есть,
  иначе `NULL`; медиафайлы не скачиваются;
- голосовые (`ptt`) — отдельный тип `voice` + длительность `duration_sec`;
  обычное аудио — `audio`. Транскрибации НЕТ (отдельный шаг позже), в дайджесте
  только счётчик непрослушанных;
- правки (`messages.update` / protocol-edit) обновляют текст + `edited_at`
  и возвращают сообщение на переанализ; удаления ставят `deleted_at`
  (текст остаётся локально для аудита, в AI-контекст не попадает);
- реакции (`reaction`) и системные (`protocol`) хранятся, но в AI-контекст
  не попадают; удалённые сообщения — тоже;
- LID↔номер: таблица `jid_aliases`, чаты ведутся по каноническому JID
  (PN побеждает LID); поздний алиас сливает чаты в транзакции;
- группы: имя группы сохраняется в `chats.display_name`, автор каждой
  реплики подписан именем в AI-контексте.

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
  index.ts                 # только запускает app (шаг 5)
  app.ts                   # composition root: БД + WA + планировщик + Fastify
  config/
    env.ts                 # zod-конфиг (incl. AI_*, WEB_*, ANALYZE_*)
    logger.ts              # pino + logStoredMessage без утечек текста
  database/
    schema.ts              # drizzle-схема contacts/messages/tasks/settings + индексы
    db.ts                  # openDatabase: программный migrate() + baseline legacy-БД
    repositories/
      settings.ts          # key/value настройки (digest_time, owner_jid, ...)
  whatsapp/                # ingestion: парсинг, правки/удаления, алиасы, супервизор
    connection.ts          # Baileys 7.x: auth, QR, reconnect, logout, подписки (+ClientHooks, ReconnectSupervisor)
    manager.ts             # владелец соединения в серверном режиме, жизненный цикл
    qr-manager.ts          # последний QR для WEB (сырая строка, рендерит фронт)
    status-store.ts        # connecting|qr_pending|connected|disconnected|logged_out
    messageParser.ts       # normalizeMessageContent, voice/edit/revoke, durationSec
    store.ts               # upsert contacts/chats, INSERT messages, applyEdit/applyRevoke, jid_aliases, mergeChats
    voice.ts               # processVoiceMessage: скачивание → ASR → transcript → удаление файла
  server/                  # Fastify: auth, QR-PNG, routes (фронтенд — следующий шаг)
    auth.ts                # сессии в памяти, constant-time пароль, rate limit
    qr.ts                  # QR → PNG data URL с кэшем
    routes/
      whatsapp.ts          # status/qr/events(SSE)/disconnect/connect/logout, Zod-контракты
      tasks.ts             # dashboard/tasks CRUD/context через query builder
web/
  src/                     # React: api.ts, App (hash-роутер), pages (Login/WhatsApp/Dashboard/Tasks)
  ai/                      # этап 2: извлечение обязательств врача
    types.ts               # AIProvider, ConversationInput/Output, ExtractedTask
    prompts.ts             # PROMPT_VERSION + сборка промпта (JSON-контракт)
    validate.ts            # строгая валидация ответа модели (AIValidationError)
    providerFactory.ts     # createProvider(): auto|openrouter|ollama|heuristic|mock
    transcriber.ts         # Transcriber + OpenAI-совместимый ASR (шаг 10)
    providers/
      openrouter.ts          # облако (chat/completions, json_object, ключ из .env)
      ollama.ts            # локальный Ollama (/api/chat, format json, t=0)
      heuristic.ts         # rule-based RU-фолбэк (честно помечен, не LLM)
      mock.ts              # canned-ответы для тестов
    fixtures.ts            # 6 синтетических переписок без ПДн (seed:demo)
    evalFixtures.ts        # 27 eval-диалогов шага 8 (без ПДн)
    eval.ts                # caseInput, scoreCase/scoreAll, compareEvals
    taskService.ts         # bundles -> AI -> reconcile (id, антидубль по источнику)
    analyzeScheduler.ts    # планировщик: mutex, лимит чатов, таймауты, метрики
  digest/                  # этап 3: дневной отчёт (только чтение, без отправки)
    types.ts               # DailyDigest, DigestStats, интерфейс DigestRenderer
    date.ts                # parseDayArg, границы дня, русские подписи дат
    builder.ts             # buildDigest: секции attention/promised/completed + статистика
    renderer.ts            # PlainTextDigestRenderer (Telegram/WhatsApp-safe plain text)
  utils/
    jid.ts                 # normalizeJid / phoneFromJid / isGroupJid
    time.ts                # startOfDay/endOfDay/formatLocal/toLocalDateString (Intl, зона из TIMEZONE)
  scripts/
    stats.ts               # npm run db:stats — проверка, что ingestion работает
    logout.ts              # npm run session:logout — полный выход + wipe auth
    ingest.ts              # npm run dev:ingest — standalone ingestion без HTTP
    analyze.ts             # npm run analyze — ручной разбор (планировщик делает то же по cron)
    seedDemo.ts            # npm run seed:demo — синтетические переписки в БД
    digest.ts              # npm run digest — дневной отчёт (builder + renderer)
    eval.ts                # npm run eval — прогон фикстур через модель + метрики
    evalCompare.ts         # npm run eval:compare — дельты двух прогонов
tests/
  app.test.ts              # API через inject (auth/rate-limit/logout/QR/system), mutex планировщика
  dashboard.test.ts        # dashboard/tasks/context endpoints, manual-флаг против AI
  validate.test.ts         # wire-контракт v3: ссылки t/m, дропы, структурные ошибки
  reconcile.test.ts        # сверка по id: create/complete/cancel/антидубль/scope чата
  reconcile-bugs.test.ts   # регрессия багов шага 2: повтор через неделю, похожие названия
  heuristicFixtures.test.ts# поведение на фикстурах: обещания->задачи, спасибо/вопросы->0
  digest.test.ts           # секции/статистика/порядок/нумерация/отсутствие текста переписок
  digest-send.test.ts      # sendGuard/grep-отправок, WA-формат, идемпотентность/рестарт/офлайн
  eval.test.ts             # eval-input, скоринг кейсов, агрегаты, сравнение
  ops.test.ts              # ретеншн/бэкапы/игнор-чаты/отсутствие текстов в логах
  voice.test.ts            # транскрибация на фейковом ASR, удаление файла, [голосовое] в контексте
  whatsapp-ingest.test.ts  # обёртки/viewOnce/voice/edit/revoke/алиасы/слияние/супервизор
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
4. Правила извлечения (промпт `task-extract-v3`, история версий в `prompts.ts`):
   задача = обязательство ВРАЧА или принятая им просьба; «спасибо», вопросы
   и ответы-факты — не задачи. Контекст: последние N сообщений чата
   (`AI_CONTEXT_LIMIT`, default 40, за `AI_CONTEXT_DAYS`, default 14) +
   все открытые задачи. Сообщения keyed `m<messages.id>`, задачи `t<id>`,
   время в TIMEZONE со смещением. Ответ модели: `{"actions": [...]}` со
   ссылками вида `taskId: "t12"`, `evidenceMessageId: "m34"`; битые ссылки
   отбрасываются (в лог — только id, без текста), структурная ошибка —
   один retry. Инкрементальность: разбираются только чаты с
   `processed_at IS NULL`; после успеха сообщения помечаются, при ошибке —
   остаются на следующий прогон. Идентификация строго по id; антидубль —
   UNIQUE по источнику. `auto`-провайдер не залипает (primary пробуется
   каждый раз); fallback на эвристику выключен по умолчанию
   (`ALLOW_HEURISTIC_FALLBACK=false`), при включении её create → needs_review.
5. Проверки: `npm test` (132 теста), `npm run typecheck`, `npm run build`.

Таблица `tasks`: `chat_id` (FK → chats), `title`, `description`,
`source_message_id` (FK → messages.id, wamid резолвится при сверке),
`closed_by_message_id`, `status` (open|done|cancelled|needs_review),
`due_at` (ms epoch или NULL), `due_text` (исходная фраза),
`confidence`, `model`, `prompt_version`, `created_at`, `updated_at`, `closed_at`.
Миграции: `drizzle/` (`0000` — baseline схемы, `0001` — chats/id с переносом
данных и маппингом статусов pending→open, completed→done, uncertain→needs_review).
Таблица `chats`: диалоги (лички и группы), задачи и сообщения ссылаются на `chat_id`.

Ограничения эвристики: понимает только явные глаголы 1-го лица
(«посмотрю», «отправлю», «уточню»); инфинитивы («скинуть») игнорирует
намеренно, чтобы не плодить ложные задачи.

### Eval: измерение качества извлечения (шаг 8)

`src/ai/evalFixtures.ts` — 27 синтетических диалогов (разговорный русский,
опечатки, ПДн нет): обещания, выполнения, повтор через неделю, два обещания
в одном сообщении, отмена, шум, группы, неоднозначности. Каждый кейс описывает
ожидаемые actions (тип + привязка к сообщению/задаче, без матчинга по названиям).

```bash
npm run eval -- --provider=openrouter --model=google/gemini-2.5-flash
npm run eval -- --provider=heuristic            # офлайн, без ключа
npm run eval -- --provider=openrouter --model=X --cases=promise-basic,cancel
npm run eval:compare -- --base=eval/results/A.json --other=eval/results/B.json
```

Метрики: precision/recall создания, точность закрытия/отмены, доля ложных
задач, доля needs_review. Результат — `eval/results/<дата>-<промпт>-<модель>.json`
(только синтетика — коммитить можно). Кейс `reschedule` помечен как известный
гэп контракта (перенос срока выразить нечем) — вне метрик, виден отдельно.

### Как добавить свой диалог (обезличивание)

Реальные переписки в репозиторий НЕЛЬЗЯ — ни тексты, ни JID, ни результаты
прогонов по ним. Чтобы превратить реальный случай в фикстуру:

1. Выпиши структуру: кто говорит (пациент/врач), было ли обещание,
   было ли выполнение/отмена, был ли срок — без имён, дат и деталей болезни.
2. Перескажи своими словами с вымышленными именами («Пациент»),
   сохранив: глагол обещания, наличие срока, тон (уверенно/сомнительно).
3. Убери: имена, телефоны, названия препаратов/диагнозов/клиник,
   конкретные даты (замени на «завтра»/«в пятницу»).
4. Добавь кейс в `EVAL_CASES` с `expect` (creates/completes/cancels +
   needsReview/dueDated при необходимости) и прогони `npm run eval`.

Шаблон:
```ts
{
  id: 'мой-кейс',
  kind: 'direct', // или 'group'
  description: 'что проверяем',
  openTask: { title: '...' }, // если нужен контекст известной задачи
  messages: [
    { from: 'patient', name: 'Пациент', text: '...', hour: 9, minute: 0 },
    { from: 'doctor', text: '...', hour: 9, minute: 10 },
  ],
  expect: { creates: [1], completes: [], cancels: [] },
},
```

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
  просроченные; `needs_review` — всегда), 🟡 Обещано (остальные открытые),
  ✅ Выполнено (завершённые в день отчёта); считает входящие за день,
  активные/выполненные/без срока и разбивку уверенности
  (high ≥ 0.8, medium 0.5–0.8, low < 0.5). Текст переписок в дайджест не попадает.
- `types.ts` (`DigestRenderer`) + `renderer.ts` (`PlainTextDigestRenderer`) —
  plain text + эмодзи без markdown-разметки: одинаково уйдёт и в Telegram,
  и в WhatsApp. Новый канал доставки = новый класс рендера, builder и CLI не меняются.

## Шаг 5: один процесс (app + планировщик + API)

```bash
npm run dev        # всё одним процессом: БД + WhatsApp + анализ по расписанию + API
```

`src/index.ts` только запускает `src/app.ts` (composition root).
`src/scripts/ingest.ts` (`npm run dev:ingest`) — standalone ingestion
без HTTP для отладки. `src/server/index.ts` удалён (влит в `app.ts`).

Планировщик (`src/ai/analyzeScheduler.ts`): каждые `ANALYZE_INTERVAL_MIN`
(default 2) разбирает чаты с необработанными сообщениями, максимум
`ANALYZE_MAX_CHATS` (default 10) за проход, один проход за раз (mutex),
таймаут на чат, ошибки провайдера считаются и не трогают сообщения.
Метрики + число необработанных — в `GET /api/system/status`.

API (`/api`, ответы валидируются Zod):

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/health`, `/api/health` | живость (без авторизации) |
| POST | `/api/auth/login` | вход по `WEB_PASSWORD`, httpOnly-сессия, rate limit |
| GET | `/api/whatsapp/status` | `{state: connecting\|qr\|open\|closed\|logged_out, ...}` |
| GET | `/api/whatsapp/qr` | `{dataUrl: PNG data URL \| null}` — в браузере виден QR |
| GET | `/api/whatsapp/events` | SSE: `snapshot` → `qr`/`status` |
| POST | `/api/whatsapp/disconnect` | закрыть соединение, сессию сохранить |
| POST | `/api/whatsapp/connect` | переподключить |
| POST | `/api/whatsapp/logout` | тело `{"confirm": true}` — закрыть + стереть сессию |
| GET | `/api/system/status` | метрики анализа, необработанные, ошибки провайдера |
| GET | `/api/dashboard` | счётчики за день: сообщений, открытых, просроченных, выполненных, needs_review |
| GET | `/api/tasks?status=&chatId=` | список задач (без текстов переписок) |
| POST | `/api/tasks` | ручное создание `{chatId\|chatJid, title}` → `manual=1` |
| PATCH | `/api/tasks/:id` | `{status, title, description, dueAt}` → `manual=1` |
| GET | `/api/tasks/:id/context` | ±5 сообщений вокруг источника с флагами `isSource`/`isClosing` |
| POST | `/api/digest/preview` | текст дайджеста без отправки и без записи |
| POST | `/api/digest/send-now` | тело `{"confirm": true}` — отправить сейчас (обходит проверку времени, повтор за день не шлёт) |

Авторизация (default-deny): закрыто всё, кроме `/health`, `/api/health`,
`POST /api/auth/login` и статики фронта. Решение — по сматченному маршруту
(`routeOptions`), а не по строке URL: кодированные обходы (`/%61pi/...`)
дают 401/404, никогда не 200. Сессии в памяти с TTL 7 дней
(`Max-Age`, чистка просроченных), cookie `wasec` (httpOnly, SameSite=Lax,
`Secure` под https), пароль сверяется в constant-time, rate limit на логин.
`WEB_PASSWORD` обязателен всегда; исключение — явный `ALLOW_NO_AUTH=true`
(только тесты/локалка, сервер громко предупреждает в логе).
Защита от DNS rebinding: только `127.0.0.1`/`localhost`/`::1` и `ALLOWED_HOSTS`.
POST/PATCH/DELETE требуют JSON Content-Type или `X-Requested-With`.
За reverse proxy — `TRUST_PROXY=true` (иначе `X-Forwarded-*` игнорируются).
QR в терминал выключен по умолчанию (`QR_TERMINAL=false`); в WEB — через `/api/whatsapp/qr`.

## Шаг 6: дашборд и задачи (API + web/)

`web/` — Vite + React + Tailwind, mobile-first, русский язык:
вход по паролю, экран «Подключить WhatsApp» (QR-картинка, опрос статуса
каждые 3 сек), дашборд (статус, счётчики, блок внимания), задачи
(фильтры, карточки: пациент, формулировка, срок, кнопки «Готово» /
«Не нужно» / «Перенести», раскрывающийся контекст переписки, ручное
создание). Тексты сообщений — только в раскрытом контексте, в списках
их нет. Сборка (`npm run build:web` → `web/dist`) раздаётся Fastify
как статика со SPA-fallback; без сборки API работает как раньше.
`npm run dev:web` — разработка фронта (proxy `/api` → :3000).
Ручные правки ставят `manual=1`; AI такие задачи не перезаписывает
(переходы complete/cancel по taskId работают, поля — нет).

## Шаг 7: вечерний дайджест в WhatsApp (только владельцу)

- `src/whatsapp/sendGuard.ts` — единственная точка исходящих: разрешён
  только `OWNER_JID`, всё остальное бросает `NotOwnerError`. Тест grep'ает
  `src/whatsapp`: `.sendMessage(` встречается только там.
- Планировщик (`DigestScheduler`, тик каждую минуту + сразу при старте):
  в `DIGEST_TIME` (default `18:00`) по `TIMEZONE` строит дайджест и шлёт
  через sendGuard. Таблица `digests` (одна строка на дату): `sent=1`
  только после успешной отправки — повтор, рестарт и офлайн не дублируют,
  при недоступном WhatsApp тик повторяет позже.
- Формат WA-дайджеста (`renderWhatsAppDigest`): «📋 Итоги дня»,
  🔴 Нужно сделать / 🟡 Обещано / ✅ Выполнено сегодня,
  `❓ Проверьте: ...` одной строкой, «Всего/Выполнено/Осталось».
  Сроки относительные (сегодня/завтра/пн, 12 октября), без блока
  уверенности; JID без имени → «Неизвестный контакт».
- UI: блок дайджеста на дашборде — «Показать текст» (preview) и
  «Отправить сейчас» (с `window.confirm`).
- Для отправки нужен `OWNER_JID` в `.env` (телефон или JID); без него —
  пропуск с варном, без падения.

## Куда уходят данные (шаг 9, приватность)

Архитектура local-first, но знай точно:

| Данные | Куда уходят |
|---|---|
| Тексты сообщений → LLM | Только выбранному `AI_PROVIDER`: `heuristic` — никуда (локальные правила); `ollama` — на твой `OLLAMA_URL`; `openrouter` — в OpenRouter API (а с ним — выбранной модели). Больше ничего никуда не отправляется |
| Дайджест | Одним сообщением в WhatsApp только на `OWNER_JID` (проверяется `sendGuard`, есть тест). Пациентам приложение не пишет никогда |
| Логи | Только метаданные (чат, тип, длина). Полный текст — лишь на `debug` при `LOG_MESSAGE_CONTENT=true` (тест `tests/ops.test.ts` это проверяет) |
| Медиафайлы | Не скачиваются и не хранятся вообще — кроме голосовых при включённой транскрибации (ниже) |
| Аудио голосовых → ASR | **Только при `TRANSCRIBE_VOICE=true` (по умолчанию ВЫКЛЮЧЕНО).** Аудио голосового сообщения скачивается из WhatsApp **в память** (на диск не пишется вообще) и отправляется стороннему сервису транскрибации (`TRANSCRIBE_URL`, default OpenAI `/audio/transcriptions`, модель `TRANSCRIBE_MODEL`, ключ `TRANSCRIBE_API_KEY`, язык `TRANSCRIBE_LANGUAGE`, default `auto` = не передаётся). Текст ответа хранится в `messages.transcript` и попадает в AI-контекст с пометкой `[голосовое]`. Скачиваются realtime-сообщения типов `voice`/`audio` из разрешённых чатов плюс свежие (до 24 ч) из backfill. Молодые голосовые без транскрипта не спешат в анализ: ждут `VOICE_GRACE_MIN` (default 5) минут |

Исключение чата из анализа: раздел «Чаты» в UI (переключатель) или
`chat_settings` в БД — сообщения продолжают сохраняться, но в AI-контекст
чат не попадает. Ретеншн (`RETENTION_DAYS`, default 0 = выкл): у сообщений
старше срока зануляются `text`, `transcript` и `sender_name`; удалённые
чистятся сразу; старые `digests.content` — тоже; закрытые задачи старше
`RETENTION_TASKS_DAYS` (default 0 = выкл) обезличиваются. Задачи, ссылки
и метаданные остаются. После прогона — `wal_checkpoint(TRUNCATE)`.

## Голосовые сообщения (шаг 10)

По умолчанию голосовые НЕ распознаются: в AI-контекст попадает только
плейсхолдер `[голосовое сообщение, N сек]`, в дайджесте — счётчик
непрослушанных. Для включения задай в `.env`:

```
TRANSCRIBE_VOICE=true
TRANSCRIBE_URL=https://api.openai.com/v1   # или Groq: https://api.groq.com/openai/v1
TRANSCRIBE_MODEL=whisper-1
TRANSCRIBE_API_KEY=sk-...
TRANSCRIBE_LANGUAGE=auto   # ru/en/... или auto (не передавать)
```

Как это работает: новое голосовое из разрешённого чата скачивается
в память (на диск не пишется — проверено тестом: несуществующая папка
так и не создаётся), отправляется в ASR, текст пишется в
`messages.transcript`, а `processed_at` сбрасывается — сообщение с новым
транскриптом попадёт в следующий проход анализа. Ошибки ASR не роняют
ingestion, транскрипт остаётся NULL. В AI-контекст транскрипт попадает
как `[голосовое: <текст>]`.

## Docker, бэкапы, обновление

- `docker compose up -d --build` — multi-stage образ (фронт + бэкенд),
  том `./data` (БД, auth, бэкапы), healthcheck по `/api/health`,
  `TZ` берётся из `TIMEZONE`. Порт наружу не торчит дальше `127.0.0.1`.
- Бэкапы: не чаще раза в календарные сутки SQLite `.backup()` в `data/backups`
  (проверяется дата последнего файла), ротация последних `BACKUP_KEEP_N`
  (default 7). Auth-папка не копируется —
  при потере `./data/auth` просто перепривяжи устройство (ниже).
- Обновление кода: `git pull`, пересобери (`docker compose up -d --build`
  или `npm run build`), миграции применятся сами при старте.
  Откат БД: останови приложение и подсунь файл из `data/backups`
  как `data/whatsapp.db`.
- Восстановление сессии WhatsApp: если вышел из «Связанных устройств»
  или `logged_out` — открой раздел «WhatsApp» и просканируй новый QR.
  Старая auth-сессия при logout стирается автоматически.
- Обновление фронтенда: `npm run build:web` (или пересборка образа).

## Известные ограничения

- Транскрибации голосовых нет — в дайджесте только счётчик непрослушанных.
- Правка сообщения не пересоздаёт задачи, созданные из старого текста.
- Эвристика (`heuristic`) — грубые правила, не LLM; production-качество
  даёт `openrouter`/`ollama` (см. `npm run eval`).
- Перенос срока существующей задачи моделью не поддерживается
  (известный гэп eval-кейса `reschedule`).
- Сессии WEB-авторизации живут в памяти — рестарт разлогинивает.
- Резервные копии не шифруются — том `data/` защищай на уровне хоста.

## Что дальше (не в этом этапе)

Доставка дайджеста в Telegram.
