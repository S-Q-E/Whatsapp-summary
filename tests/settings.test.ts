import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openTestDb } from './db.js';
import { getAllSettings, getSetting, setSetting } from '../src/database/repositories/settings.js';

describe('settings repository', () => {
  it('get несуществующего — null, set/get roundtrip, перезапись', () => {
    const { db, close } = openTestDb();
    try {
      assert.equal(getSetting(db, 'digest_time'), null);
      setSetting(db, 'digest_time', '18:00');
      assert.equal(getSetting(db, 'digest_time'), '18:00');
      setSetting(db, 'digest_time', '19:30');
      assert.equal(getSetting(db, 'digest_time'), '19:30');
      setSetting(db, 'timezone', 'Asia/Almaty');
      assert.deepEqual(getAllSettings(db), { digest_time: '19:30', timezone: 'Asia/Almaty' });
    } finally {
      close();
    }
  });
});
