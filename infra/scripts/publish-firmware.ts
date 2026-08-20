import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { firmwareManifest, type FirmwareManifest } from '@kino/schemas';
import postgres from 'postgres';

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

interface PublishOptions {
  packageDir: string;
  notes: string | null;
}

function usage(): never {
  throw new Error(
    'Usage: npm run firmware:publish -- <package-directory> [--notes "text"]',
  );
}

function parseArgs(argv: string[]): PublishOptions {
  const packageDir = argv[0];
  if (!packageDir || packageDir.startsWith('--')) usage();
  let notes: string | null = null;
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--notes' && argv[i + 1] !== undefined) notes = argv[++i] ?? null;
    else usage();
  }
  return { packageDir: resolve(packageDir), notes };
}

function safeFile(file: string): boolean {
  return file.split('/').every((part) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part));
}

export interface VerifiedFirmwarePackage {
  manifest: FirmwareManifest;
  files: Map<string, Uint8Array>;
}

/** Reads every target and verifies the package before any remote state changes. */
export async function loadFirmwarePackage(packageDir: string): Promise<VerifiedFirmwarePackage> {
  const raw = JSON.parse(await readFile(resolve(packageDir, 'manifest.json'), 'utf8')) as unknown;
  const parsed = firmwareManifest.shape.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid manifest.json: ${parsed.error.message}`);
  if (!parsed.data.channel) throw new Error('manifest.json must name a release channel');
  if (!safeFile(parsed.data.channel)) throw new Error('manifest.json channel is unsafe');
  if (!/^\d+\.\d+\.\d+$/.test(parsed.data.release)) {
    throw new Error('manifest.json release must be a V1 semantic version such as 1.2.3');
  }

  const files = new Map<string, Uint8Array>();
  for (const [target, image] of Object.entries(parsed.data.targets)) {
    if (!safeFile(image.file)) throw new Error(`${target} has an unsafe file path: ${image.file}`);
    const path = resolve(packageDir, ...image.file.split('/'));
    const fileStat = await stat(path);
    if (!fileStat.isFile() || fileStat.size === 0 || fileStat.size > MAX_IMAGE_BYTES) {
      throw new Error(`${target} image size ${fileStat.size} bytes is out of range`);
    }
    const body = new Uint8Array(await readFile(path));
    const actual = createHash('sha256').update(body).digest('hex');
    if (actual !== image.sha256) {
      throw new Error(`${target} failed SHA-256 verification (expected ${image.sha256}, got ${actual})`);
    }
    files.set(target, body);
  }
  return { manifest: parsed.data, files };
}

async function publish(options: PublishOptions): Promise<void> {
  const verified = await loadFirmwarePackage(options.packageDir);
  const { manifest } = verified;
  const databaseUrl = process.env.DATABASE_URL ?? 'postgres://kino:kino@localhost:5435/kino';
  const bucket = process.env.S3_FIRMWARE_BUCKET ?? 'kino-firmware';
  const s3 = new S3Client({
    endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
    region: process.env.S3_REGION ?? 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY ?? 'kino',
      secretAccessKey: process.env.S3_SECRET_KEY ?? 'kino-secret',
    },
  });
  const sql = postgres(databaseUrl, { max: 1 });
  const uploaded: string[] = [];
  try {
    // Serialises publishers of the same immutable release/channel pair. Without
    // this, two operators could both pass the existence check, and the loser of
    // the unique insert would delete the winner's just-uploaded objects.
    await sql`select pg_advisory_lock(hashtext(${`${manifest.channel}:${manifest.release}`}))`;
    const existing = await sql<{ id: string }[]>`
      select id from firmware_releases
       where release = ${manifest.release} and channel = ${manifest.channel}
       limit 1
    `;
    if (existing.length > 0) {
      throw new Error(`${manifest.release} (${manifest.channel}) is already published`);
    }

    for (const [target, image] of Object.entries(manifest.targets)) {
      const body = verified.files.get(target);
      if (!body) throw new Error(`verified bytes for ${target} disappeared`);
      const key = `firmware/${manifest.channel}/${manifest.release}/${image.file}`;
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: 'application/octet-stream',
          Metadata: { sha256: image.sha256, target },
        }),
      );
      uploaded.push(key);
    }

    await sql`
      insert into firmware_releases
        (id, release, channel, compatible_hardware, protocol_min, protocol_max, manifest, notes)
      values
        (${`fw_${randomUUID()}`}, ${manifest.release}, ${manifest.channel},
         ${sql.json(manifest.compatibleHardware)}, ${manifest.protocolMin}, ${manifest.protocolMax},
         ${sql.json(manifest)}, ${options.notes})
    `;
    process.stdout.write(
      `Published firmware ${manifest.release} (${manifest.channel}) to ${bucket}: ${uploaded.length} target(s)\n`,
    );
  } catch (error) {
    // A failed publication must not leave downloadable bytes with no catalog
    // row. Releases are immutable, so these keys cannot belong to an older row.
    await Promise.allSettled(
      uploaded.map((key) => s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))),
    );
    throw error;
  } finally {
    await sql.end({ timeout: 5 });
    s3.destroy();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  Promise.resolve()
    .then(() => publish(parseArgs(process.argv.slice(2))))
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Firmware publish failed: ${message}\n`);
      process.exitCode = 1;
    });
}
