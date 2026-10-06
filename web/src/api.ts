export type WaState = 'connecting' | 'qr' | 'open' | 'closed' | 'logged_out';

export type WaStatus = {
  state: WaState;
  phone: string | null;
  connectedAt: number | null;
  lastSeen: number | null;
  hasSession: boolean;
  qrAvailable: boolean;
};

export type Dashboard = {
  messagesToday: number;
  openTasks: number;
  overdueTasks: number;
  doneToday: number;
  needsReview: number;
  activeTasks: number;
};

export type Task = {
  id: number;
  title: string;
  description: string | null;
  status: string;
  dueAt: number | null;
  dueText: string | null;
  confidence: number | null;
  manual: number;
  model: string | null;
  contactName: string | null;
  chatJid: string;
  chatId: number;
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
};

export type ContextMessage = {
  id: number;
  direction: string;
  senderName: string | null;
  text: string | null;
  messageType: string;
  timestamp: number;
  isSource: boolean;
  isClosing: boolean;
};

export class UnauthorizedError extends Error {
  constructor() {
    super('unauthorized');
    this.name = 'UnauthorizedError';
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  login: (password: string) =>
    req<{ ok: boolean }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ password }) }),
  waStatus: () => req<WaStatus>('/api/whatsapp/status'),
  waQr: () => req<{ dataUrl: string | null; updatedAt: number | null }>('/api/whatsapp/qr'),
  waDisconnect: () => req<WaStatus>('/api/whatsapp/disconnect', { method: 'POST' }),
  waConnect: () => req<WaStatus>('/api/whatsapp/connect', { method: 'POST' }),
  dashboard: () => req<Dashboard>('/api/dashboard'),
  tasks: (status?: string) => req<Task[]>(`/api/tasks${status ? `?status=${status}` : ''}`),
  patchTask: (id: number, body: { status?: string; title?: string; dueAt?: string | null }) =>
    req<Task>(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  createTask: (body: { chatJid: string; title: string }) =>
    req<Task>('/api/tasks', { method: 'POST', body: JSON.stringify(body) }),
  taskContext: (id: number) =>
    req<{ task: { id: number; title: string }; messages: ContextMessage[] }>(`/api/tasks/${id}/context`),
};

export function formatDue(t: Task): string {
  if (t.dueText) return t.dueText;
  if (t.dueAt) return new Date(t.dueAt).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  return 'без срока';
}

export function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
}
