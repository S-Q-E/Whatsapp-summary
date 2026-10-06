import { useEffect, useState } from 'react';
import { UnauthorizedError, api, type WaStatus } from '../api';

export default function WhatsApp() {
  const [status, setStatus] = useState<WaStatus | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const s = await api.waStatus();
      setStatus(s);
      if (s.qrAvailable) {
        const q = await api.waQr();
        setQr(q.dataUrl);
      } else {
        setQr(null);
      }
    } catch (e) {
      if (e instanceof UnauthorizedError) window.location.hash = '#/login';
      else setError(e instanceof Error ? e.message : 'ошибка');
    }
  };

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const act = async (fn: () => Promise<WaStatus>) => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await fn());
      await load();
    } catch (e) {
      if (!(e instanceof UnauthorizedError)) setError(e instanceof Error ? e.message : 'ошибка');
    } finally {
      setBusy(false);
    }
  };

  if (error) return <div className="p-4 text-red-600">Ошибка: {error}</div>;
  if (!status) return <div className="p-4 text-slate-500">Загрузка статуса…</div>;

  const connected = status.state === 'open';

  return (
    <div className="mx-auto max-w-md space-y-4 p-4">
      <h1 className="text-xl font-bold">WhatsApp</h1>
      {!connected && status.state !== 'logged_out' && (
        <div className="rounded-xl bg-white p-6 text-center shadow-sm">
          {qr ? (
            <>
              <img src={qr} alt="QR для привязки WhatsApp" className="mx-auto w-64" />
              <p className="mt-4 text-sm">Откройте WhatsApp → Настройки → Связанные устройства → Привязать устройство</p>
              <p className="mt-1 text-xs text-slate-500">QR автоматически обновляется.</p>
            </>
          ) : (
            <p className="text-slate-500">Ожидание QR-кода…</p>
          )}
        </div>
      )}
      {status.state === 'logged_out' && (
        <div className="rounded-xl bg-white p-6 text-center shadow-sm">
          <p>Сессия отозвана. Нажмите «Подключить» для нового QR.</p>
        </div>
      )}
      {connected && (
        <div className="rounded-xl bg-white p-4 shadow-sm">
          <div className="text-lg">🟢 WhatsApp connected</div>
          <div className="mt-2 text-sm text-slate-600">Номер: {status.phone}</div>
          {status.connectedAt && <div className="text-sm text-slate-600">Подключено: {new Date(status.connectedAt).toLocaleString('ru-RU')}</div>}
          {status.lastSeen && <div className="text-sm text-slate-600">Активность: {new Date(status.lastSeen).toLocaleString('ru-RU')}</div>}
        </div>
      )}
      {!connected && <div className="text-lg">🔴 Disconnected ({status.state})</div>}
      <div className="flex gap-2">
        {!connected ? (
          <button disabled={busy} onClick={() => void act(api.waConnect)} className="rounded-lg bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-50">
            Подключить
          </button>
        ) : (
          <button disabled={busy} onClick={() => void act(api.waDisconnect)} className="rounded-lg bg-slate-200 px-3 py-2 text-sm text-slate-700 disabled:opacity-50">
            Disconnect
          </button>
        )}
      </div>
    </div>
  );
}
