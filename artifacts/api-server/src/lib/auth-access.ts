export type AuthRole = "admin" | "user";

const approvedUsers = parseCsvSet(process.env.APPROVED_USER_EMAILS);
const approvedAdmins = parseCsvSet(process.env.APPROVED_ADMIN_EMAILS);

export function parseCsvSet(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function listApprovedAccess() {
  return {
    users: [...approvedUsers].sort(),
    admins: [...approvedAdmins].sort(),
  };
}

export function isEmailApproved(email: string): { approved: boolean; role: AuthRole } {
  const normalized = normalizeEmail(email);
  if (approvedAdmins.has(normalized)) return { approved: true, role: "admin" };
  if (approvedUsers.has(normalized)) return { approved: true, role: "user" };
  return { approved: false, role: "user" };
}

export function setApprovedEmail(email: string, role: AuthRole) {
  const normalized = normalizeEmail(email);
  if (!normalized) {
    throw new Error("Email is required");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new Error("Invalid email address");
  }

  if (role === "admin") {
    approvedUsers.delete(normalized);
    approvedAdmins.add(normalized);
  } else {
    approvedAdmins.delete(normalized);
    approvedUsers.add(normalized);
  }

  return { email: normalized, role };
}

export function removeApprovedEmail(email: string) {
  const normalized = normalizeEmail(email);
  const removed = approvedUsers.delete(normalized) || approvedAdmins.delete(normalized);
  return { email: normalized, removed };
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
