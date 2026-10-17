/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Image edit history helper: pure TypeScript, no DOM, no React.
 * Tracks rotate and flip operations with full undo, redo, and reset.
 */

export type EditOp =
  | { type: 'rotate'; quarterTurns: 1 | -1 }
  | { type: 'flip'; axis: 'horizontal' | 'vertical' };

export interface EditHistory {
  ops: EditOp[];
  redo: EditOp[];
}

export function emptyHistory(): EditHistory {
  return { ops: [], redo: [] };
}

export function canUndo(h: EditHistory): boolean {
  return h.ops.length > 0;
}

export function canRedo(h: EditHistory): boolean {
  return h.redo.length > 0;
}

export function applyOp(h: EditHistory, op: EditOp): EditHistory {
  return {
    ops: [...h.ops, op],
    redo: [],
  };
}

export function undo(h: EditHistory): EditHistory {
  if (!canUndo(h)) return { ops: [...h.ops], redo: [...h.redo] };
  const last = h.ops[h.ops.length - 1];
  return {
    ops: h.ops.slice(0, -1),
    redo: [...h.redo, last],
  };
}

export function redo(h: EditHistory): EditHistory {
  if (!canRedo(h)) return { ops: [...h.ops], redo: [...h.redo] };
  const next = h.redo[h.redo.length - 1];
  return {
    ops: [...h.ops, next],
    redo: h.redo.slice(0, -1),
  };
}

export function reset(_h?: EditHistory): EditHistory {
  return { ops: [], redo: [] };
}

export function outputSize(
  width: number,
  height: number,
  ops: readonly EditOp[]
): { width: number; height: number } {
  let w = width;
  let h = height;
  for (const op of ops) {
    if (op.type === 'rotate') {
      const tmp = w;
      w = h;
      h = tmp;
    }
  }
  return { width: w, height: h };
}
