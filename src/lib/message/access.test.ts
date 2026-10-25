import assert from "node:assert/strict";
import test from "node:test";
import { canChangeRole, canInvite, canRedeemInvite, canSeeChannel, canSeeConversation, initialRole, isAdmin, isStaff, navAllowed, normalizeRole, staffOnly } from "./access.ts";

test("missing or invalid roles are not staff", () => {
  assert.equal(isStaff(undefined), false);
  assert.equal(isStaff(null), false);
  assert.equal(isStaff(""), false);
  assert.equal(isStaff("admin"), false);
  assert.equal(isStaff("Administrator"), false);
  assert.equal(isAdmin(undefined), false);
  assert.equal(isAdmin("manager"), false);
  assert.equal(isAdmin("admin"), false);
  assert.equal(normalizeRole("nope"), "member");
  assert.equal(staffOnly("member", "no")?.ok, false);
  assert.equal(staffOnly(undefined, "no")?.ok, false);
});

test("only the first account is owner", () => {
  assert.equal(initialRole(0), "owner");
  assert.equal(initialRole("0"), "owner");
  assert.equal(initialRole(1), "member");
  assert.equal(initialRole("2"), "member");
  assert.equal(initialRole(undefined), "member");
  assert.equal(initialRole("nope"), "member");
});

test("a member cannot change roles or open admin tools", () => {
  const self = canChangeRole({ actorRole: "member", targetRole: "member", self: true, nextRole: "administrator", ownerCount: 1 });
  assert.equal(self.ok, false);
  const other = canChangeRole({ actorRole: "member", targetRole: "guest", self: false, nextRole: "manager", ownerCount: 1 });
  assert.equal(other.ok, false);
  const guest = canChangeRole({ actorRole: "guest", targetRole: "member", self: false, nextRole: "member", ownerCount: 1 });
  assert.equal(guest.ok, false);
  const missing = canChangeRole({ actorRole: undefined, targetRole: "member", self: false, nextRole: "member", ownerCount: 1 });
  assert.equal(missing.ok, false);
  assert.equal(canInvite("member", "administrator").ok, false);
  assert.equal(canInvite(undefined, "member").ok, false);
  assert.equal(navAllowed("admin", "member"), false);
  assert.equal(navAllowed("analytics", "member"), false);
  assert.equal(navAllowed("automations", "guest"), false);
  assert.equal(navAllowed("bots", null), false);
  assert.equal(navAllowed("files", "member"), true);
  assert.equal(navAllowed("settings", "member"), true);
  assert.equal(navAllowed("admin", "manager"), false);
  assert.equal(navAllowed("analytics", "manager"), true);
});

test("an administrator cannot grant or change ownership", () => {
  const grant = canChangeRole({ actorRole: "administrator", targetRole: "member", self: false, nextRole: "owner", ownerCount: 1 });
  assert.equal(grant.ok, false);
  const demote = canChangeRole({ actorRole: "administrator", targetRole: "owner", self: false, nextRole: "member", ownerCount: 1 });
  assert.equal(demote.ok, false);
  const promote = canChangeRole({ actorRole: "administrator", targetRole: "member", self: false, nextRole: "manager", ownerCount: 1 });
  assert.equal(promote.ok, true);
  assert.equal(canInvite("administrator", "member").ok, true);
  assert.equal(canInvite("administrator", "owner").ok, false);
  assert.equal(navAllowed("admin", "administrator"), true);
});

test("the owner keeps control and cannot remove the last owner", () => {
  const last = canChangeRole({ actorRole: "owner", targetRole: "owner", self: true, nextRole: "member", ownerCount: 1 });
  assert.equal(last.ok, false);
  const other = canChangeRole({ actorRole: "owner", targetRole: "member", self: false, nextRole: "administrator", ownerCount: 1 });
  assert.equal(other.ok, true);
  const secondOwner = canChangeRole({ actorRole: "owner", targetRole: "owner", self: true, nextRole: "member", ownerCount: 2 });
  assert.equal(secondOwner.ok, true);
  assert.equal(isStaff("owner"), true);
  assert.equal(isStaff("manager"), true);
  assert.equal(isAdmin("owner"), true);
});

test("invites cannot demote or grant ownership", () => {
  assert.equal(canRedeemInvite("member", "owner").ok, false);
  assert.equal(canRedeemInvite("administrator", "member").ok, false);
  assert.equal(canRedeemInvite("owner", "administrator").ok, false);
  assert.equal(canRedeemInvite("member", "manager").ok, true);
  assert.equal(canRedeemInvite(undefined, "member").ok, false);
});

test("private messages and files stay with their members", () => {
  assert.equal(canSeeConversation(false), false);
  assert.equal(canSeeConversation(true), true);
  assert.equal(canSeeChannel({ visibility: "private", member: false, role: "member" }), false);
  assert.equal(canSeeChannel({ visibility: "private", member: false, role: "owner" }), false);
  assert.equal(canSeeChannel({ visibility: "private", member: true, role: "guest" }), true);
  assert.equal(canSeeChannel({ visibility: "public", member: false, role: "guest" }), false);
  assert.equal(canSeeChannel({ visibility: "public", member: false, role: undefined }), false);
  assert.equal(canSeeChannel({ visibility: "public", member: false, role: "member" }), true);
  assert.equal(canSeeChannel({ visibility: "public", member: false, role: "nope" }), false);
});
