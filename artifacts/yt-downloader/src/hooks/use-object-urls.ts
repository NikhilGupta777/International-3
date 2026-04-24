// Hook: stable object URLs for File previews with automatic revoke on unmount/change.
import { useEffect, useMemo } from "react";

export function useObjectUrls(files: File[]): string[] {
  const urls = useMemo(() => files.map((f) => URL.createObjectURL(f)), [files]);
  useEffect(() => {
    return () => {
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [urls]);
  return urls;
}
