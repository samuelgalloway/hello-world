"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Box, Region } from "@/lib/types";
import { canvasToBlob, cloneCanvas, detectionPayload, fileToCanvas, retouchRegions } from "@/lib/imaging";

type Item = Region & { selected: boolean };

const MAX_UNDO = 8;
const PASSCODE_KEY = "retouch-passcode";
const TYPE_LABEL: Record<Region["type"], string> = {
  blemish: "Blemish",
  stray_hair: "Stray hair",
  dust_spot: "Dust spot",
  other_minor: "Minor flaw",
  manual: "Marked by you",
};

const clampPct = (v: number) => Math.min(100, Math.max(0, v));

function readStoredPasscode(): string {
  try {
    return localStorage.getItem(PASSCODE_KEY) ?? "";
  } catch {
    return "";
  }
}

class PasscodeError extends Error {}

export default function Home() {
  const [fileName, setFileName] = useState("photo");
  const [mimeType, setMimeType] = useState("image/jpeg");
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [hovered, setHovered] = useState<string | null>(null);
  const [draft, setDraft] = useState<Box | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [comparing, setComparing] = useState(false);
  const [undoCount, setUndoCount] = useState(0);
  const [fixCount, setFixCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [passcode, setPasscode] = useState("");
  const [needPasscode, setNeedPasscode] = useState(false);

  const fileInput = useRef<HTMLInputElement>(null);
  const viewRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const original = useRef<HTMLCanvasElement | null>(null);
  const working = useRef<HTMLCanvasElement | null>(null);
  const history = useRef<HTMLCanvasElement[]>([]);
  const dragStart = useRef<{ x: number; y: number; cx: number; cy: number } | null>(null);

  const busy = scanning || !!progress;

  useEffect(() => setPasscode(readStoredPasscode()), []);

  // Mirror the working (or original, while comparing) image into the visible canvas.
  const paint = useCallback(() => {
    const view = viewRef.current;
    const src = comparing ? original.current : working.current;
    if (!view || !src) return;
    if (view.width !== src.width) view.width = src.width;
    if (view.height !== src.height) view.height = src.height;
    view.getContext("2d")?.drawImage(src, 0, 0);
  }, [comparing]);

  useEffect(paint, [paint, dims, undoCount, fixCount]);

  async function api<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-passcode": passcode },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && data.needPasscode) {
      setNeedPasscode(true);
      throw new PasscodeError("Enter the passcode to continue.");
    }
    if (!res.ok || data.error) throw new Error(data.error || `Request failed (${res.status})`);
    return data as T;
  }

  async function handleFile(file: File) {
    if (busy) return;
    setError(null);
    try {
      const canvas = await fileToCanvas(file);
      original.current = canvas;
      working.current = cloneCanvas(canvas);
      history.current = [];
      setUndoCount(0);
      setFixCount(0);
      setItems([]);
      setScanned(false);
      setFileName(file.name.replace(/\.[^.]+$/, "") || "photo");
      setMimeType(file.type === "image/png" ? "image/png" : "image/jpeg");
      setDims({ w: canvas.width, h: canvas.height });
    } catch {
      setError("Couldn't open that file. Try a JPEG or PNG (iPhone HEIC photos: export as JPEG first).");
    }
  }

  async function scan() {
    if (!working.current || busy) return;
    setScanning(true);
    setError(null);
    try {
      const { regions } = await api<{ regions: Region[] }>("/api/detect", detectionPayload(working.current));
      setItems((prev) => [...prev.filter((i) => i.type === "manual"), ...regions.map((r) => ({ ...r, selected: true }))]);
      setScanned(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Scan failed");
    } finally {
      setScanning(false);
    }
  }

  async function fixSelected() {
    const src = working.current;
    const chosen = items.filter((i) => i.selected);
    if (!src || !chosen.length || busy) return;
    setError(null);
    setProgress({ done: 0, total: 1 });
    try {
      const result = await retouchRegions(
        src,
        chosen,
        async (payload) => (await api<{ image: string }>("/api/retouch", payload)).image,
        (done, total) => setProgress({ done, total }),
      );
      history.current = [...history.current, src].slice(-MAX_UNDO);
      working.current = result;
      setUndoCount(history.current.length);
      setFixCount((n) => n + 1);
      setItems((prev) => prev.filter((i) => !i.selected));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Retouch failed");
    } finally {
      setProgress(null);
    }
  }

  const undo = useCallback(() => {
    const prev = history.current.pop();
    if (!prev || busy) return;
    working.current = prev;
    setUndoCount(history.current.length);
    setFixCount((n) => Math.max(0, n - 1));
  }, [busy]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo]);

  async function download(type: string) {
    if (!working.current) return;
    const blob = await canvasToBlob(working.current, type, type === "image/jpeg" ? 0.95 : undefined);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${fileName}-retouched.${type === "image/png" ? "png" : "jpg"}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  // ---- Marking spots by hand: click for a small spot, drag for a box. ----

  function pointerPct(e: React.PointerEvent) {
    const r = stageRef.current!.getBoundingClientRect();
    return {
      x: clampPct(((e.clientX - r.left) / r.width) * 100),
      y: clampPct(((e.clientY - r.top) / r.height) * 100),
      cx: e.clientX,
      cy: e.clientY,
    };
  }

  function onStageDown(e: React.PointerEvent) {
    if (busy || comparing || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStart.current = pointerPct(e);
  }

  function onStageMove(e: React.PointerEvent) {
    const s = dragStart.current;
    if (!s) return;
    const p = pointerPct(e);
    if (Math.hypot(p.cx - s.cx, p.cy - s.cy) < 5) return;
    setDraft({ x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), width: Math.abs(p.x - s.x), height: Math.abs(p.y - s.y) });
  }

  function onStageUp() {
    const s = dragStart.current;
    dragStart.current = null;
    if (!s || !dims) return;
    let box = draft;
    setDraft(null);
    if (!box) {
      // Plain click: a small square spot, ~2% of the shorter side.
      const side = Math.min(dims.w, dims.h) * 0.02;
      const w = (side / dims.w) * 100;
      const h = (side / dims.h) * 100;
      box = { x: clampPct(s.x - w / 2), y: clampPct(s.y - h / 2), width: w, height: h };
    }
    const id = `manual-${Date.now().toString(36)}`;
    setItems((prev) => [...prev, { id, type: "manual", note: "", box, selected: true }]);
  }

  const toggle = (id: string) => setItems((prev) => prev.map((i) => (i.id === id ? { ...i, selected: !i.selected } : i)));
  const remove = (id: string) => setItems((prev) => prev.filter((i) => i.id !== id));
  const selectedCount = items.filter((i) => i.selected).length;

  function savePasscode(e: React.FormEvent) {
    e.preventDefault();
    try {
      localStorage.setItem(PASSCODE_KEY, passcode);
    } catch {
      /* private mode — keep it in memory only */
    }
    setNeedPasscode(false);
    setError(null);
  }

  const picker = (
    <input
      ref={fileInput}
      type="file"
      accept="image/jpeg,image/png,image/webp,image/heic,image/*"
      hidden
      onChange={(e) => {
        const f = e.target.files?.[0];
        if (f) void handleFile(f);
        e.target.value = "";
      }}
    />
  );

  if (needPasscode) {
    return (
      <main className="shell narrow">
        <h1>Retouch</h1>
        <form onSubmit={savePasscode} className="passcode">
          <label htmlFor="pc">Passcode</label>
          <input id="pc" type="password" autoFocus value={passcode} onChange={(e) => setPasscode(e.target.value)} />
          <button className="btn primary" type="submit">
            Continue
          </button>
        </form>
      </main>
    );
  }

  if (!dims) {
    return (
      <main className="shell narrow">
        {picker}
        <h1>Retouch</h1>
        <p className="lede">
          Conservative clean-up for portraits: blemishes, stray hairs, dust spots. It only touches the spots you
          approve — the rest of the photo stays exactly as it was.
        </p>
        <div
          className={`dropzone ${dragOver ? "over" : ""}`}
          onClick={() => fileInput.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const f = e.dataTransfer.files?.[0];
            if (f) void handleFile(f);
          }}
        >
          <strong>Drop a photo here</strong>
          <span>or click to choose one</span>
        </div>
        {error && <p className="error">{error}</p>}
      </main>
    );
  }

  const boxStyle = (b: Box): React.CSSProperties => ({
    left: `${b.x}%`,
    top: `${b.y}%`,
    width: `${b.width}%`,
    height: `${b.height}%`,
  });

  return (
    <main className="shell">
      {picker}
      <header className="topbar">
        <h1>Retouch</h1>
        <span className="muted">
          {fileName} · {dims.w}×{dims.h}
        </span>
      </header>

      <div className="editor">
        <div className="stage-wrap">
          <div
            ref={stageRef}
            className={`stage ${busy ? "busy" : ""}`}
            onPointerDown={onStageDown}
            onPointerMove={onStageMove}
            onPointerUp={onStageUp}
            onPointerCancel={() => {
              dragStart.current = null;
              setDraft(null);
            }}
          >
            <canvas ref={viewRef} className="photo" />
            {!comparing &&
              items.map((i) => (
                <button
                  key={i.id}
                  type="button"
                  className={`spot ${i.selected ? "on" : "off"} ${hovered === i.id ? "hover" : ""}`}
                  style={boxStyle(i.box)}
                  title={i.note || TYPE_LABEL[i.type]}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => toggle(i.id)}
                  onMouseEnter={() => setHovered(i.id)}
                  onMouseLeave={() => setHovered(null)}
                />
              ))}
            {draft && <div className="spot draft" style={boxStyle(draft)} />}
            {comparing && <div className="badge">Original</div>}
          </div>
          <p className="hint">
            Click a box to include or skip it. Click the photo to mark a missed spot, or drag to draw a box.
          </p>
        </div>

        <aside className="panel">
          <div className="actions">
            <button className="btn primary" onClick={scan} disabled={busy}>
              {scanning ? "Scanning…" : scanned ? "Scan again" : "Scan for flaws"}
            </button>
            <button className="btn primary" onClick={fixSelected} disabled={busy || !selectedCount}>
              {progress
                ? `Fixing… ${progress.done}/${progress.total}`
                : `Fix ${selectedCount || ""} spot${selectedCount === 1 ? "" : "s"}`}
            </button>
          </div>

          {error && <p className="error">{error}</p>}

          <section>
            <h2>
              Spots <span className="muted">({items.length})</span>
            </h2>
            {items.length === 0 ? (
              <p className="muted small">
                {scanned ? "Nothing left flagged. Mark any spot by hand on the photo." : "Scan the photo, or mark spots by hand."}
              </p>
            ) : (
              <ul className="list">
                {items.map((i) => (
                  <li
                    key={i.id}
                    className={hovered === i.id ? "hover" : ""}
                    onMouseEnter={() => setHovered(i.id)}
                    onMouseLeave={() => setHovered(null)}
                  >
                    <label>
                      <input type="checkbox" checked={i.selected} onChange={() => toggle(i.id)} disabled={busy} />
                      <span>
                        {TYPE_LABEL[i.type]}
                        {i.note && <em> — {i.note}</em>}
                      </span>
                    </label>
                    <button className="x" onClick={() => remove(i.id)} disabled={busy} aria-label="Remove">
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h2>Result</h2>
            <div className="actions">
              <button
                className="btn"
                disabled={!fixCount}
                onPointerDown={() => setComparing(true)}
                onPointerUp={() => setComparing(false)}
                onPointerLeave={() => setComparing(false)}
                onKeyDown={(e) => e.key === " " && setComparing(true)}
                onKeyUp={() => setComparing(false)}
              >
                Hold to see original
              </button>
              <button className="btn" onClick={undo} disabled={busy || !undoCount}>
                Undo
              </button>
            </div>
            <div className="actions">
              <button className="btn primary" onClick={() => download(mimeType)} disabled={busy}>
                Download {mimeType === "image/png" ? "PNG" : "JPEG"}
              </button>
              {mimeType !== "image/png" && (
                <button className="btn" onClick={() => download("image/png")} disabled={busy}>
                  PNG (lossless)
                </button>
              )}
            </div>
          </section>

          <button className="btn ghost" onClick={() => fileInput.current?.click()} disabled={busy}>
            Open a different photo
          </button>
        </aside>
      </div>
    </main>
  );
}
