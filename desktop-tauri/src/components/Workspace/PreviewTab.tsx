import React, { useEffect, useState } from 'react';
import { QueueItem } from '../../types';
import {
  ExternalLink,
  FileText,
  Eye,
  Code,
  ZoomIn,
  ZoomOut,
  RotateCw,
  Loader2,
  AlertTriangle,
} from 'lucide-react';
import { Tooltip } from '../Tooltip';
import { loadPreviewDocument, PreviewSource } from '../../services/tauriBridge';

interface PreviewTabProps {
  selectedItem: QueueItem | null;
  markdownContent?: string;
  theme?: 'dark' | 'light';
  zoom: number;
  onZoomChange: (zoom: number) => void;
  previewNonce: number;
  onRefresh: () => void;
  onOpenInEditor?: (path: string) => void;
}

const ZOOM_MIN = 60;
const ZOOM_MAX = 200;
const ZOOM_STEP = 10;

const PERSIAN_REGEX = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g;
const LATIN_REGEX = /[a-zA-Z]/g;

function getDirectionLabel(content?: string): string {
  if (!content) return 'وزیرمتن · جهت‌بندی هوشمند';
  const withoutCode = content.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]+`/g, ' ');
  const faCount = (withoutCode.match(PERSIAN_REGEX) || []).length;
  const enCount = (withoutCode.match(LATIN_REGEX) || []).length;
  if (faCount === 0 && enCount > 0) return 'Latin · چپ‌چین (LTR)';
  if (enCount === 0 && faCount > 0) return 'وزیرمتن · راست‌چین (RTL)';
  if (faCount > 0 && enCount > 0) return 'وزیرمتن · دوزبانه هوشمند (BiDi)';
  return 'جهت‌بندی هوشمند';
}

export const PreviewTab: React.FC<PreviewTabProps> = ({
  selectedItem,
  markdownContent,
  theme = 'dark',
  zoom,
  onZoomChange,
  previewNonce,
  onRefresh,
  onOpenInEditor,
}) => {
  const [viewMode, setViewMode] = useState<'rendered' | 'source'>('rendered');
  const [isLoading, setIsLoading] = useState(true);
  const [preview, setPreview] = useState<PreviewSource | null>(null);

  useEffect(() => {
    if (!selectedItem) return;
    let stale = false;
    setIsLoading(true);
    loadPreviewDocument(selectedItem.path, theme, zoom).then((src) => {
      if (stale) return;
      setPreview(src);
      // A remote iframe settles on its own load event; the inline document is ready at once.
      if (src.kind !== 'url') setIsLoading(false);
    });
    return () => {
      stale = true;
    };
  }, [selectedItem?.path, theme, zoom, previewNonce]);

  if (!selectedItem) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-8 text-center text-muted">
        <FileText className="w-12 h-12 stroke-[1.5] mb-3 text-dim" />
        <p className="text-sm font-medium text-main">سندی انتخاب نشده است</p>
        <p className="text-xs text-muted mt-1 max-w-[240px] leading-relaxed">
          یک فایل را از لیست صف انتخاب کنید تا پیش‌نمایش آن نمایش داده شود.
        </p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-card transition-colors duration-200">
      {/* Slim preview toolbar */}
      <div className="preview-bar flex items-center justify-between gap-3 px-3 h-11 border-b border-main bg-surface transition-colors">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <FileText className="w-4 h-4 text-blue-500 shrink-0" />
          <span
            className="text-xs font-mono font-medium text-main truncate min-w-0"
            dir="ltr"
            title={selectedItem.path}
          >
            {selectedItem.name}
          </span>
          {selectedItem.sizeStr && (
            <span
              className="preview-bar-size text-[11px] text-muted font-mono truncate min-w-0"
              dir="ltr"
              title={selectedItem.sizeStr}
            >
              {selectedItem.sizeStr}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <span className="preview-bar-hint text-[11px] text-dim whitespace-nowrap">
            {getDirectionLabel(markdownContent)}
          </span>

          <div className="h-5 w-px bg-subtle shrink-0" aria-hidden="true" />

          {/* Zoom cluster */}
          <div className="flex items-center bg-subtle rounded border border-main p-0.5 gap-0.5">
            <button
              onClick={() => onZoomChange(Math.max(ZOOM_MIN, zoom - ZOOM_STEP))}
              disabled={zoom <= ZOOM_MIN}
              className="btn p-1 rounded text-muted hover:text-main hover:bg-hover"
              title="کوچک‌نمایی پیش‌نمایش"
              aria-label="کوچک‌نمایی"
            >
              <ZoomOut className="w-3.5 h-3.5" />
            </button>
            <span
              className="text-[11px] font-mono text-main w-11 text-center whitespace-nowrap select-none"
              aria-live="polite"
            >
              {zoom}%
            </span>
            <button
              onClick={() => onZoomChange(Math.min(ZOOM_MAX, zoom + ZOOM_STEP))}
              disabled={zoom >= ZOOM_MAX}
              className="btn p-1 rounded text-muted hover:text-main hover:bg-hover"
              title="بزرگ‌نمایی پیش‌نمایش"
              aria-label="بزرگ‌نمایی"
            >
              <ZoomIn className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* View mode toggle pill */}
          <div className="flex items-center bg-subtle p-0.5 rounded border border-main text-xs gap-0.5">
            <button
              onClick={() => setViewMode('rendered')}
              className={`btn px-2 py-0.5 rounded ${
                viewMode === 'rendered'
                  ? 'bg-blue-600 text-white font-medium'
                  : 'text-muted hover:text-main'
              }`}
              title="پیش‌نمایش سند با فونت وزیرمتن و ساختار کامل"
              aria-pressed={viewMode === 'rendered'}
            >
              <Eye className="w-3.5 h-3.5" />
              <span className="preview-bar-label">پیش‌نمایش</span>
            </button>
            <button
              onClick={() => setViewMode('source')}
              className={`btn px-2 py-0.5 rounded ${
                viewMode === 'source'
                  ? 'bg-blue-600 text-white font-medium'
                  : 'text-muted hover:text-main'
              }`}
              title="مشاهده متن خام مارک‌داون"
              aria-pressed={viewMode === 'source'}
            >
              <Code className="w-3.5 h-3.5" />
              <span className="preview-bar-label">کد منبع</span>
            </button>
          </div>

          <div className="h-5 w-px bg-subtle shrink-0" aria-hidden="true" />

          <button
            onClick={onRefresh}
            className="btn p-1.5 rounded bg-subtle hover:bg-hover text-muted hover:text-main"
            title="بازسازی پیش‌نمایش"
            aria-label="بازسازی پیش‌نمایش"
          >
            <RotateCw className="w-3.5 h-3.5" />
          </button>

          {onOpenInEditor && (
            <Tooltip label="باز کردن محل فایل در اکسپلورر">
              <button
                onClick={() => onOpenInEditor(selectedItem.path)}
                className="btn p-1.5 rounded bg-subtle hover:bg-hover text-muted hover:text-main"
                aria-label="باز کردن در اکسپلورر"
              >
                <ExternalLink className="w-3.5 h-3.5" />
              </button>
            </Tooltip>
          )}
        </div>
      </div>

      {/* Content Rendering Body */}
      <div className="flex-1 overflow-hidden relative">
        {viewMode === 'rendered' ? (
          <>
            {isLoading && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-card text-muted z-10">
                <Loader2 className="w-6 h-6 animate-spin text-blue-500" />
                <span className="text-xs">در حال رندر پیش‌نمایش…</span>
              </div>
            )}
            {preview?.kind === 'error' ? (
              <div className="h-full flex flex-col items-center justify-center gap-2 p-8 text-center">
                <AlertTriangle className="w-8 h-8 text-rose-500" />
                <p className="text-sm font-medium text-main">پیش‌نمایش ساخته نشد</p>
                <p className="text-xs text-muted font-mono max-w-[520px] break-words" dir="ltr">
                  {preview.message}
                </p>
                <button onClick={onRefresh} className="btn mt-2 px-3 py-1.5 rounded text-xs bg-subtle hover:bg-hover text-main">
                  تلاش دوباره
                </button>
              </div>
            ) : (
              <iframe
                key={`${selectedItem.path}-${theme}-${zoom}-${previewNonce}`}
                src={preview?.kind === 'url' ? preview.url : undefined}
                srcDoc={preview?.kind === 'document' ? preview.html : undefined}
                onLoad={() => setIsLoading(false)}
                className="w-full h-full border-0 bg-transparent"
                title={`پیش‌نمایش ${selectedItem.name}`}
              />
            )}
          </>
        ) : (
          <div
            className="h-full overflow-y-auto p-6 font-mono text-xs text-main leading-relaxed text-left whitespace-pre-wrap selection:bg-blue-500/30"
            dir="ltr"
          >
            {markdownContent || '// فایل خالی است یا در حال بارگذاری…'}
          </div>
        )}
      </div>
    </div>
  );
};
