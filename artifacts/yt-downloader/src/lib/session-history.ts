/**
 * Agent session history — persists conversations in localStorage
 * Each session = { id, title, messages[], createdAt, updatedAt }
 */

export interface AgentMessage {
  id: string;
  role: "user" | "assistant";
  content: string;          // markdown text
  ts: number;
  toolCount?: number;       // how many tools ran
  hasArtifact?: boolean;
}

export interface AgentSession {
  id: string;
  title: string;
  messages: AgentMessage[];
  createdAt: number;
  updatedAt: number;
}

const KEY   = "vm-agent-sessions-v2";
const MAX   = 40;           // keep last 40 sessions
const TRUNC = 120;          // max sessions stored total

function load(): AgentSession[] {
  try { return JSON.parse(localStorage.getItem(KEY) ?? "[]"); }
  catch { return []; }
}

function save(sessions: AgentSession[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(sessions.slice(0, TRUNC))); }
  catch { /* quota exceeded — silently skip */ }
}

export function loadSessions(): AgentSession[] {
  return load().slice(0, MAX);
}

export function getSession(id: string): AgentSession | undefined {
  return load().find(s => s.id === id);
}

export function saveSession(session: AgentSession): void {
  const all = load().filter(s => s.id !== session.id);
  save([{ ...session, updatedAt: Date.now() }, ...all]);
}

export function deleteSession(id: string): void {
  save(load().filter(s => s.id !== id));
}

export function createSession(firstUserMsg: string): AgentSession {
  const id = crypto.randomUUID();
  const title = firstUserMsg.length > 60 ? firstUserMsg.slice(0, 57) + "..." : firstUserMsg;
  return { id, title, messages: [], createdAt: Date.now(), updatedAt: Date.now() };
}

export function updateSessionTitle(id: string, title: string): void {
  const all = load();
  const idx = all.findIndex(s => s.id === id);
  if (idx !== -1) { all[idx].title = title; all[idx].updatedAt = Date.now(); save(all); }
}
