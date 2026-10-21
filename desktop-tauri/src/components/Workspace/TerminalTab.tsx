import React, { useEffect, useRef, useState } from 'react';
import { LogEntry } from '../../types';
import { Copy, Trash2, FolderOpen, Check, AlertCircle } from 'lucide-react';
import { Tooltip } from '../Tooltip';

interface TerminalTabProps {
  logs: LogEntry[];
  onClearLogs: () => void;
  onOpenOutputDir?: () => void;
}

const LEVEL_COLOR: Record<LogEntry['level'], string> = {
  success: 'text-emerald-600 dark:text-emerald-400',
  error: 'text-rose-600 dark:text-rose-400',
  warn: 'text-amber-600 dark:text-amber-400',
  summary: 'text-indigo-600 dark:text-indigo-400 font-semibold',
  info: 'text-main',
};

export const TerminalTab: React.FC<TerminalTabProps> = ({
  logs,
  onClearLogs,
  onOpenOutputDir,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs]);

  useEffect(() => {
    if (copyState === 'idle') return;
    const timer = setTimeout(() => setCopyState('idle'), 2000);
    return () => clearTimeout(timer);
  }, [copyState]);

  const handleCopy = async () => {
    const text = logs
      .map((l) => `[${l.timestamp}] [${l.level.toUpperCase()}] ${l.message}`)
      .join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopyState('copied');
    } catch {
      // Clipboard is unavailable without focus or a secure context; never claim success.
      setCopyState('failed');
    }
  };

  const copyLabel =
    copyState === 'copied' ? 'کپی شد' : copyState === 'failed' ? 'کپی نشد' : 'کپی لاگ‌ها';

  return (
    <div className="h-full flex flex-col bg-card transition-colors duration-200">
      {/* Console toolbar */}
      <div className="flex items-center justify-between gap-2 px-3 h-11 border-b border-main bg-surface transition-colors">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={`w-2 h-2 rounded-full shrink-0 ${
              logs.length ? 'bg-emerald-500' : 'bg-slate-400 dark:bg-slate-600'
            }`}
            aria-hidden="true"
          />
          <span className="text-xs font-mono text-main truncate" dir="ltr">
            fa-md-pdf console
          </span>
          <span className="text-[11px] text-muted font-mono shrink-0">
            {logs.length} خط
          </span>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {onOpenOutputDir && (
            <Tooltip label="باز کردن پوشه خروجی در اکسپلورر">
              <button
                type="button"
                onClick={onOpenOutputDir}
                className="btn px-2 py-1 rounded bg-subtle hover:bg-hover text-main text-xs"
                aria-label="باز کردن پوشه خروجی"
              >
                <FolderOpen className="w-3.5 h-3.5" />
                <span>پوشه خروجی</span>
              </button>
            </Tooltip>
          )}

          <button
            type="button"
            onClick={handleCopy}
            disabled={logs.length === 0}
            className={`btn px-2 py-1 rounded bg-subtle hover:bg-hover text-xs ${
              copyState === 'failed'
                ? 'text-rose-600 dark:text-rose-400'
                : 'text-main hover:text-main'
            }`}
            aria-label={copyLabel}
            aria-live="polite"
          >
            {copyState === 'copied' ? (
              <Check className="w-3.5 h-3.5 text-emerald-500" />
            ) : copyState === 'failed' ? (
              <AlertCircle className="w-3.5 h-3.5" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
            <span>{copyState === 'idle' ? 'کپی' : copyLabel}</span>
          </button>

          <Tooltip label="پاک کردن همهٔ خطوط کنسول">
            <button
              type="button"
              onClick={onClearLogs}
              disabled={logs.length === 0}
              className="btn px-2 py-1 rounded bg-subtle hover:bg-hover text-main text-xs"
              aria-label="پاکسازی کنسول"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>پاکسازی</span>
            </button>
          </Tooltip>
        </div>
      </div>

      {/* Console output: a terminal stays LTR so timestamps and paths read correctly,
          while each message keeps its own bidi shape. */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto p-4 font-mono text-xs leading-5 select-text"
        dir="ltr"
      >
        {logs.length === 0 ? (
          <p className="text-dim italic">
            خروجی‌ای نیست. یک تبدیل را اجرا کن تا لاگ‌ها اینجا ظاهر شوند.
          </p>
        ) : (
          logs.map((log) => (
            <div
              key={log.id}
              className="flex gap-2 items-start py-0.5 rounded hover:bg-subtle transition-colors"
            >
              <span className="text-dim select-none shrink-0 text-[11px]" dir="ltr">
                [{log.timestamp}]
              </span>
              <span
                className={`select-none shrink-0 uppercase text-[11px] min-w-16 ${
                  LEVEL_COLOR[log.level] ?? 'text-main'
                }`}
                dir="ltr"
              >
                [{log.level}]
              </span>
              <span className={`break-words whitespace-pre-wrap ${LEVEL_COLOR[log.level] ?? 'text-main'}`}>
                {log.message}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
