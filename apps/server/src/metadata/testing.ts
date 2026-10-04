/** The test S3 server as `http://<key>:<secret>@<host>/<bucket>`; S3 tests skip locally without it and fail in CI. */
export const s3Url = process.env.TEST_S3_URL;
if (!s3Url && process.env.CI)
  throw new Error("TEST_S3_URL is required for S3 tests in CI.");
if (!s3Url)
  console.info(
    "Skipping S3 tests: set TEST_S3_URL to a test S3-compatible server.",
  );

/** An S3 artwork store on the bucket TEST_S3_URL names. */
export function testS3Store() {
  const url = new URL(s3Url ?? "");
  const bucket = url.pathname.slice(1);
  const client = new Bun.S3Client({
    endpoint: url.origin,
    bucket,
    // Bun signs a custom endpoint for "auto", which versitygw rejects.
    region: "us-east-1",
    accessKeyId: decodeURIComponent(url.username),
    secretAccessKey: decodeURIComponent(url.password),
  });
  return { backend: "s3" as const, client, bucket, endpoint: url.origin };
}
