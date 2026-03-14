/**
 * Message type constants and handler registration for the Y-Sweet protocol.
 */

import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";
import * as authProtocol from "y-protocols/auth";
import * as awarenessProtocol from "y-protocols/awareness";
import type { YSweetProvider } from "./YSweetProvider";
import { logger } from "../util/logger";
import { captureMessage } from "../reporting";

/** Message type constants */
export const messageSync = 0;
export const messageAwareness = 1;
export const messageAuth = 2;
export const messageQueryAwareness = 3;

/**
 * Handler function signature for processing incoming messages.
 */
export type MessageHandler = (
  encoder: encoding.Encoder,
  decoder: decoding.Decoder,
  provider: YSweetProvider,
  emitSynced: boolean,
  messageType: number,
) => void;

/**
 * Create the default set of message handlers.
 */
export function createMessageHandlers(): MessageHandler[] {
  const handlers: MessageHandler[] = [];

  handlers[messageSync] = (encoder, decoder, provider, emitSynced) => {
    encoding.writeVarUint(encoder, messageSync);
    const syncMessageType = syncProtocol.readSyncMessage(
      decoder,
      encoder,
      provider.doc,
      provider,
    );
    if (
      emitSynced &&
      syncMessageType === syncProtocol.messageYjsSyncStep2 &&
      !provider.synced
    ) {
      provider.synced = true;
    }
  };

  handlers[messageQueryAwareness] = (encoder, _decoder, provider) => {
    encoding.writeVarUint(encoder, messageAwareness);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(
        provider.awareness,
        Array.from(provider.awareness.getStates().keys()),
      ),
    );
  };

  handlers[messageAwareness] = (_encoder, decoder, provider) => {
    awarenessProtocol.applyAwarenessUpdate(
      provider.awareness,
      decoding.readVarUint8Array(decoder),
      provider,
    );
  };

  handlers[messageAuth] = (_encoder, decoder, provider) => {
    authProtocol.readAuthMessage(decoder, provider.doc, (_ydoc, reason) => {
      logger.warn(
        `Permission denied to access ${provider.url}.\n${reason}`,
      );
    });
  };

  return handlers;
}

/**
 * Read and dispatch a message from a binary buffer.
 */
export function readMessage(
  provider: YSweetProvider,
  buf: Uint8Array,
  emitSynced: boolean,
): encoding.Encoder {
  const decoder = decoding.createDecoder(buf);
  const encoder = encoding.createEncoder();
  const messageType = decoding.readVarUint(decoder);
  const messageHandler = provider.messageHandlers[messageType];
  if (messageHandler) {
    messageHandler(encoder, decoder, provider, emitSynced, messageType);
  } else {
    captureMessage(
      `Unable to compute message of type ${messageType}`,
      "error",
      { component: "YSweetProvider", operation: "readMessage" },
    );
  }
  return encoder;
}
