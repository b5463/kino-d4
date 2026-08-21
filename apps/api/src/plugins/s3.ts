import fp from 'fastify-plugin';
import { S3Client } from '@aws-sdk/client-s3';
import type { ApiConfig } from '../config';

declare module 'fastify' {
  interface FastifyInstance {
    s3: S3Client;
  }
}

export interface S3PluginOptions {
  config: ApiConfig;
}

export const s3Plugin = fp<S3PluginOptions>(
  async (app, opts) => {
    const client = new S3Client({
      endpoint: opts.config.S3_ENDPOINT,
      region: opts.config.S3_REGION,
      // MinIO serves buckets as path segments, not as virtual host subdomains.
      forcePathStyle: true,
      // Routes like POST /uploads/:id/complete hold a pooled database
      // connection across this storage round trip; a hung MinIO must fail the
      // request, not wedge the API. 30 s covers a slow multipart part copy.
      requestHandler: { connectionTimeout: 5_000, requestTimeout: 30_000 },
      credentials: {
        accessKeyId: opts.config.S3_ACCESS_KEY,
        secretAccessKey: opts.config.S3_SECRET_KEY,
      },
    });

    app.decorate('s3', client);
    app.addHook('onClose', async () => {
      client.destroy();
    });
  },
  { name: 'kino-s3' },
);
