// cli/lib/storage-runtime.mjs
//
// Build storage adapters + a backend-specific downloadFn from an env bag.
// Shared by `plannen storage migrate` and any future operator-side tooling.
//
// Self-contained: does NOT import the .ts adapter implementations because
// the CLI runs under plain Node (no tsx/ts-node). Instead each backend is
// re-implemented inline using fetch (supabase, local-fs) and
// @aws-sdk/client-s3 (s3).

/** Bucket name — mirrors BUCKET in backend/src/_shared-overlay/storage/adapter.ts */
const BUCKET = 'event-photos';

function assertCanonicalKey(key) {
  if (!key || key.startsWith('/') || key.startsWith(`${BUCKET}/`)) {
    throw new Error(`storage: key must be backend-agnostic (got "${key}")`);
  }
  if (key.includes('..') || key.includes('//')) {
    throw new Error(`storage: invalid key "${key}"`);
  }
}

// ---------------------------------------------------------------------------
// Supabase adapter (fetch-based, mirrors supabase.ts)
// ---------------------------------------------------------------------------
function createSupabaseAdapter({ supabaseUrl, serviceRoleKey }) {
  const base = supabaseUrl.replace(/\/+$/, '');
  const storageBase = `${base}/storage/v1`;
  const auth = { authorization: `Bearer ${serviceRoleKey}` };

  function objectUrl(key) {
    return `${storageBase}/object/${BUCKET}/${key}`;
  }

  return {
    async upload(key, bytes, options) {
      assertCanonicalKey(key);
      const res = await fetch(objectUrl(key), {
        method: 'POST',
        headers: {
          ...auth,
          'content-type': options.contentType ?? 'application/octet-stream',
          'cache-control': options.cacheControl ?? 'private, max-age=3600',
          'x-upsert': 'true',
        },
        body: bytes,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`storage(supabase): upload failed ${res.status} ${detail}`);
      }
    },

    async delete(key) {
      assertCanonicalKey(key);
      const res = await fetch(objectUrl(key), { method: 'DELETE', headers: auth });
      if (res.status === 404) return false;
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`storage(supabase): delete failed ${res.status} ${detail}`);
      }
      return true;
    },

    async signedUrl(key, urlOpts = {}) {
      assertCanonicalKey(key);
      const ttlSeconds = urlOpts.ttlSeconds ?? 900;
      const res = await fetch(`${storageBase}/object/sign/${BUCKET}/${key}`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ expiresIn: ttlSeconds }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`storage(supabase): sign failed ${res.status} ${detail}`);
      }
      const body = await res.json();
      if (!body.signedURL) throw new Error('storage(supabase): sign returned no signedURL');
      return `${storageBase}${body.signedURL}`;
    },

    async head(key) {
      assertCanonicalKey(key);
      const res = await fetch(`${storageBase}/object/info/${BUCKET}/${key}`, {
        method: 'GET',
        headers: auth,
      });
      if (res.status === 404) return null;
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`storage(supabase): info failed ${res.status} ${detail}`);
      }
      const body = await res.json();
      return {
        size: body.size ?? 0,
        contentType: body.content_type ?? body.contentType ?? body.mimetype ?? 'application/octet-stream',
        etag: body.etag,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// S3 adapter (aws-sdk/client-s3, mirrors s3.ts)
// GetObject is used directly for downloads — no presigner dep required.
// ---------------------------------------------------------------------------
function createS3Adapter({ endpoint, region, bucket, accessKeyId, secretAccessKey, forcePathStyle }) {
  // Lazy-import so environments without the package don't break on load.
  let _client = null;
  async function client() {
    if (_client) return _client;
    const { S3Client } = await import('@aws-sdk/client-s3');
    _client = new S3Client({
      endpoint,
      region: region ?? 'auto',
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: forcePathStyle ?? false,
    });
    return _client;
  }

  return {
    async upload(key, bytes, options) {
      assertCanonicalKey(key);
      const { PutObjectCommand } = await import('@aws-sdk/client-s3');
      const c = await client();
      await c.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: bytes,
        ContentType: options.contentType ?? 'application/octet-stream',
        CacheControl: options.cacheControl ?? 'private, max-age=3600',
      }));
    },

    async delete(key) {
      assertCanonicalKey(key);
      const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
      const c = await client();
      try {
        await c.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
        return true;
      } catch (err) {
        const name = err?.name ?? '';
        if (name === 'NoSuchKey' || name === 'NotFound') return false;
        throw err;
      }
    },

    // signedUrl: used only by buildDownloadFn for s3 — we bypass this by using
    // GetObject directly, but we expose the method for interface completeness.
    async signedUrl(key, _urlOpts = {}) {
      assertCanonicalKey(key);
      // Without @aws-sdk/s3-request-presigner installed, return a sentinel.
      // buildDownloadFn for s3 uses GetObject directly and never calls this.
      throw new Error('storage(s3): signedUrl requires @aws-sdk/s3-request-presigner — use buildDownloadFn instead');
    },

    async head(key) {
      assertCanonicalKey(key);
      const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
      const c = await client();
      try {
        const out = await c.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return {
          size: out.ContentLength ?? 0,
          contentType: out.ContentType ?? 'application/octet-stream',
          etag: out.ETag,
        };
      } catch (err) {
        const name = err?.name ?? '';
        if (name === 'NotFound' || name === 'NoSuchKey') return null;
        throw err;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// local-fs adapter (mirrors localFs.ts)
// ---------------------------------------------------------------------------
function createLocalFsAdapter({ photosRoot }) {
  // All path operations are done lazily inside each method to avoid
  // top-level await in a synchronous factory.
  return {
    async upload(key, bytes, _options) {
      assertCanonicalKey(key);
      const { mkdir, writeFile } = await import('node:fs/promises');
      const { resolve: r, join: j, dirname, sep: s } = await import('node:path');
      const root = r(photosRoot);
      const dest = r(root, BUCKET, key);
      if (!dest.startsWith(root + s) && dest !== root) {
        throw new Error(`storage(localFs): path traversal blocked for key "${key}"`);
      }
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, bytes);
    },

    async delete(key) {
      assertCanonicalKey(key);
      const { unlink } = await import('node:fs/promises');
      const { resolve: r, sep: s } = await import('node:path');
      const root = r(photosRoot);
      const dest = r(root, BUCKET, key);
      if (!dest.startsWith(root + s) && dest !== root) {
        throw new Error(`storage(localFs): path traversal blocked for key "${key}"`);
      }
      try {
        await unlink(dest);
        return true;
      } catch (err) {
        if (err.code === 'ENOENT') return false;
        throw err;
      }
    },

    async signedUrl(key, _urlOpts = {}) {
      assertCanonicalKey(key);
      // local-fs signed URLs are same-origin backend URLs; not useful in migrate context
      return `local-fs://${BUCKET}/${key}`;
    },

    async head(key) {
      assertCanonicalKey(key);
      const { stat } = await import('node:fs/promises');
      const { resolve: r, extname, sep: s } = await import('node:path');
      const root = r(photosRoot);
      const dest = r(root, BUCKET, key);
      if (!dest.startsWith(root + s) && dest !== root) {
        throw new Error(`storage(localFs): path traversal blocked for key "${key}"`);
      }
      try {
        const st = await stat(dest);
        const MIME = {
          '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
          '.gif': 'image/gif', '.webp': 'image/webp', '.heic': 'image/heic',
          '.mp4': 'video/mp4', '.mov': 'video/quicktime',
        };
        const ext = extname(key).toLowerCase();
        return {
          size: st.size,
          contentType: MIME[ext] ?? 'application/octet-stream',
        };
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function buildAdapterForBackend(name, env) {
  if (name === 'supabase') {
    return createSupabaseAdapter({
      supabaseUrl: env.SUPABASE_URL,
      serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
    });
  }
  if (name === 's3') {
    return createS3Adapter({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION ?? 'auto',
      bucket: env.S3_BUCKET,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      forcePathStyle: env.S3_FORCE_PATH_STYLE === 'true',
    });
  }
  if (name === 'local-fs') {
    return createLocalFsAdapter({
      photosRoot: env.PLANNEN_PHOTOS_ROOT,
    });
  }
  throw new Error(`unknown backend: ${name}`);
}

export function buildDownloadFn(name, env, adapter) {
  if (name === 'supabase') {
    return async (key) => {
      const base = env.SUPABASE_URL.replace(/\/+$/, '');
      const url = `${base}/storage/v1/object/${BUCKET}/${key}`;
      const res = await fetch(url, {
        headers: { authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
      });
      if (!res.ok) return null;
      return new Uint8Array(await res.arrayBuffer());
    };
  }
  if (name === 's3') {
    // Use GetObject directly — avoids needing @aws-sdk/s3-request-presigner
    return async (key) => {
      const { GetObjectCommand } = await import('@aws-sdk/client-s3');
      const { S3Client } = await import('@aws-sdk/client-s3');
      const c = new S3Client({
        endpoint: env.S3_ENDPOINT,
        region: env.S3_REGION ?? 'auto',
        credentials: {
          accessKeyId: env.S3_ACCESS_KEY_ID,
          secretAccessKey: env.S3_SECRET_ACCESS_KEY,
        },
        forcePathStyle: env.S3_FORCE_PATH_STYLE === 'true',
      });
      try {
        const out = await c.send(new GetObjectCommand({
          Bucket: env.S3_BUCKET,
          Key: key,
        }));
        const chunks = [];
        for await (const chunk of out.Body) {
          chunks.push(chunk);
        }
        const total = chunks.reduce((n, c) => n + c.length, 0);
        const merged = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          merged.set(chunk, offset);
          offset += chunk.length;
        }
        return merged;
      } catch (err) {
        const name = err?.name ?? '';
        if (name === 'NoSuchKey' || name === 'NotFound') return null;
        throw err;
      }
    };
  }
  if (name === 'local-fs') {
    return async (key) => {
      const { readFile } = await import('node:fs/promises');
      const { resolve } = await import('node:path');
      try {
        return new Uint8Array(await readFile(resolve(env.PLANNEN_PHOTOS_ROOT, BUCKET, key)));
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        return null;
      }
    };
  }
  throw new Error(`unknown backend: ${name}`);
}
