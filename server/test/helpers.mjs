// Helpers shared by the process-level tests. Not a test file itself:
// `npm test` only runs test/*.test.mjs.
import { createServer, connect } from "node:net";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A free ephemeral port from the OS rather than a count up from a fixed base:
 * the real 6505 stays untouched, and a listener leaked by an earlier run cannot
 * fail a later one for a reason unrelated to the behaviour under test.
 */
export async function takePort() {
  const probe = createServer();
  await new Promise((res) => probe.listen(0, "127.0.0.1", res));
  const { port } = probe.address();
  await new Promise((res) => probe.close(res));
  return port;
}

/** Whether anything accepts a TCP connection on the port right now. */
export function portTaken(port) {
  return new Promise((resolve) => {
    const socket = connect({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

/** Polls an async predicate until it holds or the time runs out. */
export async function waitForAsync(predicate, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(50);
  }
  return false;
}
