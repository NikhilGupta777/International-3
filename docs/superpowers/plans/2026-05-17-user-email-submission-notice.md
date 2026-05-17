# User Email Submission Notice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collect each current password-login user's personal email once before the May 25, 2026 password-login sunset, show clear reminders only to users who have not submitted, and expose all submissions to admins in a real persistent admin tab.

**Architecture:** Reuse the existing `ACCESS_TABLE` DynamoDB table with a separate key namespace for email submissions instead of adding new infrastructure. The frontend uses localStorage only for user experience state: daily popup suppression and submitted-email acknowledgement; DynamoDB remains the admin source of truth. Password-login sessions do not have a stable per-user identity, so browser-local state is required to hide reminders after a user submits from that device.

**Tech Stack:** Express API, AWS SDK DynamoDB v3, React/TypeScript, existing `Home`, `SettingsPanel`, `Sidebar`, `AdminPanel`, existing CSS/theme system, existing API auth middleware.

---

## File Structure

- Create: `artifacts/api-server/src/lib/email-submissions.ts`
  - Owns normalization, validation, DynamoDB write/read, and safe output shape for submitted emails.
- Modify: `artifacts/api-server/src/app.ts`
  - Add authenticated public endpoints under `/api/email-submissions` before the generic `/api` auth guard blocks public API paths, or allow this path through the existing authenticated flow.
- Modify: `artifacts/api-server/src/routes/admin.ts`
  - Add email-submission counts/list to `/api/admin/overview`, or add a focused `/api/admin/email-submissions` route.
- Create: `artifacts/yt-downloader/src/lib/email-submission.ts`
  - Owns localStorage keys and helpers for `hasSubmitted`, daily modal date, and one-time submitted email cache.
- Modify: `artifacts/yt-downloader/src/pages/Home.tsx`
  - Add top notice panel, daily bento popup, settings CTA routing, and pass highlight/focus props to Settings and Sidebar.
- Modify: `artifacts/yt-downloader/src/components/SettingsPanel.tsx`
  - Add one-time personal email submission card with glowing focus state.
- Modify: `artifacts/yt-downloader/src/components/layout/Sidebar.tsx`
  - Add a settings badge/dot when email is missing.
- Modify: `artifacts/yt-downloader/src/components/AdminPanel.tsx`
  - Add a new admin tab for user-submitted emails/messages.
- Modify: `artifacts/yt-downloader/src/index.css`
  - Add dark/light styles for top notice, modal, settings email card, sidebar badge, and admin email tab.
- No CloudFormation change required if `ACCESS_TABLE` remains configured, because the existing API role already has DynamoDB `GetItem`, `PutItem`, `Scan`, `UpdateItem`, and `DeleteItem` on the access table.

---

## Data Model

Use the existing access table with lowercase `pk` and `sk`, matching `auth-access.ts`.

```ts
// DynamoDB item
{
  pk: { S: "email-submission" },
  sk: { S: normalizedEmail },
  email: { S: normalizedEmail },
  name: { S: displayNameOrEmpty },
  loginMethod: { S: "password" | "google" | "unknown" },
  loginEmail: { S: currentGoogleEmailOrEmpty },
  role: { S: "admin" | "user" },
  source: { S: "settings-email-notice" },
  userAgent: { S: truncatedUserAgent },
  submittedAt: { N: String(Date.now()) },
  updatedAt: { N: String(Date.now()) }
}
```

Important behavior:
- One email can only create/update one submission row.
- Do not auto-approve submitted emails for Google login. Admin approval remains separate.
- If the same email is submitted again, update `updatedAt`, `name`, and source metadata; do not create duplicates.
- Do not store raw IP address. If later needed, add a one-way hash; this plan does not require it.

---

### Task 1: Backend Email Submission Persistence

**Files:**
- Create: `artifacts/api-server/src/lib/email-submissions.ts`

- [ ] **Step 1: Add the persistence module**

Implement these exports exactly:

```ts
export type EmailSubmissionInput = {
  email: string;
  name?: string;
  loginMethod?: "password" | "google" | "unknown";
  loginEmail?: string;
  role?: "admin" | "user";
  userAgent?: string;
};

export type EmailSubmissionRecord = {
  email: string;
  name: string;
  loginMethod: "password" | "google" | "unknown";
  loginEmail: string;
  role: "admin" | "user";
  source: "settings-email-notice";
  userAgent: string;
  submittedAt: number;
  updatedAt: number;
};

export function normalizeSubmittedEmail(email: string): string;
export function assertValidSubmittedEmail(email: string): string;
export async function saveEmailSubmission(input: EmailSubmissionInput): Promise<EmailSubmissionRecord>;
export async function listEmailSubmissions(limit?: number): Promise<EmailSubmissionRecord[]>;
```

Use `process.env.ACCESS_TABLE` and the same region fallback as `auth-access.ts`:

```ts
const ACCESS_TABLE = process.env.ACCESS_TABLE?.trim() ?? "";
const DDB_REGION =
  process.env.YOUTUBE_QUEUE_REGION?.trim() ||
  process.env.AWS_DEFAULT_REGION?.trim() ||
  "us-east-1";
```

Validation rules:

```ts
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const normalized = email.trim().toLowerCase();
if (!normalized) throw new Error("Email is required");
if (normalized.length > 254) throw new Error("Email is too long");
if (!EMAIL_RE.test(normalized)) throw new Error("Invalid email address");
```

DynamoDB write:

```ts
await ddbClient.send(new PutItemCommand({
  TableName: ACCESS_TABLE,
  Item: {
    pk: { S: "email-submission" },
    sk: { S: normalizedEmail },
    email: { S: normalizedEmail },
    name: { S: cleanName },
    loginMethod: { S: cleanMethod },
    loginEmail: { S: cleanLoginEmail },
    role: { S: cleanRole },
    source: { S: "settings-email-notice" },
    userAgent: { S: cleanUserAgent.slice(0, 240) },
    submittedAt: { N: String(now) },
    updatedAt: { N: String(now) },
  },
}));
```

DynamoDB scan:

```ts
await ddbClient.send(new ScanCommand({
  TableName: ACCESS_TABLE,
  FilterExpression: "pk = :pk",
  ExpressionAttributeValues: { ":pk": { S: "email-submission" } },
  Limit: Math.min(Math.max(limit ?? 200, 1), 500),
}));
```

- [ ] **Step 2: Add backend compile check**

Run:

```powershell
npm --prefix artifacts/api-server run build
```

Expected: TypeScript build succeeds. If this package has no `build` script, run the repo's existing typecheck/build command found in `package.json`.

---

### Task 2: Public Authenticated Email Submission API

**Files:**
- Modify: `artifacts/api-server/src/app.ts`

- [ ] **Step 1: Import persistence helpers and reuse session context**

Add import:

```ts
import { saveEmailSubmission, listEmailSubmissions } from "./lib/email-submissions";
```

- [ ] **Step 2: Add submit route before the generic `/api` auth guard**

Add after `/api/auth/logout` and before `app.use("/api", ...)`:

```ts
app.post("/api/email-submissions", async (req: Request, res: Response) => {
  const session = getAuthSession(req);
  if (!session.authenticated) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const body = req.body as { email?: unknown; name?: unknown };
  try {
    const record = await saveEmailSubmission({
      email: typeof body.email === "string" ? body.email : "",
      name: typeof body.name === "string" ? body.name : session.name,
      loginMethod: session.method ?? "unknown",
      loginEmail: session.email ?? "",
      role: session.role ?? "user",
      userAgent: String(req.headers["user-agent"] ?? ""),
    });
    res.json({ ok: true, submission: record });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Could not save email" });
  }
});
```

- [ ] **Step 3: Add admin route for direct list access**

Inside the admin-protected branch, admin routes are already protected under `/api/admin`. Prefer a route in `routes/admin.ts`; if keeping it in `app.ts`, enforce `isAdmin(req)` explicitly. The preferred route is Task 3.

- [ ] **Step 4: Verify route auth behavior**

Run local API and check:

```powershell
curl.exe -i -X POST http://localhost:8080/api/email-submissions -H "Content-Type: application/json" -d "{\"email\":\"test@example.com\"}"
```

Expected without cookie: `401 Authentication required`.

---

### Task 3: Admin Email Submissions Endpoint

**Files:**
- Modify: `artifacts/api-server/src/routes/admin.ts`

- [ ] **Step 1: Import list helper**

```ts
import { listEmailSubmissions } from "../lib/email-submissions";
```

- [ ] **Step 2: Add data to `/overview`**

Before `res.json` in `/overview`:

```ts
const emailSubmissions = await listEmailSubmissions(200).catch((err) => {
  console.warn("[admin] failed to scan email submissions", err);
  return [];
});
```

Add to JSON:

```ts
userMessages: {
  emailSubmissions,
  emailSubmissionCount: emailSubmissions.length,
},
```

- [ ] **Step 3: Add focused route**

```ts
router.get("/email-submissions", async (_req, res) => {
  try {
    const submissions = await listEmailSubmissions(500);
    res.json({ ok: true, submissions, count: submissions.length });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to list email submissions" });
  }
});
```

- [ ] **Step 4: Verify admin route remains admin-only**

Run without admin cookie:

```powershell
curl.exe -i http://localhost:8080/api/admin/email-submissions
```

Expected: `403 Admin access required` or equivalent existing admin guard response.

---

### Task 4: Frontend Local State Helpers

**Files:**
- Create: `artifacts/yt-downloader/src/lib/email-submission.ts`

- [ ] **Step 1: Add storage helpers**

```ts
export type StoredEmailSubmission = {
  email: string;
  name?: string;
  submittedAt: number;
};

const SUBMITTED_KEY = "videomaking.email-submission.v1";
const PROMPT_DATE_KEY = "videomaking.email-submission.prompt-date.v1";

export function todayKey(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function loadStoredEmailSubmission(): StoredEmailSubmission | null {
  try {
    const raw = localStorage.getItem(SUBMITTED_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredEmailSubmission>;
    if (typeof parsed.email !== "string" || !parsed.email.includes("@")) return null;
    return {
      email: parsed.email,
      name: typeof parsed.name === "string" ? parsed.name : undefined,
      submittedAt: typeof parsed.submittedAt === "number" ? parsed.submittedAt : Date.now(),
    };
  } catch {
    return null;
  }
}

export function saveStoredEmailSubmission(input: { email: string; name?: string }): void {
  try {
    localStorage.setItem(SUBMITTED_KEY, JSON.stringify({
      email: input.email.trim().toLowerCase(),
      name: input.name?.trim() || undefined,
      submittedAt: Date.now(),
    }));
    window.dispatchEvent(new CustomEvent("videomaking:email-submission-changed"));
  } catch {}
}

export function shouldShowDailyEmailPrompt(): boolean {
  try {
    if (loadStoredEmailSubmission()) return false;
    return localStorage.getItem(PROMPT_DATE_KEY) !== todayKey();
  } catch {
    return !loadStoredEmailSubmission();
  }
}

export function markDailyEmailPromptShown(): void {
  try {
    localStorage.setItem(PROMPT_DATE_KEY, todayKey());
  } catch {}
}
```

---

### Task 5: Settings Email Submission Card

**Files:**
- Modify: `artifacts/yt-downloader/src/components/SettingsPanel.tsx`

- [ ] **Step 1: Add props**

Add props:

```ts
emailFocus?: boolean;
onEmailSubmitted?: (email: string) => void;
```

- [ ] **Step 2: Add state and submit handler**

```ts
const [emailValue, setEmailValue] = useState(authUser?.email ?? "");
const [nameValue, setNameValue] = useState(authUser?.name ?? "");
const [emailSaving, setEmailSaving] = useState(false);
const [emailMsg, setEmailMsg] = useState<{ text: string; error: boolean }>({ text: "", error: false });

const submitFutureAccessEmail = async (event: React.FormEvent) => {
  event.preventDefault();
  setEmailSaving(true);
  setEmailMsg({ text: "", error: false });
  try {
    const res = await fetch(`${import.meta.env.BASE_URL.replace(/\/$/, "")}/api/email-submissions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ email: emailValue, name: nameValue }),
    });
    const data = await res.json().catch(() => ({})) as { error?: string; submission?: { email?: string } };
    if (!res.ok) throw new Error(data.error || "Could not save email");
    const savedEmail = data.submission?.email || emailValue.trim().toLowerCase();
    onEmailSubmitted?.(savedEmail);
    setEmailMsg({ text: "Email saved for future access.", error: false });
  } catch (err) {
    setEmailMsg({ text: err instanceof Error ? err.message : "Could not save email", error: true });
  } finally {
    setEmailSaving(false);
  }
};
```

- [ ] **Step 3: Add the card near the profile card**

Content must say:

```text
Username/password login will stop working on May 25, 2026. Submit the personal email you want to use for future access. All through the grace of Mahaprabhu Ji and Maa Radha Rani.
```

The form fields:

```tsx
<form className={cn("settings-card settings-email-card", emailFocus && "settings-email-card--focus")} onSubmit={submitFutureAccessEmail}>
  <h2>Future access email</h2>
  <p>Username/password login will stop working on May 25, 2026. Submit the personal email you want to use for future access. All through the grace of Mahaprabhu Ji and Maa Radha Rani.</p>
  <input type="text" value={nameValue} onChange={(event) => setNameValue(event.target.value)} placeholder="Your name" />
  <input type="email" value={emailValue} onChange={(event) => setEmailValue(event.target.value)} placeholder="you@gmail.com" required />
  <button type="submit" disabled={emailSaving || !emailValue.trim()}>{emailSaving ? "Saving..." : "Submit email"}</button>
  {emailMsg.text ? <p className={emailMsg.error ? "settings-error" : "settings-success"}>{emailMsg.text}</p> : null}
</form>
```

Use existing `cn` import or add it from `@/lib/utils`.

---

### Task 6: Home Top Panel and Daily Bento Popup

**Files:**
- Modify: `artifacts/yt-downloader/src/pages/Home.tsx`

- [ ] **Step 1: Import helpers**

```ts
import {
  loadStoredEmailSubmission,
  markDailyEmailPromptShown,
  saveStoredEmailSubmission,
  shouldShowDailyEmailPrompt,
} from "@/lib/email-submission";
```

- [ ] **Step 2: Add state**

```ts
const [storedEmail, setStoredEmail] = useState(() => loadStoredEmailSubmission());
const [showEmailPrompt, setShowEmailPrompt] = useState(false);
const [settingsEmailFocus, setSettingsEmailFocus] = useState(false);
const needsFutureEmail = !storedEmail && !authUser?.email;
```

- [ ] **Step 3: Daily popup effect**

```ts
useEffect(() => {
  if (!needsFutureEmail) return;
  if (!shouldShowDailyEmailPrompt()) return;
  const timer = window.setTimeout(() => {
    setShowEmailPrompt(true);
    markDailyEmailPromptShown();
  }, 900);
  return () => window.clearTimeout(timer);
}, [needsFutureEmail]);
```

- [ ] **Step 4: CTA handler**

```ts
const openEmailSettings = () => {
  setShowEmailPrompt(false);
  setSettingsEmailFocus(true);
  switchMode("settings");
  window.setTimeout(() => {
    document.getElementById("future-access-email")?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, 80);
};

const handleEmailSubmitted = (email: string) => {
  saveStoredEmailSubmission({ email, name: authUser?.name });
  setStoredEmail(loadStoredEmailSubmission());
  setSettingsEmailFocus(false);
  setShowEmailPrompt(false);
};
```

- [ ] **Step 5: Render top notice inside main content before tab content**

Only show if `needsFutureEmail`:

```tsx
{needsFutureEmail ? (
  <div className="future-email-top-notice">
    <div>
      <strong>Future login email needed</strong>
      <span>Username/password login ends on May 25, 2026. Submit your personal email for future access.</span>
    </div>
    <button type="button" onClick={openEmailSettings}>Submit email</button>
  </div>
) : null}
```

- [ ] **Step 6: Render daily popup**

```tsx
<AnimatePresence>
  {showEmailPrompt && needsFutureEmail ? (
    <motion.div className="future-email-modal-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <motion.div className="future-email-modal" initial={{ opacity: 0, y: 24, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 12, scale: 0.98 }}>
        <p className="future-email-eyebrow">Important access notice</p>
        <h2>Submit your personal email</h2>
        <p>Username/password login will no longer work from May 25, 2026. Please submit the email address through which you want access to this website. All through the grace of Mahaprabhu Ji and Maa Radha Rani.</p>
        <div className="future-email-modal-actions">
          <button type="button" onClick={openEmailSettings}>Submit email</button>
          <button type="button" onClick={() => setShowEmailPrompt(false)}>Remind me later</button>
        </div>
      </motion.div>
    </motion.div>
  ) : null}
</AnimatePresence>
```

- [ ] **Step 7: Pass props**

```tsx
<Sidebar emailMissing={needsFutureEmail} ... />
<SettingsPanel emailFocus={settingsEmailFocus} onEmailSubmitted={handleEmailSubmitted} ... />
```

---

### Task 7: Sidebar Settings Badge

**Files:**
- Modify: `artifacts/yt-downloader/src/components/layout/Sidebar.tsx`

- [ ] **Step 1: Add prop**

```ts
emailMissing?: boolean;
```

- [ ] **Step 2: Apply badge to Settings item**

When building utility items, set `badge: emailMissing ? "!" : undefined` for the settings nav item. Do this in both desktop rail and mobile drawer utility lists.

```ts
const settingsItem = {
  mode: "settings" as const,
  icon: <Settings className="gs-icon" />,
  label: "Settings",
  badge: emailMissing ? "!" : undefined,
};
```

---

### Task 8: Admin User Messages Tab

**Files:**
- Modify: `artifacts/yt-downloader/src/components/AdminPanel.tsx`

- [ ] **Step 1: Extend `AdminOverview` type**

```ts
userMessages?: {
  emailSubmissionCount: number;
  emailSubmissions: Array<{
    email: string;
    name: string;
    loginMethod: "password" | "google" | "unknown";
    loginEmail: string;
    role: "admin" | "user";
    source: "settings-email-notice";
    userAgent: string;
    submittedAt: number;
    updatedAt: number;
  }>;
};
```

- [ ] **Step 2: Add tab key**

Add `messages` to tab state and nav:

```ts
type AdminTab = "overview" | "jobs" | "access" | "storage" | "tools" | "messages";
```

Tab label:

```ts
messages: "User Messages"
```

- [ ] **Step 3: Add section**

```tsx
<Section icon={<Users className="w-4 h-4" />} title="Submitted future-login emails" wide tab="messages">
  <div className="admin-window-grid">
    <div className="admin-window-card">
      <strong>Total</strong>
      <span>{overview?.userMessages?.emailSubmissionCount ?? 0} emails</span>
      <em>Collected from settings notice</em>
    </div>
  </div>
  <div className="admin-email-submission-table">
    {(overview?.userMessages?.emailSubmissions ?? []).length === 0 ? (
      <div className="admin-empty">No submitted emails yet</div>
    ) : (
      overview?.userMessages?.emailSubmissions.map((item) => (
        <div key={item.email} className="admin-email-submission-row">
          <div><strong>{item.email}</strong><span>{item.name || "No name"}</span></div>
          <div><strong>{item.loginMethod}</strong><span>{item.loginEmail || "password login"}</span></div>
          <div><strong>{new Date(item.submittedAt).toLocaleString()}</strong><span>{item.role}</span></div>
        </div>
      ))
    )}
  </div>
</Section>
```

- [ ] **Step 4: Update CSS tab visibility**

Add `.admin-grid--messages` selectors in `index.css` with the existing tab selector pattern.

---

### Task 9: Styling and Mobile/Light Mode Polish

**Files:**
- Modify: `artifacts/yt-downloader/src/index.css`

- [ ] **Step 1: Add dark mode styles**

Add classes:

```css
.future-email-top-notice {}
.future-email-modal-backdrop {}
.future-email-modal {}
.future-email-modal-actions {}
.settings-email-card {}
.settings-email-card--focus {}
.settings-email-card input {}
.settings-success {}
.settings-error {}
.admin-email-submission-table {}
.admin-email-submission-row {}
```

Use existing visual language: dark glass cards, teal/amber accents, rounded corners, mobile-safe padding.

- [ ] **Step 2: Add light mode overrides**

For every class above, add `html.studio-light-mode ...` overrides so text, borders, buttons, and modal backdrop remain readable in light mode.

- [ ] **Step 3: Mobile requirements**

For `max-width: 768px`:

```css
.future-email-top-notice {
  flex-direction: column;
  align-items: stretch;
}
.future-email-modal {
  width: min(94vw, 440px);
  margin: 16px;
}
.admin-email-submission-row {
  grid-template-columns: 1fr;
}
```

---

### Task 10: Verification

**Files:**
- Test/build only

- [ ] **Step 1: Run frontend build**

```powershell
npm --prefix artifacts/yt-downloader run build
```

Expected: build succeeds with no TypeScript errors.

- [ ] **Step 2: Run API build**

```powershell
npm --prefix artifacts/api-server run build
```

Expected: build succeeds with no TypeScript errors.

- [ ] **Step 3: Manual local API verification**

With an authenticated browser session:

```powershell
curl.exe -i -X POST http://localhost:8080/api/email-submissions -H "Content-Type: application/json" -d "{\"email\":\"future-access@example.com\",\"name\":\"Test User\"}"
```

Expected: `200` JSON with `ok: true` and normalized email.

- [ ] **Step 4: Manual UI verification**

Check these states:
- Password-login user with no local stored email sees top panel.
- Daily popup appears once per day, not repeatedly on reload after dismissal.
- Submit button opens Settings and glows the email card.
- Successful submit hides top panel and modal on that browser.
- Settings sidebar badge disappears after submit.
- Google user with `authUser.email` does not need the prompt unless product decides to collect alternate email later.
- Admin sees the new User Messages tab and the submitted email row.
- Light mode remains readable on Home, Settings, Admin, modal, and sidebar.
- Mobile viewport shows the notice/modal without clipping behind the hamburger or browser top bar.

- [ ] **Step 5: Live verification after deployment**

After deploy, submit a test email from production and verify DynamoDB:

```powershell
aws dynamodb scan --table-name ytgrabber-green-access --filter-expression "pk = :pk" --expression-attribute-values '{":pk":{"S":"email-submission"}}' --region us-east-1
```

Expected: submitted email item appears with `pk=email-submission` and `sk=<email>`.

---

## Risk Notes

- Password-login users are not individually identifiable server-side. The prompt can be hidden reliably per browser after submission, but not globally across every device unless the user signs in with Google.
- This plan intentionally does not auto-approve emails. Admin still controls Google login approval from the existing Access tab.
- Reusing `ACCESS_TABLE` is lower risk than creating a new DynamoDB table because deployed IAM already allows access-table reads/writes/scans.
- The popup is once per day per browser via localStorage. Clearing browser data will show it again, which is acceptable for an important migration notice.

## Self-Review

Spec coverage:
- Top panel for users without submitted email: Task 6.
- Settings notice panel and one-time email form: Task 5.
- Daily popup with May 25, 2026 message and devotional wording: Task 6.
- Button routes to Settings and highlights card: Task 6 and Task 5.
- Admin new tab with submitted user emails/name/details: Task 3 and Task 8.
- End-to-end persistence: Task 1 through Task 3.
- Mobile/light/dark polish: Task 9.
- Verification before deploy: Task 10.

No unresolved placeholders remain. The only product constraint called out is the password-login identity limitation, which is a real current architecture limitation and handled with browser-local state plus persistent DynamoDB submissions.
