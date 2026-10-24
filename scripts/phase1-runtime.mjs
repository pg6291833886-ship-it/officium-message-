import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const base = process.env.PHASE1_BASE ?? "http://127.0.0.1:8080";
const stamp = process.env.PHASE1_STAMP ?? String(Date.now());
const owner = {
  name: "Aman Owner",
  email: `owner.${stamp}@officium.test`,
  password: "correct-horse",
};
const member = {
  name: "Riya Member",
  email: `member.${stamp}@officium.test`,
  password: "correct-horse",
};
const channel = `room-${stamp.slice(-6)}`;
const secret = `secret-phrase-${stamp}`;
const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function register(page, user) {
  await page.goto(`${base}/login`, { waitUntil: "networkidle" });
  const toggle = page.getByRole("button", { name: "Need an account? Register" });
  await toggle.waitFor({ timeout: 20000 });
  await page.waitForTimeout(700);
  await toggle.click();
  await page.getByRole("button", { name: "Create account" }).waitFor({ timeout: 10000 });
  await page.getByPlaceholder("Your name").fill(user.name);
  await page.getByPlaceholder("Work email").fill(user.email);
  await page.getByPlaceholder("Password (8+ characters)").fill(user.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByText(user.name).first().waitFor({ timeout: 25000 });
}

function roleOf(text) {
  const part = text.split("·").pop()?.trim() ?? "";
  return part;
}

async function signIn(page, user) {
  await page.goto(`${base}/login`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Sign in with email" }).waitFor({ timeout: 20000 });
  await page.waitForTimeout(700);
  await page.getByPlaceholder("Work email").fill(user.email);
  await page.getByPlaceholder("Password (8+ characters)").fill(user.password);
  await page.getByRole("button", { name: "Sign in with email" }).click();
  try {
    await page.getByText(user.name).first().waitFor({ timeout: 20000 });
  } catch (err) {
    const text = await page.locator("body").innerText().catch(() => "");
    throw new Error(`${err instanceof Error ? err.message : err}\nPAGE:\n${text.slice(0, 500)}`);
  }
}

const browser = await chromium.launch({ headless: true });
const ownerContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const ownerPage = await ownerContext.newPage();
const errors = [];
ownerPage.on("pageerror", (err) => errors.push(String(err)));

try {
  await register(ownerPage, owner);
  record("register owner", true, owner.email);
  const roleText = await ownerPage.locator("p", { hasText: "Aman Owner" }).first().innerText();
  record("signed-in role is shown", /member|owner|guest|manager|administrator/.test(roleOf(roleText)), roleText);

  await ownerPage.waitForTimeout(500);
  await ownerPage.goto(`${base}/`, { waitUntil: "domcontentloaded" });
  await ownerPage.getByText("Aman Owner").first().waitFor({ timeout: 20000 });
  record("session survives reload", true, "still signed in");

  await ownerPage.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find((node) => node.textContent?.trim() === "Sign out");
    button?.click();
  });
  await ownerPage.waitForURL(/\/login/, { timeout: 20000 });
  const session = await ownerPage.evaluate(async (url) => {
    const res = await fetch(`${url}/api/auth/get-session`, { credentials: "include" });
    return { status: res.status, body: await res.text() };
  }, base);
  const signedOut = session.body === "null" || /"user":null/.test(session.body) || session.body.trim() === "";
  record("logout clears session", signedOut, session.body.slice(0, 180));

  await signIn(ownerPage, owner);
  record("login after logout", true);

  await ownerPage.getByRole("button", { name: "Channels", exact: true }).click();
  await ownerPage.getByRole("button", { name: "New channel" }).click();
  const channelForm = ownerPage.locator("form").filter({ has: ownerPage.getByPlaceholder("channel-name") });
  await channelForm.getByPlaceholder("channel-name").fill(channel);
  await channelForm.locator("select").selectOption("private");
  await channelForm.getByRole("button", { name: "Create channel" }).click();
  await ownerPage.getByRole("heading", { name: channel }).waitFor({ timeout: 15000 });
  await ownerPage.getByPlaceholder("Message, or /help").fill(secret);
  await ownerPage.keyboard.press("Enter");
  await ownerPage.getByText(secret).waitFor({ timeout: 15000 });
  record("owner posts in private channel", true, channel);

  const memberContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const memberPage = await memberContext.newPage();
  memberPage.on("pageerror", (err) => errors.push(`member: ${err}`));
  await register(memberPage, member);
  const memberRole = await memberPage.locator("p", { hasText: "Riya Member" }).first().innerText();
  record("second account is not a second owner", roleOf(memberRole) === "member", memberRole);
  await memberPage.getByRole("button", { name: "Team", exact: true }).click();
  const team = await memberPage.locator("body").innerText();
  record("exactly the earliest account is owner", (team.match(/· owner/g) ?? []).length === 1, team.split("\n").filter((line) => line.includes("·")).slice(0, 6).join(" | "));
  await memberPage.getByRole("button", { name: "Channels", exact: true }).click();
  const leaked = await memberPage.getByText(secret).count();
  const seesChannel = await memberPage.getByText(channel, { exact: true }).count();
  record("private channel hidden from non-member", leaked === 0 && seesChannel === 0, `secret=${leaked} channel=${seesChannel}`);

  await memberPage.getByRole("button", { name: "Inbox", exact: true }).click();
  await memberPage.getByPlaceholder("Search messages and people").fill(secret.slice(0, 18));
  const noSearchHit = await memberPage.getByText("No matches in threads you can access.").waitFor({ timeout: 10000 }).then(() => true).catch(() => false);
  const searchLeak = await memberPage.getByText(secret).count();
  record("private message absent from search", noSearchHit && searchLeak === 0, `matches=${searchLeak}`);

  await memberPage.getByRole("button", { name: "Admin", exact: true }).click();
  const adminBlock = await memberPage.getByText("Administration is limited").isVisible();
  record("member cannot administer", adminBlock);

  await ownerPage.goto(`${base}/`, { waitUntil: "networkidle" });
  await ownerPage.getByText("Aman Owner").first().waitFor({ timeout: 20000 });
  await ownerPage.getByRole("button", { name: "Admin", exact: true }).click();
  await ownerPage.getByRole("heading", { name: "Invite" }).waitFor({ timeout: 15000 });
  const memberCard = ownerPage.locator(".card", { hasText: "Riya Member" });
  await memberCard.locator("select").selectOption("guest");
  await ownerPage.waitForTimeout(1000);
  await memberPage.goto(`${base}/`, { waitUntil: "domcontentloaded" });
  await memberPage.getByText(/guest/i).first().waitFor({ timeout: 15000 });
  const guestRole = await memberPage.locator("p", { hasText: "Riya Member" }).first().innerText();
  record("owner can set guest role", /guest/i.test(guestRole), guestRole);

  await memberPage.getByRole("button", { name: "Channels", exact: true }).click();
  await memberPage.getByRole("button", { name: "New channel" }).click();
  await memberPage.getByPlaceholder("channel-name").fill("guest-try");
  await memberPage.getByRole("button", { name: "Create channel" }).click();
  const guestErr = await memberPage.getByText("Guests cannot create channels.").waitFor({ timeout: 10000 }).then(() => true).catch(() => false);
  record("guest cannot create a channel", guestErr);

  await ownerContext.storageState({ path: "/tmp/phase1-owner-state.json" });
  writeFileSync("/tmp/phase1-owner.json", JSON.stringify({ owner, member, channel, secret, base }, null, 2));
  record("saved session for restart check", true);
} catch (err) {
  record("runtime flow", false, err instanceof Error ? err.stack ?? err.message : String(err));
} finally {
  if (errors.length) console.log("PAGE ERRORS\n" + errors.join("\n"));
  console.log(JSON.stringify({ pass: results.filter((r) => r.ok).length, fail: results.filter((r) => !r.ok).length, results }, null, 2));
  await browser.close();
  if (results.some((r) => !r.ok)) process.exit(1);
}
