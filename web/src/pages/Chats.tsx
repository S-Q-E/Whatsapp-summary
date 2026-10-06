import { useEffect, useState } from 'react';
import { UnauthorizedError, api } from '../api';

type Chat = {
  id: number;
  jid: string;
  displayName: string | null;
  isGroup: number;
  ignored: number;
  messageCount: number;
};

export default function Chats() {
  const [chats, setChats] = useState<Chat[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      setChats(await api.chats());
    } catch (e) {
      if (e instanceof UnauthorizedError) window.location.hash = '#/login';
      else setError(e instanceof Error ? e.message : 'ошибка');
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = async (c: Chat) => {
    try {
      await api.setChatIgnored(c.id, c.ignored === 1 ? 0 : 1);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ошибка');
    }
  };

  if (error) return <div className="p-4 text-red-600">Ошибка: {error}</div>;
  if (!chats) return <div className="p-4 text-slate-500">Загрузка чатов…</div>;

  return (
    <div className="mx-auto max-w-2xl space-y-3 p-4">
      <h1 className="text-xl font-bold">Чаты</h1>
      <p className="text-sm text-slate-500">
        Переключатель «Анализировать» решает, отправляются ли тексты чата в AI-анализ.
        Сообщения продолжают сохраняться всегда. Группы по умолчанию не анализируются.
      </p>
      {chats.length === 0 && <div className="text-slate-500">Чатов пока нет.</div>}
      {chats.map((c) => (
        <div key={c.id} className="flex items-center justify-between gap-3 rounded-xl bg-white p-3 shadow-sm">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-slate-800">
              {c.displayName ?? c.jid} {c.isGroup === 1 && <span title="группа">👥</span>}
            </div>
            <div className="truncate font-mono text-xs text-slate-400">{c.jid}</div>
            <div className="text-xs text-slate-500">
              {c.messageCount} сообщений{c.ignored === 1 && ' · исключён из анализа'}
            </div>
          </div>
          <button
            onClick={() => void toggle(c)}
            title={c.ignored === 1 ? 'Включить AI-анализ этого чата' : 'Исключить чат из AI-анализа'}
            className={`shrink-0 rounded-lg px-3 py-1.5 text-sm ${c.ignored === 1 ? 'bg-slate-200 text-slate-600' : 'bg-green-100 text-green-800'}`}
          >
            {c.ignored === 1 ? 'Анализировать: выкл' : 'Анализировать: вкл'}
          </button>
        </div>
      ))}
    </div>
  );
}
