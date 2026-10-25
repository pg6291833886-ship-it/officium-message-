export const ROLES = ["owner", "administrator", "manager", "member", "guest"] as const;
export type Role = (typeof ROLES)[number];

const STAFF = new Set<Role>(["owner", "administrator", "manager"]);
const RANK: Record<Role, number> = { guest: 0, member: 1, manager: 2, administrator: 3, owner: 4 };

/** Views that load workspace-wide operational tools. Members and guests never see these. */
export const STAFF_VIEWS = ["automations", "bots", "integrations", "analytics"] as const;
/** Views that change roles, invites, or the audit log. Managers do not get these. */
export const ADMIN_VIEWS = ["admin"] as const;

/** Unknown or missing roles are members, never staff. */
export function normalizeRole(role: string | null | undefined): Role {
  if (role === "owner" || role === "administrator" || role === "manager" || role === "member" || role === "guest") return role;
  return "member";
}

export function isStaff(role: string | null | undefined) {
  return STAFF.has(normalizeRole(role)) && (role === "owner" || role === "administrator" || role === "manager");
}

export function isAdmin(role: string | null | undefined) {
  return role === "owner" || role === "administrator";
}

export function navAllowed(view: string, role: string | null | undefined) {
  if ((ADMIN_VIEWS as readonly string[]).includes(view)) return isAdmin(role);
  if ((STAFF_VIEWS as readonly string[]).includes(view)) return isStaff(role);
  return view !== "" ;
}

export function initialRole(ownerCount: unknown): Role {
  const n = typeof ownerCount === "number" ? ownerCount : Number(ownerCount);
  // An unreadable count must not create another owner.
  if (!Number.isFinite(n) || n > 0) return "member";
  return "owner";
}

export function canChangeRole(input: {
  actorRole: string | null | undefined;
  targetRole: string | null | undefined;
  self: boolean;
  nextRole: string;
  ownerCount: unknown;
}): { ok: true } | { ok: false; error: string } {
  const actor = normalizeRole(input.actorRole);
  const target = normalizeRole(input.targetRole);
  const next = normalizeRole(input.nextRole);
  if (input.nextRole !== next) return { ok: false, error: "That role is not allowed." };
  if (actor !== "owner" && actor !== "administrator") return { ok: false, error: "Only an owner or administrator can change roles." };
  if (next === "owner" && actor !== "owner") return { ok: false, error: "Only an owner can grant ownership." };
  if (target === "owner" && actor !== "owner") return { ok: false, error: "Only an owner can change an owner's role." };
  const owners = Number(input.ownerCount);
  if (input.self && actor === "owner" && next !== "owner" && (!Number.isFinite(owners) || owners < 2)) {
    return { ok: false, error: "Keep at least one owner." };
  }
  return { ok: true };
}

export function canInvite(actorRole: string | null | undefined, nextRole: string): { ok: true } | { ok: false; error: string } {
  if (actorRole !== "owner" && actorRole !== "administrator") return { ok: false, error: "Only administrators can invite." };
  if (nextRole !== "administrator" && nextRole !== "manager" && nextRole !== "member" && nextRole !== "guest") {
    return { ok: false, error: "That role is not allowed." };
  }
  return { ok: true };
}

/** An invite may raise access. It cannot grant ownership or demote someone. */
export function canRedeemInvite(current: string | null | undefined, inviteRole: string): { ok: true; role: Role } | { ok: false; error: string } {
  if (inviteRole !== "administrator" && inviteRole !== "manager" && inviteRole !== "member" && inviteRole !== "guest") {
    return { ok: false, error: "That invite cannot be used." };
  }
  const cur = normalizeRole(current);
  if (cur === "owner") return { ok: false, error: "The owner role is not changed by an invite." };
  if (RANK[inviteRole] <= RANK[cur]) return { ok: false, error: "That invite does not increase your access." };
  return { ok: true, role: inviteRole };
}

/**
 * Public channels are visible to workspace members.
 * Guests and missing roles only see channels they were explicitly added to.
 * A private channel always requires membership.
 */
export function canSeeChannel(input: {
  visibility: string;
  member: boolean;
  role: string | null | undefined;
}): boolean {
  if (input.member) return true;
  if (input.role !== "owner" && input.role !== "administrator" && input.role !== "manager" && input.role !== "member") return false;
  return input.visibility === "public";
}

export function canSeeConversation(member: boolean) {
  return member === true;
}

export function staffOnly(role: string | null | undefined, error: string) {
  if (!isStaff(role)) return { ok: false as const, error };
  return null;
}
