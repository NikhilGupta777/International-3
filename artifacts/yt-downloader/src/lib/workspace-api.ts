/**
 * Workspace API client — thin typed wrappers around /api/workspace/*.
 *
 * All requests include cookies (same-origin). Errors bubble as thrown Error.
 */

export type WorkspaceInfo = {
  displayName: string;
  authMethod: string;
  adapters: {
    s3: { enabled: boolean; limits: { MAX_FILE_BYTES: number; MAX_DIRECT_WRITE_BYTES: number } };
    drive: { enabled: boolean; allowedFolderId?: string };
  };
};

export type WorkspaceFile = {
  path: string;
  size: number;
  modifiedAt: number;
  contentType?: string;
};

export type WorkspaceListing = { files: WorkspaceFile[]; nextCursor?: string };

export type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  size?: number;
  modifiedTime?: string;
  parents?: string[];
  isFolder: boolean;
};

export type DriveListing = { files: DriveFile[]; nextPageToken?: string };

async function req<T>(input: string, init?: RequestInit, attempt = 0): Promise<T> {
  const res = await fetch(input, {
    credentials: "include",
    cache: "no-store",
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const contentType = res.headers.get("content-type") ?? "";
  const bodyText = await res.text();
  const parseJson = () => {
    if (!bodyText.trim()) return null;
    if (!contentType.includes("application/json")) return null;
    try {
      return JSON.parse(bodyText);
    } catch {
      if ((init?.method ?? "GET").toUpperCase() === "GET" && attempt === 0) {
        return null;
      }
      throw new Error(`Invalid JSON response from workspace API (${res.status})`);
    }
  };
  const body = parseJson();
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    if (body?.error) msg = body.error;
    else if (bodyText.trim()) msg = bodyText.slice(0, 240);
    throw new Error(msg);
  }
  if (res.status === 204) return undefined as T;
  if (body === null) {
    if ((init?.method ?? "GET").toUpperCase() === "GET" && attempt === 0) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return req<T>(input, init, attempt + 1);
    }
    throw new Error("Workspace API returned an empty response. Please refresh and try again.");
  }
  return body as T;
}

export const workspaceApi = {
  info: () => req<WorkspaceInfo>("/api/workspace/info"),

  listFiles: (dir = "", limit = 100, cursor?: string) =>
    req<WorkspaceListing>(
      `/api/workspace/files?dir=${encodeURIComponent(dir)}&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    ),

  getFile: (path: string, opts?: { inline?: boolean }) =>
    req<{ stat: WorkspaceFile; url: string; expiresIn: number }>(
      `/api/workspace/file?path=${encodeURIComponent(path)}${opts?.inline ? "&inline=1" : ""}`,
    ),

  readText: (path: string) =>
    req<{ content: string; contentType: string; size: number }>(
      `/api/workspace/file?path=${encodeURIComponent(path)}&text=1`,
    ),

  writeText: (path: string, content: string, contentType?: string) =>
    req<{ file: WorkspaceFile }>("/api/workspace/file", {
      method: "POST",
      body: JSON.stringify({ path, content, contentType }),
    }),

  deleteFile: (path: string) =>
    req<{ ok: true }>(`/api/workspace/file?path=${encodeURIComponent(path)}`, { method: "DELETE" }),

  presignPut: (path: string, size: number, contentType?: string) =>
    req<{ uploadUrl: string; expiresIn: number }>("/api/workspace/presign-put", {
      method: "POST",
      body: JSON.stringify({ path, size, contentType }),
    }),

  /** Upload a File to workspace via presigned PUT. Reports progress 0..1. */
  uploadFile: async (
    path: string,
    file: File,
    onProgress?: (p: number) => void,
  ): Promise<WorkspaceFile> => {
    const { uploadUrl } = await workspaceApi.presignPut(path, file.size, file.type || undefined);
    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", uploadUrl);
      if (file.type) xhr.setRequestHeader("Content-Type", file.type);
      xhr.upload.onprogress = (ev) => {
        if (ev.lengthComputable && onProgress) onProgress(ev.loaded / ev.total);
      };
      xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`upload failed: ${xhr.status}`)));
      xhr.onerror = () => reject(new Error("network error during upload"));
      xhr.send(file);
    });
    const { stat } = await workspaceApi.getFile(path);
    return stat;
  },

  // ── Drive ──────────────────────────────────────────────────────────────
  driveStatus: () =>
    req<{ configured: boolean; allowedFolderId?: string; serviceAccount?: string; reachable?: boolean; reason?: string }>(
      "/api/workspace/drive/status",
    ),

  driveList: (opts?: { folderId?: string; q?: string; pageSize?: number; pageToken?: string }) => {
    const qs = new URLSearchParams();
    if (opts?.folderId) qs.set("folderId", opts.folderId);
    if (opts?.q) qs.set("q", opts.q);
    if (opts?.pageSize) qs.set("pageSize", String(opts.pageSize));
    if (opts?.pageToken) qs.set("pageToken", opts.pageToken);
    return req<DriveListing>(`/api/workspace/drive/files?${qs.toString()}`);
  },

  driveImport: (driveFileId: string, path: string) =>
    req<{ file: WorkspaceFile; driveName: string; driveMimeType: string; downloadUrl: string }>(
      "/api/workspace/import-drive",
      { method: "POST", body: JSON.stringify({ driveFileId, path }) },
    ),
};

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
