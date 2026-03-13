import * as Y from "yjs";
import { diff_match_patch, type Diff } from "diff-match-patch";
import { logger } from "../util/logger";

/** Module-level singleton – avoids allocating a new instance on every call. */
const dmp = new diff_match_patch();

/**
 * Apply a local file's content to a Y.Doc by computing minimal diffs.
 * Uses diff-match-patch to translate a full-text replacement into granular
 * Y.Text insert/delete operations, preserving CRDT history and enabling
 * proper merging with concurrent edits.
 *
 * The transaction is tagged with origin "local-edit" so that remote observers
 * (DocumentSync.observeRemoteChanges) can distinguish local edits from
 * remote ones and skip re-writing to disk.
 *
 * @param ydoc - The Y.Doc containing a Y.Text("contents") to update
 * @param newContent - The new full text content to apply
 */
export function applyTextToYDoc(ydoc: Y.Doc, newContent: string): void {
  const ytext = ydoc.getText("contents");
  const currentContent = ytext.toString();

  // No-op if content is identical
  if (currentContent === newContent) return;

  const diffs: Diff[] = dmp.diff_main(currentContent, newContent);
  dmp.diff_cleanupSemantic(diffs);

  if (diffs.length === 0) return;

  logger.debug(
    `Applying text diff: ${currentContent.length} -> ${newContent.length} chars, ${diffs.length} diff ops`,
  );

  // Apply diffs inside a transaction tagged with "local-edit" origin
  // so remote observers can skip changes we originated
  ydoc.transact(() => {
    let cursor = 0;
    for (const [operation, text] of diffs) {
      switch (operation) {
        case 1: // Insert
          ytext.insert(cursor, text);
          cursor += text.length;
          break;
        case 0: // Equal
          cursor += text.length;
          break;
        case -1: // Delete
          ytext.delete(cursor, text.length);
          break;
      }
    }
  }, "local-edit");
}
