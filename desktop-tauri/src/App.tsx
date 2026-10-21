import React, { useState, useEffect, useCallback, useRef } from 'react';
import { QueueItem, ConvertOptions, LogEntry, ProgressEvent } from './types';
import { DEFAULT_CONVERT_OPTIONS } from './services/cliTranslator';
import {
  executeConversion,
  cancelActiveConversion,
  pickDirectory,
  pickFiles,
  scanFolder,
  openInExplorer,
  readFileContent,
  fetchInitialItems,
  resolveStartupFile,
  onOpenFileRequested,
  isTauri,
} from './services/tauriBridge';
import { handOffToRunningInstance, listenForHandoffs } from './services/singleInstance';
import { Header } from './components/Header';
import { StatusBar } from './components/StatusBar';
import { QueuePanel } from './components/QueuePanel';
import { InspectorPanel } from './components/InspectorPanel';
import { WorkspacePanel } from './components/WorkspacePanel';
import { PaneSplitter } from './components/PaneSplitter';

type NativeBusy = 'files' | 'folder' | 'output-dir' | 'explorer' | null;
type WorkspaceTab = 'preview' | 'terminal';

const QUEUE_MIN = 300;
const QUEUE_MAX = 640;
const INSPECTOR_MIN = 300;
const INSPECTOR_MAX = 720;

/** Below 1280px the three panes cannot all sit at their comfortable widths. */
const compactViewport = () =>
  typeof window !== 'undefined' && window.innerWidth < 1280;
const queueDefault = () => (compactViewport() ? 320 : 380);
const inspectorDefault = () => (compactViewport() ? 340 : 400);

const storedWidth = (key: string, fallback: number, min: number, max: number): number => {
  try {
    const raw = parseInt(localStorage.getItem(key) || '', 10);
    return Number.isFinite(raw) ? Math.max(min, Math.min(max, raw)) : fallback;
  } catch {
    return fallback;
  }
};

const storeWidth = (key: string, value: number): void => {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Storage may be unavailable; the width still applies for this session.
  }
};

export const App: React.FC = () => {
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    try {
      const saved = localStorage.getItem('theme');
      return saved === 'light' || saved === 'dark' ? saved : 'dark';
    } catch {
      return 'dark';
    }
  });

  const [queueWidth, setQueueWidth] = useState<number>(() =>
    storedWidth('pane_queue_width_v2', queueDefault(), QUEUE_MIN, QUEUE_MAX)
  );
  const [inspectorWidth, setInspectorWidth] = useState<number>(() =>
    storedWidth('pane_inspector_width', inspectorDefault(), INSPECTOR_MIN, INSPECTOR_MAX)
  );

  const [items, setItems] = useState<QueueItem[]>([]);
  const [activeFolder, setActiveFolder] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [options, setOptions] = useState<ConvertOptions>(DEFAULT_CONVERT_OPTIONS);
  const [markdownContent, setMarkdownContent] = useState<string>('');
  const [query, setQuery] = useState('');
  const [nativeBusy, setNativeBusy] = useState<NativeBusy>(null);
  const [handedOff, setHandedOff] = useState<string | null>(null);
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>('preview');
  const [zoom, setZoom] = useState(100);
  const [previewNonce, setPreviewNonce] = useState(0);

  const appendLog = useCallback((level: LogEntry['level'], message: string) => {
    setLogs((prev) => [
      ...prev,
      { id: `${level}-${Date.now()}-${Math.random()}`, timestamp: new Date().toLocaleTimeString(), level, message },
    ]);
  }, []);

  const [logs, setLogs] = useState<LogEntry[]>([
    {
      id: 'init-1',
      timestamp: new Date().toLocaleTimeString(),
      level: 'info',
      message: 'محیط کاری MdPersia با موتور تبدیل واقعی آماده به کار است.',
    },
  ]);
  const [isRunning, setIsRunning] = useState(false);
  const [progressPercent, setProgressPercent] = useState(0);
  const [completedCount, setCompletedCount] = useState(0);
  const [statusMessage, setStatusMessage] = useState('آماده به کار');

  const itemsRef = useRef(items);
  itemsRef.current = items;

  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    try {
      localStorage.setItem('theme', theme);
    } catch {
      // Ignore
    }
  }, [theme]);

  /** Load the document the OS handed us (double-click / open-with), else the repo docs. */
  const loadDocuments = useCallback(async (file: string | null, viaViewer: boolean) => {
    const { items: initial, viewer } = await fetchInitialItems(file);
    if (initial.length === 0) {
      setStatusMessage('سندی برای باز شدن پیدا نشد.');
      return;
    }
    setItems(initial);
    setSelectedIds(new Set([initial[0].id]));
    if (viaViewer || viewer) {
      setWorkspaceTab('preview');
      setStatusMessage(`«${initial[0].name}» در حالت مشاهده‌گر باز شد.`);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    resolveStartupFile()
      .then(async (file) => {
        if (cancelled) return;
        // A second browser launch should not duplicate the work of the first one.
        if (file && !isTauri() && (await handOffToRunningInstance(file))) {
          setHandedOff(file);
          return;
        }
        loadDocuments(file, !!file);
      })
      .catch(() => loadDocuments(null, false));
    return () => {
      cancelled = true;
    };
  }, [loadDocuments]);

  /** Single instance: a second launch routes its file into this running window. */
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const disposeBrowser = listenForHandoffs((path) => {
      loadDocuments(path, true);
      appendLog('info', `Open-with handoff: ${path}`);
    });
    onOpenFileRequested((path) => {
      loadDocuments(path, true);
      appendLog('info', `Open-with handoff: ${path}`);
    }).then((dispose) => {
      if (unlisten === undefined) unlisten = dispose;
      else dispose();
    });
    return () => {
      disposeBrowser();
      unlisten?.();
    };
  }, [loadDocuments, appendLog]);

  const selectedItem = items.find((it) => selectedIds.has(it.id)) || null;

  useEffect(() => {
    if (!selectedItem?.path) {
      setMarkdownContent('');
      return;
    }
    let stale = false;
    readFileContent(selectedItem.path).then((res) => {
      if (stale) return;
      setMarkdownContent(res.value);
      if (res.error) appendLog('warn', `خواندن فایل ناموفق بود (${selectedItem.name}): ${res.error}`);
    });
    return () => {
      stale = true;
    };
  }, [selectedItem?.path, appendLog]);

  const handleToggleTheme = () => setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));

  const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

  const handleResizeQueue = useCallback((delta: number) => {
    setQueueWidth((prev) => {
      const next = clamp(prev + delta, QUEUE_MIN, QUEUE_MAX);
      storeWidth('pane_queue_width_v2', next);
      return next;
    });
  }, []);

  const handleResizeInspector = useCallback((delta: number) => {
    setInspectorWidth((prev) => {
      const next = clamp(prev + delta, INSPECTOR_MIN, INSPECTOR_MAX);
      storeWidth('pane_inspector_width', next);
      return next;
    });
  }, []);

  const handleOptionChange = <K extends keyof ConvertOptions>(
    key: K,
    value: ConvertOptions[K]
  ) => {
    setOptions((prev) => ({ ...prev, [key]: value }));
  };

  /**
   * Reactively update items queue when recursive option toggles.
   */
  const handleRecursiveToggle = async (newRecursive: boolean) => {
    setOptions((prev) => ({ ...prev, recursive: newRecursive }));

    if (activeFolder) {
      const scan = await scanFolder(activeFolder, newRecursive);
      if (scan.error) {
        appendLog('error', `Folder scan failed: ${scan.error}`);
        setStatusMessage('پیمایش پوشه انجام نشد؛ جزئیات در کنسول.');
        return;
      }
      const newItems: QueueItem[] = scan.value.map((f, idx) => ({
        id: `scanned-${Date.now()}-${idx}`,
        name: f.name,
        path: f.path,
        sizeBytes: f.sizeBytes,
        sizeStr: `${(f.sizeBytes / 1024).toFixed(1)} KB`,
        status: 'pending',
        relativePath: f.relativePath,
      }));
      setItems(newItems);
      if (newItems.length > 0) setSelectedIds(new Set([newItems[0].id]));
      setStatusMessage(
        newRecursive
          ? `پیمایش بازگشتی فعال شد: ${newItems.length} سند در صف (شامل زیرپوشه‌ها)`
          : `پیمایش زیرپوشه‌ها غیرفعال شد: ${newItems.length} سند در صف (فقط پوشه اصلی)`
      );
    } else if (!newRecursive) {
      setItems((prev) =>
        prev.filter((it) => !it.relativePath || !it.relativePath.includes('/'))
      );
    }
  };

  const handleSelectItem = (id: string, e: React.MouseEvent) => {
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(selectedIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setSelectedIds(next);
    } else {
      setSelectedIds(new Set([id]));
    }
  };

  const appendItems = (newItems: QueueItem[], message: string) => {
    setItems((prev) => [...prev, ...newItems]);
    if (newItems.length > 0) setSelectedIds(new Set([newItems[newItems.length - 1].id]));
    setStatusMessage(message);
  };

  const handleAddFiles = (files: FileList | File[]) => {
    const newItems: QueueItem[] = Array.from(files).map((file, idx) => ({
      id: `file-${Date.now()}-${idx}`,
      name: file.name,
      path: (file as File & { path?: string }).path || file.name,
      sizeBytes: file.size,
      sizeStr: `${(file.size / 1024).toFixed(1)} KB`,
      status: 'pending',
    }));
    appendItems(newItems, `${newItems.length} فایل کشیده‌شده به صف افزوده شد.`);
  };

  /**
   * Native pickers always end in a visible outcome: added / cancelled / failed.
   * A silent no-op is what made these controls look dead.
   */
  const handlePickFilesNative = async () => {
    if (nativeBusy) return;
    setNativeBusy('files');
    setStatusMessage('در انتظار انتخاب فایل… دیالوگ ویندوز را ببینید');
    try {
      const res = await pickFiles(['md', 'markdown'], 'انتخاب اسناد مارک‌داون');
      if (res.error) {
        appendLog('error', `File picker failed: ${res.error}`);
        setStatusMessage('دیالوگ انتخاب فایل باز نشد؛ جزئیات در کنسول.');
        return;
      }
      if (res.cancelled || res.value.length === 0) {
        setStatusMessage('انتخاب فایل لغو شد.');
        return;
      }
      appendItems(
        res.value.map((f, idx) => ({
          id: `native-${Date.now()}-${idx}`,
          name: f.name,
          path: f.path,
          sizeBytes: f.sizeBytes,
          sizeStr: f.sizeStr,
          status: 'pending' as const,
          relativePath: f.name,
        })),
        `${res.value.length} فایل از ویندوز به صف افزوده شد.`
      );
    } catch (err: any) {
      appendLog('error', `File picker error: ${err.message || String(err)}`);
      setStatusMessage('خطایی در انتخاب فایل رخ داد.');
    } finally {
      setNativeBusy(null);
    }
  };

  const handleAddFolder = async () => {
    if (nativeBusy) return;
    setNativeBusy('folder');
    setStatusMessage('در انتظار انتخاب پوشه… دیالوگ ویندوز را ببینید');
    try {
      const picked = await pickDirectory('انتخاب پوشه حاوی اسناد');
      if (picked.error) {
        appendLog('error', `Folder picker failed: ${picked.error}`);
        setStatusMessage('دیالوگ انتخاب پوشه باز نشد؛ جزئیات در کنسول.');
        return;
      }
      if (!picked.value) {
        setStatusMessage('انتخاب پوشه لغو شد.');
        return;
      }

      // Scanning runs against the local bridge and can take a moment on large trees.
      const folder = picked.value;
      const scan = await scanFolder(folder, options.recursive);
      setActiveFolder(folder);

      if (scan.error) {
        appendLog('error', `Folder scan failed: ${scan.error}`);
        setStatusMessage('پیمایش پوشه انجام نشد؛ جزئیات در کنسول.');
        return;
      }

      const newItems: QueueItem[] = scan.value.map((f, idx) => ({
        id: `scanned-${Date.now()}-${idx}`,
        name: f.name,
        path: f.path,
        sizeBytes: f.sizeBytes,
        sizeStr: `${(f.sizeBytes / 1024).toFixed(1)} KB`,
        status: 'pending',
        relativePath: f.relativePath,
      }));
      if (newItems.length === 0) {
        setStatusMessage('پوشه انتخاب شد اما فایل مارک‌داونی در آن یافت نشد.');
        return;
      }
      setItems(newItems);
      setSelectedIds(new Set([newItems[0].id]));
      setStatusMessage(`${newItems.length} سند مارک‌داون از پوشه بارگذاری شد.`);
    } catch (err: any) {
      appendLog('error', `Folder picker error: ${err.message || String(err)}`);
      setStatusMessage('خطایی در انتخاب پوشه رخ داد.');
    } finally {
      setNativeBusy(null);
    }
  };

  const handleBrowseOutputDir = async () => {
    if (nativeBusy) return;
    setNativeBusy('output-dir');
    setStatusMessage('در انتظار انتخاب پوشه خروجی…');
    try {
      const picked = await pickDirectory('انتخاب پوشه خروجی اسناد');
      if (picked.error) {
        appendLog('error', `Output folder picker failed: ${picked.error}`);
        setStatusMessage('دیالوگ انتخاب پوشه خروجی باز نشد.');
        return;
      }
      if (!picked.value) {
        setStatusMessage('انتخاب پوشه خروجی لغو شد.');
        return;
      }
      handleOptionChange('outputDir', picked.value);
      setStatusMessage(`پوشه خروجی تنظیم شد: ${picked.value}`);
    } catch (err: any) {
      appendLog('error', `Output folder picker error: ${err.message || String(err)}`);
      setStatusMessage('خطایی در انتخاب پوشه خروجی رخ داد.');
    } finally {
      setNativeBusy(null);
    }
  };

  const handleOpenOutputDir = async () => {
    let target = options.outputDir || activeFolder || selectedItem?.path || '';
    if (!target) {
      setStatusMessage('پوشه‌ای برای باز کردن وجود ندارد؛ ابتدا یک سند یا پوشه انتخاب کنید.');
      return;
    }
    // If target is a file, reveal its directory
    if (/\.[a-zA-Z0-9]+$/.test(target)) {
      target = target.replace(/[\\/][^\\/]+$/, '') || '.';
      if (/^[A-Za-z]:$/.test(target)) target += '/';
    }
    if (nativeBusy) return;
    setNativeBusy('explorer');
    try {
      const res = await openInExplorer(target);
      if (res.error) {
        appendLog('error', `Explorer failed for ${target}: ${res.error}`);
        setStatusMessage('باز کردن ویندوز اکسپلورر ناموفق بود.');
        return;
      }
      setStatusMessage('در ویندوز اکسپلورر باز شد.');
    } catch (err: any) {
      appendLog('error', `Explorer error: ${err.message || String(err)}`);
      setStatusMessage('خطایی در باز کردن اکسپلورر رخ داد.');
    } finally {
      setNativeBusy(null);
    }
  };

  const handleBrowseFile = async (key: keyof ConvertOptions, filter?: string) => {
    if (nativeBusy) return;
    setNativeBusy('files');
    setStatusMessage('در انتظار انتخاب فایل… دیالوگ ویندوز را ببینید');
    try {
      const exts = filter ? filter.split(',').map((e) => e.trim().replace(/^\./, '')) : undefined;
      const res = await pickFiles(exts && exts.length ? exts : undefined, 'انتخاب فایل');
      if (res.error) {
        appendLog('error', `File picker failed: ${res.error}`);
        setStatusMessage('دیالوگ انتخاب فایل باز نشد.');
        return;
      }
      if (res.cancelled || res.value.length === 0) {
        setStatusMessage('انتخاب فایل لغو شد.');
        return;
      }
      handleOptionChange(key, res.value[0].path);
      setStatusMessage(`«${String(key)}» تنظیم شد: ${res.value[0].name}`);
    } catch (err: any) {
      appendLog('error', `File browse error: ${err.message || String(err)}`);
      setStatusMessage('خطایی در انتخاب فایل رخ داد.');
    } finally {
      setNativeBusy(null);
    }
  };

  const handleBrowseDir = async (key: keyof ConvertOptions) => {
    if (nativeBusy) return;
    setNativeBusy('folder');
    setStatusMessage('در انتظار انتخاب پوشه… دیالوگ ویندوز را ببینید');
    try {
      const picked = await pickDirectory();
      if (picked.error) {
        appendLog('error', `Folder picker failed: ${picked.error}`);
        setStatusMessage('دیالوگ انتخاب پوشه باز نشد.');
        return;
      }
      if (!picked.value) {
        setStatusMessage('انتخاب پوشه لغو شد.');
        return;
      }
      handleOptionChange(key, picked.value);
      setStatusMessage(`پوشه تنظیم شد: ${picked.value}`);
    } catch (err: any) {
      appendLog('error', `Dir browse error: ${err.message || String(err)}`);
      setStatusMessage('خطایی در انتخاب پوشه رخ داد.');
    } finally {
      setNativeBusy(null);
    }
  };

  const handleRemoveSelected = () => {
    setItems((prev) => prev.filter((it) => !selectedIds.has(it.id)));
    setSelectedIds(new Set());
  };

  const handleClearAll = () => {
    setItems([]);
    setSelectedIds(new Set());
    setActiveFolder(null);
    setStatusMessage('صف پاک شد.');
  };

  const handleClearLogs = () => setLogs([]);

  const handleConvert = async () => {
    if (items.length === 0 || isRunning) return;
    setIsRunning(true);
    setProgressPercent(0);
    setCompletedCount(0);
    setStatusMessage(`درحال تبدیل ${items.length} سند با موتور MdPersia...`);

    setItems((prev) => prev.map((it) => ({ ...it, status: 'pending', error: undefined })));

    await executeConversion(
      items,
      options,
      (evt: ProgressEvent) => {
        if (evt.type === 'progress') {
          const comp = evt.completed || 0;
          const tot = evt.total || items.length;
          setCompletedCount(comp);
          setProgressPercent(Math.round((comp / tot) * 100));
          if (evt.file) {
            setItems((prev) =>
              prev.map((it) => (it.name === evt.file ? { ...it, status: 'running' } : it))
            );
          }
        } else if (evt.type === 'success') {
          if (evt.file) {
            setItems((prev) =>
              prev.map((it) => (it.name === evt.file ? { ...it, status: 'success' } : it))
            );
          }
        } else if (evt.type === 'error') {
          if (evt.file) {
            setItems((prev) =>
              prev.map((it) =>
                it.name === evt.file ? { ...it, status: 'error', error: evt.error } : it
              )
            );
          }
        } else if (evt.type === 'done') {
          setProgressPercent(100);
          const succ = evt.completed ?? 0;
          const tot = evt.total ?? items.length;
          setStatusMessage(`فرآیند تبدیل پایان یافت: ${succ} موفق، ${tot - succ} ناموفق.`);
        } else if (evt.type === 'cancelled') {
          setStatusMessage('عملیات تبدیل توسط کاربر لغو گردید.');
        }
      },
      (log: LogEntry) => setLogs((prev) => [...prev, log])
    );

    setIsRunning(false);
  };

  const handleCancel = () => {
    cancelActiveConversion();
    setIsRunning(false);
    setStatusMessage('توقف درخواست شد.');
  };

  const revealInExplorer = async (targetPath: string) => {
    const res = await openInExplorer(targetPath);
    if (res.error) {
      appendLog('error', `Explorer failed for ${targetPath}: ${res.error}`);
      setStatusMessage(`باز کردن اکسپلورر ناموفق بود: ${res.error}`);
    } else {
      setStatusMessage('در ویندوز اکسپلورر باز شد.');
    }
  };

  const revealFolderInExplorer = async (filePath: string) => {
    let folder = filePath.replace(/[\\/][^\\/]+$/, '');
    if (!folder || folder === filePath) folder = '.';
    if (/^[A-Za-z]:$/.test(folder)) folder += '/';
    await revealInExplorer(folder);
  };

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-app text-main transition-colors duration-200">
      <Header theme={theme} onToggleTheme={handleToggleTheme} isBusy={!!nativeBusy || isRunning} />

      {handedOff && (
        <div className="shrink-0 flex items-center justify-between gap-3 px-4 h-10 text-xs bg-blue-500/10 border-b border-blue-500/30 text-blue-700 dark:text-blue-300">
          <span className="truncate min-w-0">
            «{handedOff.split(/[\\/]/).pop()}» در پنجره‌ای که از قبل باز بود نمایش داده شد.
          </span>
          <button
            type="button"
            className="btn px-2 py-1 rounded hover:bg-blue-500/15 shrink-0"
            onClick={() => {
              loadDocuments(handedOff, true);
              setHandedOff(null);
            }}
          >
            باز کردن در همین تب
          </button>
        </div>
      )}

      <main className="flex-1 flex overflow-hidden relative">
        {/* Zone A: Document Batch Queue (Right-most in RTL) */}
        <section
          style={{ width: `${queueWidth}px` }}
          className="h-full shrink-0 overflow-hidden"
        >
          <QueuePanel
            items={items}
            selectedIds={selectedIds}
            recursive={options.recursive}
            query={query}
            onQueryChange={setQuery}
            nativeBusy={nativeBusy}
            onRecursiveChange={handleRecursiveToggle}
            onSelect={handleSelectItem}
            onAddFiles={handleAddFiles}
            onPickFilesNative={handlePickFilesNative}
            onAddFolder={handleAddFolder}
            onRemoveSelected={handleRemoveSelected}
            onClearAll={handleClearAll}
            onOpenFile={revealInExplorer}
            onRevealFolder={revealFolderInExplorer}
          />
        </section>

        <PaneSplitter
          onResize={handleResizeQueue}
          onReset={() => {
            const w = queueDefault();
            setQueueWidth(w);
            storeWidth('pane_queue_width_v2', w);
          }}
          title="تغییر عرض ستون صف (بکشید / دوبار کلیک برای ریست)"
        />

        {/* Zone B: Parameters Inspector (Middle in RTL) */}
        <section
          style={{ width: `${inspectorWidth}px` }}
          className="h-full shrink-0 overflow-hidden"
        >
          <InspectorPanel
            options={options}
            isRunning={isRunning}
            outputDirBusy={nativeBusy === 'output-dir'}
            onOptionsChange={(key, value) => {
              if (key === 'recursive') handleRecursiveToggle(Boolean(value));
              else handleOptionChange(key, value);
            }}
            onConvert={handleConvert}
            onCancel={handleCancel}
            onBrowseOutputDir={handleBrowseOutputDir}
            onOpenOutputDir={handleOpenOutputDir}
            onBrowseFile={handleBrowseFile}
            onBrowseDir={handleBrowseDir}
          />
        </section>

        <PaneSplitter
          onResize={handleResizeInspector}
          onReset={() => {
            const w = inspectorDefault();
            setInspectorWidth(w);
            storeWidth('pane_inspector_width', w);
          }}
          title="تغییر عرض پنل تنظیمات (بکشید / دوبار کلیک برای ریست)"
        />

        {/* Zone C: Workspace Preview & Terminal (Left-most in RTL) */}
        <section className="flex-1 min-w-[320px] h-full overflow-hidden">
          <WorkspacePanel
            selectedItem={selectedItem}
            markdownContent={markdownContent}
            logs={logs}
            isRunning={isRunning}
            theme={theme}
            activeTab={workspaceTab}
            onTabChange={setWorkspaceTab}
            zoom={zoom}
            onZoomChange={setZoom}
            previewNonce={previewNonce}
            onRefreshPreview={() => setPreviewNonce((n) => n + 1)}
            onClearLogs={handleClearLogs}
            onOpenOutputDir={handleOpenOutputDir}
            onOpenInEditor={revealInExplorer}
          />
        </section>
      </main>

      <StatusBar
        statusMessage={statusMessage}
        progressPercent={progressPercent}
        isRunning={isRunning}
        totalItems={items.length}
        completedItems={completedCount}
      />
    </div>
  );
};

export default App;
