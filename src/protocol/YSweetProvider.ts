/**
 * YSweetProvider — WebSocket provider for Yjs, adapted from the Relay.md Obsidian plugin.
 *
 * Changes from the browser version:
 * - Removed BroadcastChannel support
 * - Removed window.addEventListener / removeEventListener
 * - Uses Bun's native WebSocket (standard API)
 * - Removed WebSocketPolyfill option
 */

import * as Y from "yjs";
import * as time from "lib0/time";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import { Observable } from "lib0/observable";
import * as math from "lib0/math";
import * as url from "lib0/url";
import {
  messageSync,
  messageAwareness,
  readMessage,
  createMessageHandlers,
  type MessageHandler,
} from "./messages";
import { logger } from "../util/logger";

/** Timeout for considering a connection dead (no messages received). */
const MESSAGE_RECONNECT_TIMEOUT = 30000;

/**
 * Send a message to the WebSocket connection.
 */
function broadcastMessage(provider: YSweetProvider, buf: ArrayBuffer | Uint8Array): void {
  const ws = provider.ws;
  if (provider.wsconnected && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(buf);
  }
}

/**
 * Set up the WebSocket connection for the provider.
 */
function setupWS(provider: YSweetProvider): void {
  if (provider.shouldConnect && provider.ws === null) {
    const websocket = new WebSocket(provider.url);
    websocket.binaryType = "arraybuffer";
    provider.ws = websocket;
    provider.wsconnecting = true;
    provider.wsconnected = false;
    provider.synced = false;

    websocket.onmessage = (event: MessageEvent) => {
      provider.wsLastMessageReceived = time.getUnixTime();
      const encoder = readMessage(
        provider,
        new Uint8Array(event.data as ArrayBuffer),
        true,
      );
      if (encoding.length(encoder) > 1) {
        websocket.send(encoding.toUint8Array(encoder));
      }
    };

    websocket.onerror = (event: Event) => {
      provider.emit("connection-error", [event, provider]);
    };

    websocket.onclose = (event: CloseEvent) => {
      provider.emit("connection-close", [event, provider]);
      provider.ws = null;
      provider.wsconnecting = false;
      if (provider.wsconnected) {
        provider.wsconnected = false;
        provider.synced = false;
        // Update awareness (all users except local left)
        awarenessProtocol.removeAwarenessStates(
          provider.awareness,
          Array.from(provider.awareness.getStates().keys()).filter(
            (client) => client !== provider.doc.clientID,
          ),
          provider,
        );
        provider.emit("status", [
          { status: "disconnected", intent: provider.intent },
        ]);
      } else {
        provider.wsUnsuccessfulReconnects++;
      }

      // Exponential backoff reconnection
      if (provider.canReconnect()) {
        setTimeout(
          setupWS,
          math.min(
            math.pow(2, provider.wsUnsuccessfulReconnects) * 100,
            provider.maxBackoffTime,
          ),
          provider,
        );
      }
    };

    websocket.onopen = () => {
      provider.wsLastMessageReceived = time.getUnixTime();
      provider.wsconnecting = false;
      provider.wsconnected = true;
      provider.wsUnsuccessfulReconnects = 0;
      provider.emit("status", [
        { status: "connected", intent: provider.intent },
      ]);

      // Always send sync step 1 when connected
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageSync);
      syncProtocol.writeSyncStep1(encoder, provider.doc);
      websocket.send(encoding.toUint8Array(encoder));

      // Broadcast local awareness state
      if (provider.awareness.getLocalState() !== null) {
        const encoderAwareness = encoding.createEncoder();
        encoding.writeVarUint(encoderAwareness, messageAwareness);
        encoding.writeVarUint8Array(
          encoderAwareness,
          awarenessProtocol.encodeAwarenessUpdate(provider.awareness, [
            provider.doc.clientID,
          ]),
        );
        websocket.send(encoding.toUint8Array(encoderAwareness));
      }
    };

    provider.emit("status", [
      { status: "connecting", intent: provider.intent },
    ]);
  }
}

export type ConnectionStatus =
  | "connected"
  | "connecting"
  | "disconnected"
  | "unknown";
export type ConnectionIntent = "connected" | "disconnected";

export interface ConnectionState {
  status: ConnectionStatus;
  intent: ConnectionIntent;
}

export interface YSweetProviderParams {
  connect?: boolean;
  awareness?: awarenessProtocol.Awareness;
  params?: Record<string, string>;
  resyncInterval?: number;
  maxBackoffTime?: number;
  maxConnectionErrors?: number;
}

// Shared static cleanup infrastructure to avoid per-instance process.on("exit") listeners
const exitHandlers = new Set<() => void>();
let exitHandlerRegistered = false;

function registerExitHandler(): void {
  if (!exitHandlerRegistered) {
    exitHandlerRegistered = true;
    process.on("exit", () => {
      for (const handler of exitHandlers) {
        handler();
      }
    });
  }
}

/**
 * WebSocket Provider for Yjs. Creates a websocket connection to sync a shared document.
 */
export class YSweetProvider extends Observable<string> {
  maxBackoffTime: number;
  url: string;
  roomname: string;
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  wsconnected: boolean;
  wsconnecting: boolean;
  wsUnsuccessfulReconnects: number;
  messageHandlers: MessageHandler[];
  _synced: boolean;
  ws: WebSocket | null;
  wsLastMessageReceived: number;
  shouldConnect: boolean;
  maxConnectionErrors: number;

  private _resyncInterval: ReturnType<typeof setInterval> | number;
  private _updateHandler: (
    update: Uint8Array,
    origin: unknown,
    doc: Y.Doc,
    tr: Y.Transaction,
  ) => void;
  private _awarenessUpdateHandler: (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => void;
  private _exitHandler: () => void;
  private _checkInterval: ReturnType<typeof setInterval>;

  constructor(
    serverUrl: string,
    roomname: string,
    doc: Y.Doc,
    {
      connect = true,
      awareness = new awarenessProtocol.Awareness(doc),
      params = {},
      resyncInterval = -1,
      maxBackoffTime = 2500,
      maxConnectionErrors = 3,
    }: YSweetProviderParams = {},
  ) {
    super();

    // Ensure URL doesn't end with /
    while (serverUrl[serverUrl.length - 1] === "/") {
      serverUrl = serverUrl.slice(0, serverUrl.length - 1);
    }

    const encodedParams = url.encodeQueryParams(params);
    this.maxBackoffTime = maxBackoffTime;
    this.url =
      serverUrl +
      "/" +
      roomname +
      (encodedParams.length === 0 ? "" : "?" + encodedParams);
    this.roomname = roomname;
    this.doc = doc;
    this.awareness = awareness;
    this.wsconnected = false;
    this.wsconnecting = false;
    this.wsUnsuccessfulReconnects = 0;
    this.messageHandlers = createMessageHandlers();
    this._synced = false;
    this.ws = null;
    this.wsLastMessageReceived = 0;
    this.shouldConnect = connect;
    this.maxConnectionErrors = maxConnectionErrors;

    // Optional resync interval
    this._resyncInterval = 0;
    if (resyncInterval > 0) {
      this._resyncInterval = setInterval(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          const encoder = encoding.createEncoder();
          encoding.writeVarUint(encoder, messageSync);
          syncProtocol.writeSyncStep1(encoder, doc);
          this.ws.send(encoding.toUint8Array(encoder));
        }
      }, resyncInterval);
    }

    // Listen to Y.Doc updates and send to remote peers
    this._updateHandler = (update: Uint8Array, origin: unknown) => {
      if (origin !== this) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, messageSync);
        syncProtocol.writeUpdate(encoder, update);
        broadcastMessage(this, encoding.toUint8Array(encoder));
      }
    };
    this.doc.on("update", this._updateHandler as any);

    // Listen to awareness updates and broadcast
    this._awarenessUpdateHandler = (
      {
        added,
        updated,
        removed,
      }: { added: number[]; updated: number[]; removed: number[] },
      _origin: unknown,
    ) => {
      const changedClients = added.concat(updated).concat(removed);
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageAwareness);
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(awareness, changedClients),
      );
      broadcastMessage(this, encoding.toUint8Array(encoder));
    };

    // Clean up awareness on process exit (shared handler to avoid MaxListenersExceeded)
    this._exitHandler = () => {
      awarenessProtocol.removeAwarenessStates(
        this.awareness,
        [doc.clientID],
        "process exit",
      );
    };
    registerExitHandler();
    exitHandlers.add(this._exitHandler);

    awareness.on("update", this._awarenessUpdateHandler);

    // Periodic check for dead connections
    this._checkInterval = setInterval(() => {
      if (
        this.wsconnected &&
        MESSAGE_RECONNECT_TIMEOUT <
          time.getUnixTime() - this.wsLastMessageReceived
      ) {
        // No message received in a long time
        this.ws?.close();
      }
    }, MESSAGE_RECONNECT_TIMEOUT / 10);

    if (connect) {
      this.connect();
    }
  }

  get synced(): boolean {
    return this._synced;
  }

  set synced(state: boolean) {
    if (this._synced !== state) {
      this._synced = state;
      this.emit("synced", [state]);
      this.emit("sync", [state]);
    }
  }

  /**
   * Override once to handle race condition where synced event already fired.
   */
  once(name: string, f: (...args: any[]) => void): this {
    if (name === "synced" && this._synced) {
      setTimeout(() => f(this._synced), 0);
      return this;
    }
    super.once(name, f);
    return this;
  }

  get intent(): ConnectionIntent {
    return this.shouldConnect ? "connected" : "disconnected";
  }

  get connectionState(): ConnectionState {
    let status: ConnectionStatus;
    if (this.ws?.readyState === WebSocket.OPEN) {
      status = "connected";
    } else if (this.ws?.readyState === WebSocket.CONNECTING) {
      status = "connecting";
    } else {
      status = "disconnected";
    }
    return { status, intent: this.intent };
  }

  canReconnect(): boolean {
    return (
      !!this.url &&
      this.shouldConnect &&
      this.wsUnsuccessfulReconnects < this.maxConnectionErrors
    );
  }

  connect(): void {
    this.shouldConnect = true;
    if (!this.wsconnected && this.ws === null) {
      setupWS(this);
    }
  }

  disconnect(): void {
    this.shouldConnect = false;
    if (this.ws !== null) {
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * Refresh the connection token and update URL if needed.
   * @returns whether the URL actually changed and the new URL.
   */
  refreshToken(
    serverUrl: string,
    roomname: string,
    token: string,
  ): { urlChanged: boolean; newUrl: string } {
    // Ensure URL doesn't end with /
    while (serverUrl[serverUrl.length - 1] === "/") {
      serverUrl = serverUrl.slice(0, serverUrl.length - 1);
    }
    const params = { token };
    const encodedParams = url.encodeQueryParams(params);
    const newUrl =
      serverUrl +
      "/" +
      roomname +
      (encodedParams.length === 0 ? "" : "?" + encodedParams);

    const urlChanged = this.url !== newUrl;

    if (urlChanged) {
      this.url = newUrl;
      this.wsUnsuccessfulReconnects = 0;

      // Close existing connection so it reconnects with new URL
      if (this.ws) {
        this.ws.close();
      }
    }

    return { urlChanged, newUrl };
  }

  destroy(): void {
    if (this._resyncInterval !== 0) {
      clearInterval(this._resyncInterval);
    }
    clearInterval(this._checkInterval);

    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      if (
        this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING
      ) {
        this.ws.close(1000, "Destroyed");
      }
      this.ws = null;
    }

    this.disconnect();
    this.awareness.off("update", this._awarenessUpdateHandler);
    this.awareness.destroy();
    this._observers.clear();

    exitHandlers.delete(this._exitHandler);
    this.doc.off("update", this._updateHandler);
    super.destroy();
  }
}
