import { useState } from 'react';
import { api } from '../api';

export default function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.login(password);
      onDone();
    } catch {
      setError('Неверный пароль');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center p-4">
      <h1 className="mb-1 text-xl font-bold">WhatsApp AI Secretary</h1>
      <p className="mb-4 text-sm text-slate-500">Введите пароль для входа</p>
      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && void submit()}
        placeholder="Пароль"
        className="mb-2 rounded-lg border border-slate-200 p-2"
      />
      {error && <div className="mb-2 text-sm text-red-600">{error}</div>}
      <button disabled={busy} onClick={() => void submit()} className="rounded-lg bg-slate-900 px-3 py-2 text-white disabled:opacity-50">
        Войти
      </button>
    </div>
  );
}
