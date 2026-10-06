import { useEffect, useState } from 'react';
import DashboardPage from './pages/Dashboard';
import Login from './pages/Login';
import Tasks from './pages/Tasks';
import WhatsApp from './pages/WhatsApp';

type Route = 'dashboard' | 'whatsapp' | 'tasks' | 'login';

function route(): Route {
  const h = window.location.hash;
  if (h.startsWith('#/whatsapp')) return 'whatsapp';
  if (h.startsWith('#/tasks')) return 'tasks';
  if (h.startsWith('#/login')) return 'login';
  return 'dashboard';
}

function Nav({ current }: { current: Route }) {
  const link = (to: string, label: string, active: boolean) => (
    <a
      key={to}
      href={`#/${to}`}
      className={`rounded-lg px-3 py-2 text-sm ${active ? 'bg-slate-900 text-white' : 'text-slate-600'}`}
    >
      {label}
    </a>
  );
  return (
    <nav className="sticky top-0 flex gap-1 border-b border-slate-200 bg-slate-50/95 p-2 backdrop-blur">
      {link('dashboard', '🏠 Главная', current === 'dashboard')}
      {link('tasks', '📝 Задачи', current === 'tasks')}
      {link('whatsapp', '📱 WhatsApp', current === 'whatsapp')}
    </nav>
  );
}

export default function App() {
  const [current, setCurrent] = useState<Route>(route());

  useEffect(() => {
    const onHash = () => setCurrent(route());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  if (current === 'login') {
    return <Login onDone={() => (window.location.hash = '#/dashboard')} />;
  }

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900">
      <Nav current={current} />
      {current === 'dashboard' && <DashboardPage />}
      {current === 'tasks' && <Tasks />}
      {current === 'whatsapp' && <WhatsApp />}
    </div>
  );
}
