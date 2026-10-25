import { createServerFn } from "@tanstack/react-start";

/** True only when this deployment has its own broker client. The shared preview
 * client is rejected for any callback outside `*.grok-sandbox.com`. */
export const federatedSignInEnabled = createServerFn({ method: "GET" }).handler(async () => {
  const id = process.env.GROK_AUTH_CLIENT_ID?.trim();
  const secret = process.env.GROK_AUTH_CLIENT_SECRET?.trim();
  return Boolean(id && secret);
});
