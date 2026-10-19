/**
 * PDF 阅读器：pdf.js 主线程渲染（fake worker，免独立 worker 文件）。
 * 数据经 /file 二进制路由取原始字节，canvas 逐页渲染。
 * 支持单页 / 双页并排（双页时以「跨页对」为单位翻页）与缩放。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
// worker 模块注册到 globalThis 后 pdf.js 走主线程 fake worker（无需独立 worker 文件）
// @ts-expect-error pdf.worker 无类型入口
import * as pdfjsWorker from 'pdfjs-dist/build/pdf.worker.mjs';
import type { ReaderColumns } from '../../shared/types.ts';
import { resolveColumns } from '../paginate.ts';
import { FLOW_WHEEL_COOLDOWN_MS, FLOW_WHEEL_THRESHOLD } from './FlowReader.tsx';
// @ts-expect-error 全局挂载
globalThis.pdfjsWorker = pdfjsWorker;

/** 组件依赖。 */
export interface PdfViewerProps {
  fileUrl: string;
  columns: ReaderColumns;
  /** 初始页码（0 起）。 */
  initialPage?: number;
  /** 页码变化（用于保存进度）。 */
  onProgress?(page: number, pageCount: number): void;
}

/** pdf.js 的页面对象（只用到渲染相关成员）。 */
interface PdfPageLike {
  getViewport(options: { scale: number }): { width: number; height: number };
  render(options: { canvasContext: CanvasRenderingContext2D; viewport: unknown }): { promise: Promise<void> };
}

/** 双页并排时的页面（用于并排两张画布）。 */
function PdfSheet({
  doc,
  pageNumber,
  scale,
  onRendered,
}: {
  doc: { getPage(n: number): Promise<unknown> } | null;
  pageNumber: number;
  scale: number;
  onRendered?(): void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (doc === null || pageNumber < 1) return;
      try {
        const pdfPage = (await doc.getPage(pageNumber)) as PdfPageLike;
        const viewport = pdfPage.getViewport({ scale });
        const canvas = canvasRef.current;
        if (canvas === null || cancelled) return;
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const context = canvas.getContext('2d');
        if (context === null) return;
        await pdfPage.render({ canvasContext: context, viewport }).promise;
        if (!cancelled) onRendered?.();
      } catch {
        // 单页渲染失败不影响其他页（翻页会重试）
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [doc, pageNumber, scale, onRendered]);

  return <canvas ref={canvasRef} className="dsh-reading-pdf-canvas" />;
}

/** PDF 阅读器。 */
export function PdfViewer({ fileUrl, columns, initialPage = 0, onProgress }: PdfViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [numPages, setNumPages] = useState(0);
  /** 单页模式下的页码；双页模式下是该「跨页对」的首页码（1 起）。 */
  const [page, setPage] = useState(Math.max(1, initialPage + 1));
  const [scale, setScale] = useState(1.2);
  const [error, setError] = useState<string>();
  const [containerWidth, setContainerWidth] = useState(0);
  const [ready, setReady] = useState(false);
  const docRef = useRef<{ getPage(n: number): Promise<unknown>; numPages: number } | null>(null);
  const [doc, setDoc] = useState<{ getPage(n: number): Promise<unknown> } | null>(null);

  const spread = resolveColumns(columns, containerWidth) === 2;

  // ── 测量容器宽度（决定单页/双页）──
  useEffect(() => {
    const element = containerRef.current;
    if (element === null) return;
    const measure = (): void => setContainerWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // ── 载入文档 ──
  useEffect(() => {
    let cancelled = false;
    let activeTask: { destroy(): Promise<void> } | null = null;
    setReady(false);
    setError(undefined);
    (async () => {
      try {
        const response = await fetch(fileUrl);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.arrayBuffer();
        const loadingTask = pdfjsLib.getDocument({ data });
        activeTask = loadingTask;
        const loaded = await loadingTask.promise;
        if (cancelled) {
          await loadingTask.destroy();
          return;
        }
        docRef.current = loaded;
        setDoc(loaded);
        setNumPages(loaded.numPages);
        setPage((current) => Math.min(Math.max(1, current), Math.max(1, loaded.numPages)));
        setReady(true);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      cancelled = true;
      void activeTask?.destroy();
      docRef.current = null;
      setDoc(null);
    };
  }, [fileUrl]);

  // ── 上报进度 ──
  useEffect(() => {
    if (numPages > 0 && ready) onProgress?.(page - 1, numPages);
  }, [numPages, onProgress, page, ready]);

  // ── 键盘翻页（与流式阅读器一致的手感）──
  const step = spread ? 2 : 1;
  const goNext = useCallback((): void => {
    setPage((current) => Math.min(numPages, current + step));
  }, [numPages, step]);
  const goPrev = useCallback((): void => {
    setPage((current) => Math.max(1, current - step));
  }, [step]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target !== null && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown' || event.key === 'PageDown' || event.key === ' ') {
        event.preventDefault();
        goNext();
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp' || event.key === 'PageUp') {
        event.preventDefault();
        goPrev();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goNext, goPrev]);

  // ── 滚轮翻页（与流式阅读器同一套阈值/冷却，手感一致）──
  // 必须手动 addEventListener + passive: false，理由见 FlowReader 里的注释。
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    let lastAt = 0;
    let accum = 0;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const now = Date.now();
      if (accum !== 0 && Math.sign(event.deltaY) !== Math.sign(accum)) accum = 0;
      if (now - lastAt < FLOW_WHEEL_COOLDOWN_MS) return;
      accum += event.deltaY;
      if (Math.abs(accum) < FLOW_WHEEL_THRESHOLD) return;
      const direction = accum > 0 ? 1 : -1;
      accum = 0;
      lastAt = now;
      if (direction === 1) goNext();
      else goPrev();
    };
    container.addEventListener('wheel', onWheel, { passive: false });
    return () => container.removeEventListener('wheel', onWheel);
  }, [goNext, goPrev]);

  /** 双页时右页页码（超出则空）。 */
  const rightPage = page + 1 <= numPages ? page + 1 : 0;

  if (error !== undefined) {
    return <p className="dsh-reading-error">PDF: {error}</p>;
  }

  return (
    <div className="dsh-reading-pdf" ref={containerRef}>
      <nav className="dsh-reading-pdfnav">
        <button type="button" className="dsh-reading-iconbtn" disabled={page <= 1} onClick={goPrev}>
          ‹
        </button>
        <span className="dsh-reading-pager">
          {numPages > 0 ? `${page}${spread && rightPage > 0 ? `–${rightPage}` : ''}/${numPages} ${''}` : '…'}
        </span>
        <button type="button" className="dsh-reading-iconbtn" disabled={page + step > numPages} onClick={goNext}>
          ›
        </button>
        <span className="dsh-reading-pdfsep" />
        <button type="button" className="dsh-reading-iconbtn" onClick={() => setScale((s) => Math.max(0.5, s - 0.2))}>
          －
        </button>
        <span className="dsh-reading-pager">{Math.round(scale * 100)}%</span>
        <button type="button" className="dsh-reading-iconbtn" onClick={() => setScale((s) => Math.min(3, s + 0.2))}>
          ＋
        </button>
      </nav>
      <div className="dsh-reading-pdfpages" data-spread={spread ? 'two' : 'one'}>
        <PdfSheet doc={doc} pageNumber={page} scale={scale} />
        {spread && rightPage > 0 && <PdfSheet doc={doc} pageNumber={rightPage} scale={scale} />}
      </div>
    </div>
  );
}
