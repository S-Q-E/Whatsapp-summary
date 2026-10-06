import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';

function runEnv(extraEnv: NodeJS.ProcessEnv): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      'node',
      ['--import', 'tsx', '-e', 'import("./src/config/env.js").then(() => {})'],
      { cwd: process.cwd(), env: { ...process.env, ...extraEnv }, timeout: 60_000 },
      (err, _stdout, stderr) => {
        resolve({ code: err ? (err as { code?: number }).code ?? 1 : 0, stderr: String(stderr) });
      },
    );
  });
}

describe('конфиг env (zod, ошибки на русском)', () => {
  it('валидный TIMEZONE запускается молча', async () => {
    const r = await runEnv({ TIMEZONE: 'Asia/Almaty' });
    assert.equal(r.code, 0);
  });

  it('невалидный TIMEZONE — понятная русская ошибка, ненулевой код', async () => {
    const r = await runEnv({ TIMEZONE: 'Mars/Olympus' });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /TIMEZONE/);
    assert.match(r.stderr, /временная зона/);
  });

  it('невалидный WEB_PORT — понятная русская ошибка', async () => {
    const r = await runEnv({ WEB_PORT: 'самолёт' });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /WEB_PORT/);
  });
});
