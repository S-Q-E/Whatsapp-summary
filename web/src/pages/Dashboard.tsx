import { useEffect, useState } from 'react';
import { UnauthorizedError, api, formatDue, type Dashboard, type Task } from '../api';

export default function DashboardPage() {
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [status, setStatus] = useState<string>('…');
  const [attention, setAttention] = useState<Task[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [d, s, tasks] = await Promise.all([api.dashboard(), api.waStatus(), api.tasks()]);
        setDash(d);
        setStatus(s.state);
        const open = tasks.filter((t) => t.status === 'open' || t.status === 'needs_review');
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const att = open.filter(
          (t) => t.status === 'needs_review' || (t.dueAt !== null && t.dueAt <= Date.now()),
        );
        const rest = open.filter((t) => !att.includes(t));
        const done = tasks.filter((t) => t.status === 'done');
        setAttention([...att, ...rest.slice(0, 5), ...done.slice(0, 3)]);
      } catch (e) {
        if (e instanceof UnauthorizedError) window.location.hash = '#/login';
        else setError(e instanceof Error ? e.message : 'ошибка');
      }
    })();
  }, []);

  if (error) return <div className="p-4 text-red-600">Ошибка: {error}</div>;
  if (!dash) return <div className="p-4 text-slate-500">Загрузка…</div>;

  const connected = status === 'open';
  const cards: Array<[string, number]> = [
    ['Сообщений сегодня', dash.messagesToday],
    ['Активных задач', dash.activeTasks],
    ['Просрочено', dash.overdueTasks],
    ['Выполнено сегодня', dash.doneToday],
    ['На проверке', dash.needsReview],
  ];

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-4">
      <h1 className="text-xl font-bold">WhatsApp AI Secretary</h1>
      <div className="rounded-xl bg-white p-4 shadow-sm">
        <div className="text-lg">{connected ? '🟢 Подключён' : `🔴 ${status}`}</div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {cards.map(([label, n]) => (
          <div key={label} className="rounded-xl bg-white p-3 shadow-sm">
            <div className="text-2xl font-bold">{n}</div>
            <div className="text-xs text-slate-500">{label}</div>
          </div>
        ))}
      </div>
      {attention.length > 0 && (
        <div className="space-y-2">
          <h2 className="font-medium">🔴 Нужно внимание</h2>
          {attention.map((t) => (
            <div key={t.id} className="rounded-xl bg-white p-3 shadow-sm">
              <div className="text-sm font-medium text-slate-800">{t.contactName}</div>
              <div>{t.title}</div>
              <div className="text-xs text-slate-500">Срок: {formatDue(t)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
