import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import { pino, type Logger } from 'pino';
import { buildLoggerOptions } from '../src/logging';
import { loadConfig } from '../src/config';

// Needs no services — this exercises the logger configuration the server runs.

function captureLogs(emit: (log: Logger) => void): string {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  emit(pino(buildLoggerOptions('info'), sink));
  return chunks.join('');
}

describe('log redaction (05 §13)', () => {
  it('censors a Wi-Fi password at every depth it can be logged', () => {
    const output = captureLogs((log) => {
      log.info({ password: 'hunter2' }, 'top level');
      log.info({ wifi: { password: 'hunter2' } }, 'one deep');
      log.info({ body: { wifi: { password: 'hunter2' } } }, 'two deep — the 05 §13 shape');
      log.info({ req: { body: { wifi: { password: 'hunter2' } } } }, 'three deep');
      log.info({ device: { wifi: { passphrase: 'hunter2' } } }, 'passphrase');
    });

    expect(output).not.toContain('hunter2');
    expect(output).toContain('[REDACTED]');
  });

  it('censors the config secrets, whose key names the generic rules miss', () => {
    // S3_SECRET_KEY is NOT matched by a `secret` rule — fast-redact matches
    // whole key names — and the URLs carry an inline password.
    const config = loadConfig({
      DATABASE_URL: 'postgres://kino:s3cr3t-pg@localhost:5435/kino',
      REDIS_URL: 'redis://:s3cr3t-redis@localhost:6380',
      S3_ACCESS_KEY: 's3cr3t-access',
      S3_SECRET_KEY: 's3cr3t-s3',
      // Also the reason this call needs no NODE_ENV: supplying a real cookie
      // secret satisfies the fail-closed check in config.ts.
      COOKIE_SECRET: 's3cr3t-cookie-signing-key',
    });

    const output = captureLogs((log) => {
      log.info(config, 'config at top level');
      log.info({ config }, 'config one deep');
      log.info({ app: { config } }, 'config two deep');
    });

    for (const secret of [
      's3cr3t-pg',
      's3cr3t-redis',
      's3cr3t-access',
      's3cr3t-s3',
      's3cr3t-cookie-signing-key',
    ]) {
      expect(output).not.toContain(secret);
    }
    // Non-secret config still comes through, so this is not a blanket blackout.
    expect(output).toContain('kino-media');
  });

  it('censors credential-bearing headers', () => {
    const output = captureLogs((log) => {
      log.info({ headers: { authorization: 'Bearer nope', cookie: 'session=nope' } }, 'headers');
      log.info({ req: { headers: { authorization: 'Bearer nope' } } }, 'req headers');
    });

    expect(output).not.toContain('Bearer nope');
    expect(output).not.toContain('session=nope');
  });

  it('never lets a request body reach the log through the req serializer', () => {
    const output = captureLogs((log) => {
      log.info(
        {
          req: {
            id: 'req-1',
            method: 'POST',
            url: '/api/devices',
            ip: '127.0.0.1',
            body: { wifi: { password: 'hunter2' } },
            headers: { authorization: 'Bearer nope' },
          },
        },
        'incoming request',
      );
    });

    // The serializer emits an allow-list, so body/headers are dropped wholesale
    // rather than merely censored.
    expect(output).not.toContain('hunter2');
    expect(output).not.toContain('Bearer nope');
    expect(output).not.toContain('body');
    expect(output).toContain('"url":"/api/devices"');
  });
});
