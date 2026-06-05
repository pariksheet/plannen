// cli/lib/storage-smoke.mjs
//
// Smoke-test S3 credentials by listing one object from the bucket.
// Used by `plannen cloud provision`'s configure-storage step.

import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';

export async function smokeS3({
  S3_ENDPOINT,
  S3_REGION,
  S3_BUCKET,
  S3_ACCESS_KEY_ID,
  S3_SECRET_ACCESS_KEY,
  S3_FORCE_PATH_STYLE,
}) {
  const client = new S3Client({
    endpoint: S3_ENDPOINT,
    region: S3_REGION ?? 'auto',
    credentials: {
      accessKeyId: S3_ACCESS_KEY_ID,
      secretAccessKey: S3_SECRET_ACCESS_KEY,
    },
    forcePathStyle: S3_FORCE_PATH_STYLE === 'true',
  });
  await client.send(new ListObjectsV2Command({ Bucket: S3_BUCKET, MaxKeys: 1 }));
}
