import { useEffect, useState } from 'react';
import { UnauthorizedError, api, formatDue, loadServerInfo, type Task } from '../api';

const STATUS_LABEL: Record<string, string> = {
  open: 'открыта',
  done: 'выполнена',
  cancelled: 'отменена',
  needs_review: 'проверить',
};

function TaskCard({ task, onChanged }: { task: Task; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [context, setContext] = useState<{ messages: { id: number; direction: string; senderName: string | null; text: string | null; timestamp: number; isSource: boolean; isClosing: boolean }[] } | null>(null);
  const [loadingCtx, setLoadingCtx] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      if (!(e instanceof UnauthorizedError)) setError(e instanceof Error ? e.message : 'ошибка');
    } finally {
      setBusy(false);
    }
  };

  const toggleContext = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (context) return;
    setLoadingCtx(true);
    try {
      const c = await api.taskContext(task.id);
      setContext(c);
    } catch (e) {
      if (!(e instanceof UnauthorizedError)) setError(e instanceof Error ? e.message : 'ошибка');
      setOpen(false);
    } finally {
      setLoadingCtx(false);
    }
  };

  const postpone = () => {
    const v = window.prompt('Новый срок (ГГГГ-ММ-ДД, пусто — без срока):', '');
    if (v === null) return;
    const trimmed = v.trim();
    if (trimmed === '') {
      void act(() => api.patchTask(task.id, { dueAt: null }));
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      setError('плохая дата: нужен формат ГГГГ-ММ-ДД, например 2026-10-20');
      return;
    }
    const ms = Date.parse(`${trimmed}T12:00:00`);
    if (Number.isNaN(ms)) {
      setError('плохая дата: такого дня нет в календаре');
      return;
    }
    void act(() => api.patchTask(task.id, { dueAt: new Date(ms).toISOString() }));
  };

  return (
    <div className="rounded-xl bg-white p-4 shadow-sm">
      <div className="text-sm font-medium text-slate-800">{task.contactName}</div>
      <div className="mt-1 text-slate-900">{task.title}</div>
      <div className="mt-2 flex flex-wrap gap-2 text-xs text-slate-500">
        <span>Срок: {formatDue(task)}</span>
        <span>Статус: {STATUS_LABEL[task.status] ?? task.status}</span>
        {task.confidence !== null && <span>Уверенность: {Math.round(task.confidence * 100)}%</span>}
        {task.manual === 1 && <span title="отредактирована вручную">✏️</span>}
      </div>
      {error && <div className="mt-2 text-sm text-red-600">{error}</div>}
      <div className="mt-3 flex flex-wrap gap-2">
        {task.status !== 'done' && (
          <button disabled={busy} onClick={() => void act(() => api.patchTask(task.id, { status: 'done' }))} className="rounded-lg bg-green-600 px-3 py-1.5 text-sm text-white disabled:opacity-50">
            Готово
          </button>
        )}
        {task.status !== 'cancelled' && task.status !== 'done' && (
          <button disabled={busy} onClick={() => void act(() => api.patchTask(task.id, { status: 'cancelled' }))} className="rounded-lg bg-slate-200 px-3 py-1.5 text-sm text-slate-700 disabled:opacity-50">
            Не нужно
          </button>
        )}
        {(task.status === 'open' || task.status === 'needs_review') && (
          <button disabled={busy} onClick={postpone} className="rounded-lg bg-amber-100 px-3 py-1.5 text-sm text-amber-900 disabled:opacity-50">
            Перенести
          </button>
        )}
        <button onClick={() => void toggleContext()} className="rounded-lg bg-slate-100 px-3 py-1.5 text-sm text-slate-700">
          {open ? 'Скрыть переписку' : 'Открыть диалог'}
        </button>
      </div>
      {open && (
        <div className="mt-3 border-t border-slate-100 pt-2">
          {loadingCtx && <div className="text-sm text-slate-500">Загрузка переписки…</div>}
          {context && context.messages.length === 0 && <div className="text-sm text-slate-500">Сообщений нет.</div>}
          {context?.messages.map((m) => (
            <div key={m.id} className={`mb-2 rounded-lg p-2 text-sm ${m.direction === 'outgoing' ? 'bg-green-50' : 'bg-slate-50'}`}>
              <div className="text-xs text-slate-500">
                {m.direction === 'outgoing' ? 'Врач' : m.senderName ?? 'Собеседник'}
                {' · '}
                {new Date(m.timestamp).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}
                {m.isSource && <span className="ml-1 rounded bg-blue-100 px-1 text-blue-800">источник</span>}
                {m.isClosing && <span className="ml-1 rounded bg-green-100 px-1 text-green-800">закрытие</span>}
              </div>
              <div className="mt-0.5">{m.text ?? `[${m.messageType}, без текста]`}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Tasks() {
  const [filter, setFilter] = useState<string>('');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [newChatId, setNewChatId] = useState('');
  const [chats, setChats] = useState<{ id: number; jid: string; displayName: string | null; isGroup: number }[]>([]);

  const load = async (appendCursor?: string | null) => {
    try {
      const page = await api.tasks(filter || undefined, 50, appendCursor ?? undefined);
      setTasks((prev) => (appendCursor ? [...prev, ...page.items] : page.items));
      setCursor(page.nextCursor);
      setHasMore(page.nextCursor !== null);
      setLoaded(true);
    } catch (e) {
      if (!(e instanceof UnauthorizedError)) setError(e instanceof Error ? e.message : 'ошибка');
    }
  };

  const reload = () => {
    setCursor(null);
    setHasMore(false);
    setLoaded(false);
    return load(null);
  };

  useEffect(() => {
    void loadServerInfo();
    void (async () => {
      try {
        setChats(await api.chats());
      } catch {
        // список чатов для селекта — необязателен, форма переживёт
      }
    })();
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  const create = async () => {
    if (!newTitle.trim() || !newChatId) return;
    try {
      await api.createTask({ chatId: Number(newChatId), title: newTitle.trim() });
      setNewTitle('');
      setNewChatId('');
      await reload();
    } catch (e) {
      if (!(e instanceof UnauthorizedError)) setError(e instanceof Error ? e.message : 'ошибка');
    }
  };

  const loadMore = async () => {
    if (!hasMore || loadingMore) return;
    setLoadingMore(true);
    try {
      await load(cursor);
    } finally {
      setLoadingMore(false);
    }
  };

  if (error) return <div className="p-4 text-red-600">Ошибка: {error}</div>;
  if (!loaded) return <div className="p-4 text-slate-500">Загрузка задач…</div>;

  return (
    <div className="mx-auto max-w-2xl space-y-3 p-4">
      <div className="flex gap-2">
        {['', 'open', 'needs_review', 'done', 'cancelled'].map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={`rounded-lg px-3 py-1.5 text-sm ${filter === s ? 'bg-slate-900 text-white' : 'bg-white text-slate-700'}`}
          >
            {s === '' ? 'Все' : s === 'open' ? 'Открытые' : s === 'needs_review' ? 'Проверить' : s === 'done' ? 'Готовые' : 'Отменённые'}
          </button>
        ))}
      </div>
      <div className="rounded-xl bg-white p-4 shadow-sm">
        <div className="mb-2 text-sm font-medium">Новая задача вручную</div>
        <select value={newChatId} onChange={(e) => setNewChatId(e.target.value)} className="mb-2 w-full rounded-lg border border-slate-200 bg-white p-2 text-sm">
          <option value="">— выберите чат —</option>
          {chats.map((c) => (
            <option key={c.id} value={c.id}>
              {c.displayName ?? c.jid}
              {c.isGroup === 1 ? ' 👥' : ''} · {c.messageCount} сообщ.
            </option>
          ))}
        </select>
        <input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="Формулировка задачи" className="mb-2 w-full rounded-lg border border-slate-200 p-2 text-sm" />
        <button onClick={() => void create()} disabled={!newTitle.trim() || !newChatId} className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm text-white disabled:opacity-50">Создать</button>
      </div>
      {tasks.length === 0 && <div className="text-slate-500">Задач нет.</div>}
      {tasks.map((t) => (
        <TaskCard key={t.id} task={t} onChanged={() => void reload()} />
      ))}
      {hasMore && (
        <button onClick={() => void loadMore()} disabled={loadingMore} className="w-full rounded-xl bg-white p-3 text-sm text-slate-700 shadow-sm disabled:opacity-50">
          {loadingMore ? 'Загрузка…' : 'Показать ещё'}
        </button>
      )}
    </div>
  );
}
