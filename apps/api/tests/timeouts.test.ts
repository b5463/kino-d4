import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { buildServer } from '../src/server';
import { loadConfig } from '../src/config';

const app = buildServer(loadConfig({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent' }));

beforeAll(async () => {
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('pool-protecting timeouts', () => {
  it('every pooled connection carries a statement timeout', async () => {
    const rows = await app.db.execute(sql`show statement_timeout`);
    expect(rows[0]).toEqual({ statement_timeout: '15s' });
  });
});
