import { WebSocketServer, WebSocket } from "ws";

const DEFAULT_PORT = 6505;
const HEARTBEAT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;
const REBIND_RETRY_MS = 2_000;

interface PendingRequest {
  socket: WebSocket;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class GodotBridge {
  private wss: WebSocketServer | null = null;
  /**
   * Every live editor connection, oldest first; the newest OPEN socket serves
   * requests. Tracking the whole set rather than a single `client` is what
   * makes a second, short-lived editor survivable: a `godot --headless
   * --editor` pass or a second project window used to overwrite the reference
   * and then null it on its own exit, orphaning the real editor — whose socket
   * was still open, so it never reconnected and only an editor restart fixed it.
   */
  private clients: WebSocket[] = [];
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private rebindTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  /** Why this server was told never to claim the port, or null if it may. */
  private idleReason: string | null = null;
  readonly port: number;

  constructor(port = Number(process.env.GODOT_MCP_PORT ?? DEFAULT_PORT)) {
    this.port = port;
  }

  start(): void {
    if (this.wss || this.stopped) return;

    this.listen();

    this.heartbeatTimer = setInterval(() => {
      const ping = JSON.stringify({ jsonrpc: "2.0", method: "ping", params: {} });
      for (const ws of this.clients) {
        if (ws.readyState === WebSocket.OPEN) ws.send(ping);
      }
    }, HEARTBEAT_MS);
  }

  /**
   * Records why this server was deliberately never started, so every tool call
   * says so instead of blaming another process for the port. Only one server
   * can own the port, and the one that owns it is the one the editor talks to,
   * so a server whose session has no use for Godot must never take it from one
   * that does.
   */
  stayIdle(reason: string): void {
    this.idleReason = reason;
  }

  get connected(): boolean {
    return this.activeClient() !== null;
  }

  /**
   * How many editor sockets the bridge is tracking. Counts registrations, not
   * ready states, so it moves exactly when a connection is added or reaped —
   * a socket the peer has closed drops out of `connected` immediately but is
   * still counted here until the close handler runs.
   */
  get clientCount(): number {
    return this.clients.length;
  }

  /** True once the port is actually bound — not merely once `start()` was called. */
  get listening(): boolean {
    return this.wss !== null;
  }

  async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const socket = this.activeClient();
    if (!socket && this.idleReason) {
      throw new Error(`Godot tools are off in this session: ${this.idleReason}.`);
    }
    if (!socket) {
      throw new Error(
        this.wss
          ? "Godot editor not connected. Open your project in Godot and enable the Godot MCP plugin."
          : `Godot editor not connected: port ${this.port} is held by another process, ` +
            `so this server never bound it. Close the other godot-mcp server (or Claude Code session) ` +
            `and this one will take the port over within ${REBIND_RETRY_MS / 1000}s.`
      );
    }

    const id = this.nextId++;
    const message = JSON.stringify({ jsonrpc: "2.0", id, method, params });

    return new Promise((resolve, reject) => {
      // Register before sending: a reply that arrives first must find its entry.
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { socket, resolve, reject, timer });
      socket.send(message);
    });
  }

  close(): void {
    this.stopped = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.rebindTimer) {
      clearTimeout(this.rebindTimer);
      this.rebindTimer = null;
    }
    this.rejectAll(new Error("Server shutting down"));
    for (const ws of this.clients) ws.close();
    this.clients = [];
    this.wss?.close();
    this.wss = null;
  }

  /** The newest still-open editor, or null. */
  private activeClient(): WebSocket | null {
    for (let i = this.clients.length - 1; i >= 0; i--) {
      if (this.clients[i].readyState === WebSocket.OPEN) return this.clients[i];
    }
    return null;
  }

  private listen(): void {
    const wss = new WebSocketServer({ port: this.port, host: "127.0.0.1" });

    wss.on("listening", () => {
      this.wss = wss;
      console.error(`[godot-mcp] WebSocket server listening on ws://127.0.0.1:${this.port}`);
    });

    // Without this handler an EADDRINUSE — a second Claude Code session, or a
    // leaked server from a previous one — is an unhandled 'error' event, which
    // kills the whole MCP process at startup and takes every godot tool with it.
    // Retry instead, so this server claims the port the moment the holder exits.
    wss.on("error", (err: NodeJS.ErrnoException) => {
      this.wss = null;
      wss.close();
      if (this.stopped) return;
      if (err.code === "EADDRINUSE") {
        console.error(
          `[godot-mcp] Port ${this.port} already in use by another godot-mcp server; ` +
            `retrying every ${REBIND_RETRY_MS}ms until it frees up`
        );
      } else {
        console.error(`[godot-mcp] WebSocket server error (${err.message}); retrying`);
      }
      if (!this.rebindTimer) {
        this.rebindTimer = setTimeout(() => {
          this.rebindTimer = null;
          if (!this.stopped) this.listen();
        }, REBIND_RETRY_MS);
        this.rebindTimer.unref?.();
      }
    });

    wss.on("connection", (ws) => {
      this.clients.push(ws);
      console.error(
        `[godot-mcp] Godot editor connected on port ${this.port} (${this.clientCount} attached)`
      );

      ws.on("message", (data) => this.onMessage(data.toString()));
      ws.on("close", () => {
        this.clients = this.clients.filter((c) => c !== ws);
        // Only this socket's in-flight requests are lost; another editor may
        // still be attached and able to serve the next call.
        this.rejectFor(ws, new Error("Godot editor disconnected"));
        console.error(`[godot-mcp] Godot editor disconnected (${this.clientCount} still attached)`);
      });
      ws.on("error", () => ws.close());
    });
  }

  private onMessage(text: string): void {
    let msg: {
      id?: number;
      method?: string;
      result?: unknown;
      error?: { message?: string; code?: number; data?: unknown };
    };

    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }

    if (msg.method === "pong") return;

    if (msg.id !== undefined) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error) {
        pending.reject(new Error(msg.error.message ?? "Unknown Godot error"));
      } else {
        pending.resolve(msg.result ?? {});
      }
    }
  }

  private rejectFor(socket: WebSocket, error: Error): void {
    for (const [id, pending] of this.pending) {
      if (pending.socket !== socket) continue;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(error);
    }
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(error);
    }
  }
}
