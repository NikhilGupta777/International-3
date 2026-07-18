/**
 * S3 can return object keys containing XML-hostile control characters. Asking
 * ListObjectsV2 for URL encoding keeps the response parseable; decode the key
 * before passing it to subsequent S3 operations.
 */
export function decodeS3ListedKey(key: string): string {
  try {
    return decodeURIComponent(key);
  } catch {
    // A malformed percent sequence should not make an entire listing unusable.
    return key;
  }
}
