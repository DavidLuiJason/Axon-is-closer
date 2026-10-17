/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Image Editor (P7a slice): open, rotate, flip, undo, redo, reset, and save.
 * Follows THE AXON LOOK strictly.
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  Crop,
  FlipHorizontal,
  Image as ImageIcon,
  Pencil,
  Redo2,
  RotateCcw,
  RotateCw,
  Scaling,
  SlidersHorizontal,
  Type,
  Undo2,
  Wand2,
} from 'lucide-react';
import { ScreenHeader } from '../ScreenHeader';
import {
  applyOp,
  canRedo,
  canUndo,
  emptyHistory,
  outputSize,
  redo,
  reset,
  undo,
  type EditHistory,
  type EditOp,
} from '../../tools/imageEdit/history';
import { saveFile } from '../../services/saveFile';

interface ImageEditorScreenProps {
  onBack: () => void;
  onLogoClick?: () => void;
}

type ActivePanel = 'rotate' | 'flip' | 'save' | null;
type SaveFormat = 'png' | 'jpg' | 'webp';

function formatTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const YYYY = d.getFullYear();
  const MM = pad(d.getMonth() + 1);
  const DD = pad(d.getDate());
  const HH = pad(d.getHours());
  const mm = pad(d.getMinutes());
  const ss = pad(d.getSeconds());
  return `${YYYY}${MM}${DD}-${HH}${mm}${ss}`;
}

export const ImageEditorScreen: React.FC<ImageEditorScreenProps> = ({
  onBack,
  onLogoClick,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Original decoded bitmap
  const bitmapRef = useRef<ImageBitmap | null>(null);
  const [hasPicture, setHasPicture] = useState(false);

  // Edit history
  const [history, setHistory] = useState<EditHistory>(emptyHistory);

  // Active sub-panel
  const [activePanel, setActivePanel] = useState<ActivePanel>(null);

  // Save format & status
  const [saveFormat, setSaveFormat] = useState<SaveFormat>('png');
  const [saveStatus, setSaveStatus] = useState<'saved' | 'error' | null>(null);

  // Notices
  const [scaledNotice, setScaledNotice] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Clean up bitmap on unmount
  useEffect(() => {
    return () => {
      if (bitmapRef.current) {
        bitmapRef.current.close();
        bitmapRef.current = null;
      }
    };
  }, []);

  // Redraw canvas whenever bitmap or history ops change
  const redrawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const bitmap = bitmapRef.current;
    if (!canvas || !bitmap) return;

    const { width: targetWidth, height: targetHeight } = outputSize(
      bitmap.width,
      bitmap.height,
      history.ops
    );

    canvas.width = targetWidth;
    canvas.height = targetHeight;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.save();
    ctx.clearRect(0, 0, targetWidth, targetHeight);

    // Apply cumulative ops
    let curW = bitmap.width;
    let curH = bitmap.height;

    // We can accumulate step matrices or apply sequential canvas transforms
    // For 2D canvas, each step modifies the coordinate space.
    // To transform the source image [curW, curH] to next orientation:
    // Rotate 90 CW: translate(curH, 0), rotate(PI/2)
    // Rotate 90 CCW: translate(0, curW), rotate(-PI/2)
    // Flip H: translate(curW, 0), scale(-1, 1)
    // Flip V: translate(0, curH), scale(1, -1)
    // When composed from last op to first op, the context transforms match directly.
    let m = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    const multiply = (
      m1: { a: number; b: number; c: number; d: number; e: number; f: number },
      m2: { a: number; b: number; c: number; d: number; e: number; f: number }
    ) => ({
      a: m1.a * m2.a + m1.c * m2.b,
      b: m1.b * m2.a + m1.d * m2.b,
      c: m1.a * m2.c + m1.c * m2.d,
      d: m1.b * m2.c + m1.d * m2.d,
      e: m1.a * m2.e + m1.c * m2.f + m1.e,
      f: m1.b * m2.e + m1.d * m2.f + m1.f,
    });

    for (const op of history.ops) {
      let step = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
      if (op.type === 'rotate') {
        if (op.quarterTurns === 1) {
          step = { a: 0, b: 1, c: -1, d: 0, e: curH, f: 0 };
        } else {
          step = { a: 0, b: -1, c: 1, d: 0, e: 0, f: curW };
        }
        const tmp = curW;
        curW = curH;
        curH = tmp;
      } else if (op.type === 'flip') {
        if (op.axis === 'horizontal') {
          step = { a: -1, b: 0, c: 0, d: 1, e: curW, f: 0 };
        } else {
          step = { a: 1, b: 0, c: 0, d: -1, e: 0, f: curH };
        }
      }
      m = multiply(step, m);
    }

    ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
    ctx.drawImage(bitmap, 0, 0);
    ctx.restore();
  }, [history.ops]);

  useEffect(() => {
    if (hasPicture) {
      redrawCanvas();
    }
  }, [hasPicture, history.ops, redrawCanvas]);

  // Open file handler
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Reset input so same file can be picked again
    e.target.value = '';

    setErrorMessage(null);
    setSaveStatus(null);
    setScaledNotice(false);

    try {
      let loadedBitmap = await createImageBitmap(file);

      // Phone safety (Rule 8): if longer side > 4096 px, scale down to 4096 on load
      const maxDim = Math.max(loadedBitmap.width, loadedBitmap.height);
      if (maxDim > 4096) {
        const ratio = 4096 / maxDim;
        const targetW = Math.round(loadedBitmap.width * ratio);
        const targetH = Math.round(loadedBitmap.height * ratio);

        const offscreen = document.createElement('canvas');
        offscreen.width = targetW;
        offscreen.height = targetH;
        const offCtx = offscreen.getContext('2d');
        if (offCtx) {
          offCtx.drawImage(loadedBitmap, 0, 0, targetW, targetH);
          loadedBitmap.close();
          loadedBitmap = await createImageBitmap(offscreen);
          setScaledNotice(true);
        }
      }

      if (bitmapRef.current) {
        bitmapRef.current.close();
      }

      bitmapRef.current = loadedBitmap;
      setHistory(emptyHistory());
      setHasPicture(true);
      setActivePanel(null);
    } catch {
      setErrorMessage('That file could not be opened as a picture.');
    }
  };

  // Operation dispatch
  const handleApplyOp = (op: EditOp) => {
    setHistory((prev) => applyOp(prev, op));
  };

  const handleUndo = () => {
    setHistory((prev) => undo(prev));
  };

  const handleRedo = () => {
    setHistory((prev) => redo(prev));
  };

  const handleReset = () => {
    setHistory((prev) => reset(prev));
    setActivePanel(null);
  };

  const togglePanel = (panel: ActivePanel) => {
    if (!hasPicture) return;
    setActivePanel((prev) => (prev === panel ? null : panel));
  };

  // Save handler
  const handleSavePicture = () => {
    const canvas = canvasRef.current;
    if (!canvas || !hasPicture) return;

    setSaveStatus(null);

    let exportCanvas: HTMLCanvasElement = canvas;
    if (saveFormat === 'jpg') {
      exportCanvas = document.createElement('canvas');
      exportCanvas.width = canvas.width;
      exportCanvas.height = canvas.height;
      const ctx = exportCanvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
        ctx.drawImage(canvas, 0, 0);
      }
    }

    const mimeType =
      saveFormat === 'png'
        ? 'image/png'
        : saveFormat === 'jpg'
        ? 'image/jpeg'
        : 'image/webp';
    const quality = saveFormat === 'png' ? undefined : 0.92;

    exportCanvas.toBlob(
      async (blob) => {
        if (!blob) {
          setSaveStatus('error');
          return;
        }
        const stamp = formatTimestamp(new Date());
        const filename = `axon-image-${stamp}.${saveFormat}`;
        const res = await saveFile(filename, blob, mimeType);
        if (res.success) {
          setSaveStatus('saved');
          setTimeout(() => setSaveStatus(null), 3000);
        } else {
          setSaveStatus('error');
        }
      },
      mimeType,
      quality
    );
  };

  return (
    <div className="relative w-full h-full flex flex-col bg-[#121315] text-[#ECECEC] overflow-hidden font-sans">
      <ScreenHeader
        title="Image Editor"
        tagline="IMAGE EDITOR"
        backLabel="MEDIA"
        collapsible
        onBack={onBack}
        onLogoClick={onLogoClick ?? (() => {})}
      />

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        onChange={handleFileChange}
        className="hidden"
        aria-hidden="true"
      />

      {/* A. Action row */}
      <div className="px-5 h-12 flex items-center justify-between border-b border-white/5 bg-[#121315] shrink-0">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={handleUndo}
            disabled={!canUndo(history)}
            aria-label="Undo"
            title="Undo"
            className="w-11 h-11 rounded-xl hover:bg-white/5 text-[#D0D2D6] disabled:opacity-30 disabled:pointer-events-none flex items-center justify-center cursor-pointer transition-colors"
          >
            <Undo2 size={18} />
          </button>
          <button
            type="button"
            onClick={handleRedo}
            disabled={!canRedo(history)}
            aria-label="Redo"
            title="Redo"
            className="w-11 h-11 rounded-xl hover:bg-white/5 text-[#D0D2D6] disabled:opacity-30 disabled:pointer-events-none flex items-center justify-center cursor-pointer transition-colors"
          >
            <Redo2 size={18} />
          </button>
        </div>

        <div>
          <button
            type="button"
            onClick={() => togglePanel('save')}
            disabled={!hasPicture}
            className="px-4 py-2 rounded-xl bg-white text-black font-medium text-sm hover:bg-[#F0F0F0] transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
          >
            Save
          </button>
        </div>
      </div>

      {/* B. Work area */}
      <div className="flex-1 min-h-0 bg-[#141517] flex flex-col items-center justify-center p-4 overflow-hidden relative">
        {!hasPicture ? (
          <div className="flex flex-col items-center justify-center text-center space-y-3">
            <ImageIcon size={36} className="text-[#5A5C62]" />
            <p className="text-sm text-[#8E9094]">Open a picture to start.</p>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="px-5 py-2.5 rounded-xl bg-white text-black font-medium text-sm hover:bg-[#F0F0F0] transition-colors cursor-pointer"
            >
              Open picture
            </button>
            <p className="text-[11.5px] text-[#7A7C82]">The picture stays on your phone.</p>
            {errorMessage && (
              <p className="text-[13px] text-[#E0B4A8] pt-1">{errorMessage}</p>
            )}
          </div>
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center relative overflow-hidden">
            <canvas
              ref={canvasRef}
              className="max-w-full max-h-full object-contain"
            />
            {scaledNotice && (
              <div className="absolute top-2 left-1/2 -translate-x-1/2 px-3 py-1 rounded-lg bg-[#141517]/90 border border-white/5 text-[11.5px] text-[#7A7C82] pointer-events-none text-center">
                Large pictures are reduced to 4096 px to keep your phone fast.
              </div>
            )}
          </div>
        )}
      </div>

      {/* C. Bottom area */}
      <div className="shrink-0 bg-[#141517] border-t border-white/5">
        {/* 1. Tool panel */}
        {activePanel && hasPicture && (
          <div className="px-5 py-3 border-b border-white/5 flex flex-wrap items-center gap-3">
            {activePanel === 'rotate' && (
              <>
                <button
                  type="button"
                  onClick={() => handleApplyOp({ type: 'rotate', quarterTurns: -1 })}
                  className="px-4 py-2.5 rounded-xl bg-white/5 text-[#D0D2D6] text-sm hover:bg-white/10 transition-colors cursor-pointer flex items-center gap-1.5 min-h-[44px]"
                >
                  Left 90°
                </button>
                <button
                  type="button"
                  onClick={() => handleApplyOp({ type: 'rotate', quarterTurns: 1 })}
                  className="px-4 py-2.5 rounded-xl bg-white/5 text-[#D0D2D6] text-sm hover:bg-white/10 transition-colors cursor-pointer flex items-center gap-1.5 min-h-[44px]"
                >
                  Right 90°
                </button>
              </>
            )}

            {activePanel === 'flip' && (
              <>
                <button
                  type="button"
                  onClick={() => handleApplyOp({ type: 'flip', axis: 'horizontal' })}
                  className="px-4 py-2.5 rounded-xl bg-white/5 text-[#D0D2D6] text-sm hover:bg-white/10 transition-colors cursor-pointer flex items-center gap-1.5 min-h-[44px]"
                >
                  Horizontal
                </button>
                <button
                  type="button"
                  onClick={() => handleApplyOp({ type: 'flip', axis: 'vertical' })}
                  className="px-4 py-2.5 rounded-xl bg-white/5 text-[#D0D2D6] text-sm hover:bg-white/10 transition-colors cursor-pointer flex items-center gap-1.5 min-h-[44px]"
                >
                  Vertical
                </button>
              </>
            )}

            {activePanel === 'save' && (
              <div className="w-full flex flex-col gap-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold uppercase tracking-wider text-[#8E9094] mr-1">
                    FORMAT
                  </span>
                  {(['png', 'jpg', 'webp'] as const).map((fmt) => (
                    <button
                      key={fmt}
                      type="button"
                      onClick={() => setSaveFormat(fmt)}
                      className={`px-4 py-2 rounded-xl text-sm transition-colors cursor-pointer min-h-[44px] ${
                        saveFormat === fmt
                          ? 'bg-white text-black font-medium'
                          : 'bg-white/5 text-[#D0D2D6] hover:bg-white/10'
                      }`}
                    >
                      {fmt.toUpperCase()}
                    </button>
                  ))}
                </div>

                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={handleSavePicture}
                    className="px-5 py-2.5 rounded-xl bg-white text-black font-medium text-sm hover:bg-[#F0F0F0] transition-colors cursor-pointer min-h-[44px]"
                  >
                    Save picture
                  </button>

                  {saveStatus === 'saved' && (
                    <span className="text-[11.5px] text-[#7A7C82]">Saved.</span>
                  )}
                  {saveStatus === 'error' && (
                    <span className="text-[13px] text-[#E0B4A8]">
                      The picture could not be saved.
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* 2. Tool strip */}
        <div className="px-3 py-2 flex overflow-x-auto gap-1">
          {/* Change button when picture is open */}
          {hasPicture && (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              aria-label="Change picture"
              className="min-w-[64px] min-h-[52px] flex flex-col items-center justify-center gap-1 rounded-xl hover:bg-white/5 text-[#D0D2D6] cursor-pointer transition-colors shrink-0"
            >
              <ImageIcon size={20} />
              <span className="text-[10.5px] uppercase tracking-wider">Change</span>
            </button>
          )}

          {/* Rotate tool */}
          <button
            type="button"
            disabled={!hasPicture}
            onClick={() => togglePanel('rotate')}
            aria-label="Rotate"
            className={`min-w-[64px] min-h-[52px] flex flex-col items-center justify-center gap-1 rounded-xl hover:bg-white/5 cursor-pointer transition-colors shrink-0 ${
              !hasPicture
                ? 'opacity-30 cursor-not-allowed text-[#5A5C62]'
                : activePanel === 'rotate'
                ? 'text-[#E85A3C]'
                : 'text-[#D0D2D6]'
            }`}
          >
            <RotateCw size={20} />
            <span className="text-[10.5px] uppercase tracking-wider">Rotate</span>
          </button>

          {/* Flip tool */}
          <button
            type="button"
            disabled={!hasPicture}
            onClick={() => togglePanel('flip')}
            aria-label="Flip"
            className={`min-w-[64px] min-h-[52px] flex flex-col items-center justify-center gap-1 rounded-xl hover:bg-white/5 cursor-pointer transition-colors shrink-0 ${
              !hasPicture
                ? 'opacity-30 cursor-not-allowed text-[#5A5C62]'
                : activePanel === 'flip'
                ? 'text-[#E85A3C]'
                : 'text-[#D0D2D6]'
            }`}
          >
            <FlipHorizontal size={20} />
            <span className="text-[10.5px] uppercase tracking-wider">Flip</span>
          </button>

          {/* Reset tool */}
          <button
            type="button"
            disabled={!hasPicture}
            onClick={handleReset}
            aria-label="Reset edits"
            className="min-w-[64px] min-h-[52px] flex flex-col items-center justify-center gap-1 rounded-xl hover:bg-white/5 text-[#D0D2D6] disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer transition-colors shrink-0"
          >
            <RotateCcw size={20} />
            <span className="text-[10.5px] uppercase tracking-wider">Reset</span>
          </button>

          {/* Dimmed, not-yet-built items */}
          <div
            className="min-w-[64px] min-h-[52px] flex flex-col items-center justify-center gap-1 rounded-xl text-[#5A5C62] cursor-not-allowed shrink-0 select-none"
            aria-disabled="true"
          >
            <Crop size={20} />
            <span className="text-[10.5px] uppercase tracking-wider">Crop</span>
          </div>

          <div
            className="min-w-[64px] min-h-[52px] flex flex-col items-center justify-center gap-1 rounded-xl text-[#5A5C62] cursor-not-allowed shrink-0 select-none"
            aria-disabled="true"
          >
            <Scaling size={20} />
            <span className="text-[10.5px] uppercase tracking-wider">Resize</span>
          </div>

          <div
            className="min-w-[64px] min-h-[52px] flex flex-col items-center justify-center gap-1 rounded-xl text-[#5A5C62] cursor-not-allowed shrink-0 select-none"
            aria-disabled="true"
          >
            <SlidersHorizontal size={20} />
            <span className="text-[10.5px] uppercase tracking-wider">Adjust</span>
          </div>

          <div
            className="min-w-[64px] min-h-[52px] flex flex-col items-center justify-center gap-1 rounded-xl text-[#5A5C62] cursor-not-allowed shrink-0 select-none"
            aria-disabled="true"
          >
            <Wand2 size={20} />
            <span className="text-[10.5px] uppercase tracking-wider">Filters</span>
          </div>

          <div
            className="min-w-[64px] min-h-[52px] flex flex-col items-center justify-center gap-1 rounded-xl text-[#5A5C62] cursor-not-allowed shrink-0 select-none"
            aria-disabled="true"
          >
            <Type size={20} />
            <span className="text-[10.5px] uppercase tracking-wider">Text</span>
          </div>

          <div
            className="min-w-[64px] min-h-[52px] flex flex-col items-center justify-center gap-1 rounded-xl text-[#5A5C62] cursor-not-allowed shrink-0 select-none"
            aria-disabled="true"
          >
            <Pencil size={20} />
            <span className="text-[10.5px] uppercase tracking-wider">Draw</span>
          </div>
        </div>

        {/* Footnote */}
        <p className="text-xs text-[#707277] text-center pb-2">
          Dimmed tools are coming soon.
        </p>
      </div>
    </div>
  );
};

export default ImageEditorScreen;
