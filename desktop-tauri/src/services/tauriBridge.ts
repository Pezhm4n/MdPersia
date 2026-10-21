import { QueueItem, ConvertOptions, LogEntry, ProgressEvent } from '../types';
import { buildCliArgs } from './cliTranslator';

export const isTauri = (): boolean => {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
};

let activeCancellation = false;

const getTimestamp = (): string => new Date().toLocaleTimeString();

const log = (
  onLog: (e: LogEntry) => void,
  level: LogEntry['level'],
  message: string
): void => onLog({ id: `${level}-${Date.now()}-${Math.random()}`, timestamp: getTimestamp(), level, message });

/**
 * Executes a single conversion job via Vite server streaming endpoint.
 */
async function executeWebConversionJob(
  args: string[],
  onLog: (entry: LogEntry) => void
): Promise<number> {
  const response = await fetch('/api/convert-job', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ args }),
  });

  if (!response.body) {
    throw new Error('ReadableStream not supported');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let exitCode = 0;
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const match = line.match(/^data: (.*)$/m);
      if (!match) continue;
      try {
        const payload = JSON.parse(match[1]);
        if (payload.type === 'stdout') {
          onLog({
            id: `stdout-${Date.now()}-${Math.random()}`,
            timestamp: getTimestamp(),
            level: 'info',
            message: payload.text.trimEnd(),
          });
        } else if (payload.type === 'stderr') {
          onLog({
            id: `stderr-${Date.now()}-${Math.random()}`,
            timestamp: getTimestamp(),
            level: 'warn',
            message: payload.text.trimEnd(),
          });
        } else if (payload.type === 'exit') {
          exitCode = payload.code ?? 0;
        } else if (payload.type === 'error') {
          onLog({
            id: `err-${Date.now()}`,
            timestamp: getTimestamp(),
            level: 'error',
            message: payload.error,
          });
          exitCode = 1;
        }
      } catch {
        // Ignore json parse error
      }
    }
  }

  return exitCode;
}

/**
 * Executes conversion batch with REAL process execution in both Dev and Tauri modes.
 */
export async function executeConversion(
  items: QueueItem[],
  options: ConvertOptions,
  onProgress: (evt: ProgressEvent) => void,
  onLog: (entry: LogEntry) => void
): Promise<void> {
  activeCancellation = false;
  let successCount = 0;
  let failCount = 0;

  onLog({
    id: `log-${Date.now()}-start`,
    timestamp: getTimestamp(),
    level: 'info',
    message: `[START] Starting batch conversion of ${items.length} file(s) (${options.format.toUpperCase()})...`,
  });

  for (let i = 0; i < items.length; i++) {
    if (activeCancellation) {
      onProgress({ type: 'cancelled' });
      onLog({
        id: `log-${Date.now()}-cancelled`,
        timestamp: getTimestamp(),
        level: 'warn',
        message: 'Conversion batch cancelled by user.',
      });
      return;
    }

    const item = items[i];
    const args = buildCliArgs(item, options);

    onProgress({
      type: 'progress',
      file: item.name,
      total: items.length,
      completed: i,
    });

    onLog({
      id: `log-${Date.now()}-cmd`,
      timestamp: getTimestamp(),
      level: 'info',
      message: `fa-md-pdf ${args.join(' ')}`,
    });

    try {
      let code = 0;
      if (isTauri()) {
        const { Command } = await import('@tauri-apps/plugin-shell');
        const cmd = Command.create('fa-md-pdf', args);

        cmd.stdout.on('data', (line: string) => {
          onLog({
            id: `stdout-${Date.now()}-${Math.random()}`,
            timestamp: getTimestamp(),
            level: 'info',
            message: line,
          });
        });

        cmd.stderr.on('data', (line: string) => {
          onLog({
            id: `stderr-${Date.now()}-${Math.random()}`,
            timestamp: getTimestamp(),
            level: 'warn',
            message: line,
          });
        });

        const output = await cmd.execute();
        code = output.code ?? 0;
      } else {
        code = await executeWebConversionJob(args, onLog);
      }

      if (code === 0) {
        successCount++;
        onProgress({
          type: 'success',
          file: item.name,
          destPath: item.path,
        });
        onLog({
          id: `log-${Date.now()}-ok`,
          timestamp: getTimestamp(),
          level: 'success',
          message: `✓ Converted successfully: ${item.name}`,
        });
      } else {
        failCount++;
        onProgress({
          type: 'error',
          file: item.name,
          error: `Process exited with error code ${code}`,
        });
        onLog({
          id: `log-${Date.now()}-err`,
          timestamp: getTimestamp(),
          level: 'error',
          message: `✗ Failed converting ${item.name} (exit code ${code})`,
        });
      }
    } catch (err: any) {
      failCount++;
      onProgress({
        type: 'error',
        file: item.name,
        error: err.message || String(err),
      });
      onLog({
        id: `log-${Date.now()}-fatal`,
        timestamp: getTimestamp(),
        level: 'error',
        message: `Fatal error on ${item.name}: ${err.message}`,
      });
    }
  }

  onProgress({
    type: 'done',
    total: items.length,
    completed: successCount,
  });

  onLog({
    id: `log-${Date.now()}-summary`,
    timestamp: getTimestamp(),
    level: 'summary',
    message: `Batch finished: ${successCount} succeeded, ${failCount} failed.`,
  });
}

export function cancelActiveConversion(): void {
  activeCancellation = true;
}

export interface PickedFile {
  name: string;
  path: string;
  sizeBytes: number;
  sizeStr: string;
}

/** Every native call reports *why* nothing came back, so no control can look dead. */
export interface NativeOutcome<T> {
  value: T;
  cancelled: boolean;
  error?: string;
}

export interface InitialLoad {
  items: QueueItem[];
  /** The document was handed over by the OS or the command line, so open in viewer mode. */
  viewer: boolean;
}

export interface ScannedFile {
  name: string;
  path: string;
  sizeBytes: number;
  relativePath: string;
}

const MARKDOWN = /\.(md|markdown)$/i;

/**
 * Markdown file handed to the process on launch (double-click / `mdpersia --gui file.md`).
 * In the dev/web build the launcher passes it as `?file=`.
 */
export async function resolveStartupFile(): Promise<string | null> {
  const fromQuery = new URLSearchParams(window.location.search).get('file');
  if (fromQuery && MARKDOWN.test(fromQuery)) return fromQuery;

  if (!isTauri()) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const args: string[] = await invoke('startup_arguments');
    return args.find((a) => MARKDOWN.test(a)) ?? null;
  } catch {
    return null;
  }
}

/**
 * Subscribe to files opened while the app is already running (single instance handoff).
 */
export async function onOpenFileRequested(
  handler: (path: string) => void
): Promise<() => void> {
  if (!isTauri()) return () => {};
  try {
    const { listen } = await import('@tauri-apps/api/event');
    const unlisten = await listen<string[]>('open-files', (evt) => {
      const first = (evt.payload || []).find((p) => MARKDOWN.test(p));
      if (first) handler(first);
    });
    return unlisten;
  } catch {
    return () => {};
  }
}

/**
 * Read raw markdown text from disk for live preview.
 */
export async function readFileContent(filePath: string): Promise<NativeOutcome<string>> {
  if (isTauri()) {
    try {
      const { readTextFile } = await import('@tauri-apps/plugin-fs');
      return { value: await readTextFile(filePath), cancelled: false };
    } catch (err: any) {
      return { value: '', cancelled: false, error: err.message || String(err) };
    }
  }

  try {
    const res = await fetch('/api/read-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath }),
    });
    const data = await res.json();
    return data.ok
      ? { value: data.content, cancelled: false }
      : { value: '', cancelled: false, error: data.error || 'File not readable' };
  } catch (err: any) {
    return { value: '', cancelled: false, error: err.message || String(err) };
  }
}

async function statFiles(paths: string[]): Promise<PickedFile[]> {
  if (isTauri()) {
    const { stat } = await import('@tauri-apps/plugin-fs');
    const out: PickedFile[] = [];
    for (const p of paths) {
      let size = 0;
      try {
        size = (await stat(p)).size ?? 0;
      } catch {
        // Unreadable size must not block adding the file to the queue.
      }
      out.push({
        name: p.replace(/^.*[\\/]/, ''),
        path: p.replace(/\\/g, '/'),
        sizeBytes: size,
        sizeStr: `${(size / 1024).toFixed(1)} KB`,
      });
    }
    return out;
  }
  return paths.map((p) => ({
    name: p.replace(/^.*[\\/]/, ''),
    path: p.replace(/\\/g, '/'),
    sizeBytes: 0,
    sizeStr: '',
  }));
}

/**
 * Pick a directory via native Windows folder dialog.
 */
export async function pickDirectory(title?: string): Promise<NativeOutcome<string | null>> {
  const label = title || 'انتخاب پوشه';
  if (isTauri()) {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({ directory: true, multiple: false, title: label });
      return {
        value: typeof selected === 'string' ? selected : null,
        cancelled: selected === null,
      };
    } catch (err: any) {
      return { value: null, cancelled: false, error: err.message || String(err) };
    }
  }

  try {
    const res = await fetch(`/api/pick-folder?title=${encodeURIComponent(label)}`);
    const data = await res.json();
    if (data.error) return { value: null, cancelled: false, error: data.error };
    return { value: data.path ? String(data.path) : null, cancelled: !!data.cancelled };
  } catch (err: any) {
    return { value: null, cancelled: false, error: err.message || String(err) };
  }
}

/**
 * Pick multiple files via native Windows file dialog.
 */
export async function pickFiles(
  filterExts?: string[],
  title?: string
): Promise<NativeOutcome<PickedFile[]>> {
  if (isTauri()) {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({
        directory: false,
        multiple: true,
        filters: filterExts ? [{ name: 'Allowed Files', extensions: filterExts }] : undefined,
        title: title || 'انتخاب فایل',
      });
      const list = Array.isArray(selected) ? selected : typeof selected === 'string' ? [selected] : [];
      return { value: await statFiles(list), cancelled: list.length === 0 };
    } catch (err: any) {
      return { value: [], cancelled: false, error: err.message || String(err) };
    }
  }

  try {
    const params = new URLSearchParams();
    if (filterExts?.length) params.set('exts', filterExts.join(','));
    if (title) params.set('title', title);
    const res = await fetch(`/api/pick-files?${params.toString()}`);
    const data = await res.json();
    if (data.error) return { value: [], cancelled: false, error: data.error };
    if (Array.isArray(data.files) && data.files.length > 0 && typeof data.files[0].sizeBytes === 'number') {
      return { value: data.files, cancelled: !!data.cancelled };
    }
    return {
      value: await statFiles((data.files || []).map((f: { path: string }) => f.path)),
      cancelled: !!data.cancelled,
    };
  } catch (err: any) {
    return { value: [], cancelled: false, error: err.message || String(err) };
  }
}

/**
 * Scan a folder for Markdown files. A failed scan is reported as an error so the UI
 * never calls it "no markdown in this folder".
 */
export async function scanFolder(
  folderPath: string,
  recursive: boolean = true
): Promise<NativeOutcome<ScannedFile[]>> {
  try {
    const res = await fetch('/api/scan-folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderPath, recursive }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { value: [], cancelled: false, error: data.error || `HTTP ${res.status}` };
    }
    return { value: Array.isArray(data.files) ? data.files : [], cancelled: false };
  } catch (err: any) {
    return { value: [], cancelled: false, error: err.message || String(err) };
  }
}

/**
 * Open a directory (or reveal a file) in Windows Explorer.
 */
export async function openInExplorer(targetPath: string): Promise<NativeOutcome<boolean>> {
  const p = (targetPath || '').trim();
  if (!p) return { value: false, cancelled: false, error: 'مسیر هدف خالی است.' };

  if (isTauri()) {
    try {
      const { Command } = await import('@tauri-apps/plugin-shell');
      const winPath = p.replace(/\//g, '\\');
      const isFile = /\.[a-zA-Z0-9]+$/.test(winPath);
      const args = isFile ? [`/select,${winPath}`] : [winPath];
      await Command.create('explorer', args).execute();
      return { value: true, cancelled: false };
    } catch (err: any) {
      return { value: false, cancelled: false, error: err.message || String(err) };
    }
  }

  try {
    const res = await fetch('/api/open-folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetPath: p }),
    });
    const data = await res.json().catch(() => ({}));
    return data.success
      ? { value: true, cancelled: false }
      : { value: false, cancelled: false, error: data.error || 'اکسپلورر باز نشد.' };
  } catch (err: any) {
    return { value: false, cancelled: false, error: err.message || String(err) };
  }
}

/**
 * Fetch initial queue items dynamically from backend.
 * `file` lets the OS double-click handoff target a specific document.
 */
export async function fetchInitialItems(file?: string | null): Promise<InitialLoad> {
  if (isTauri()) {
    // The packaged app has no dev server to ask; the handed path is the whole queue.
    if (!file) return { items: [], viewer: false };
    return { items: [await queueItemFromPath(file)], viewer: true };
  }

  try {
    const q = file ? `?file=${encodeURIComponent(file)}` : '';
    const res = await fetch(`/api/initial-items${q}`);
    const data = await res.json();
    // The dev endpoint marks handoffs passed through the environment instead of the URL,
    // so viewer mode survives `mdpersia --gui file.md` without a second click.
    return { items: Array.isArray(data.items) ? data.items : [], viewer: !!data.viewer };
  } catch {
    return { items: [], viewer: false };
  }
}

async function queueItemFromPath(filePath: string): Promise<QueueItem> {
  let sizeBytes = 0;
  try {
    const { stat } = await import('@tauri-apps/plugin-fs');
    sizeBytes = (await stat(filePath)).size ?? 0;
  } catch {
    // An unreadable size must not stop the document from opening.
  }
  const name = filePath.replace(/^.*[\\/]/, '');
  return {
    id: 'open-0',
    name,
    path: filePath.replace(/\\/g, '/'),
    sizeBytes,
    sizeStr: `${(sizeBytes / 1024).toFixed(1)} KB`,
    status: 'pending',
    relativePath: name,
  };
}

export const previewEndpointUrl = (path: string, theme: string, zoom: number): string =>
  `/api/preview-html?path=${encodeURIComponent(path)}&theme=${theme}&zoom=${zoom}`;

const VAZIRMATN_WEIGHTS: Record<string, number> = {
  Thin: 100, Light: 300, Regular: 400, Medium: 500, SemiBold: 600, Bold: 700,
};

/** Viewer chrome shared by both runtimes; assets resolve against the app origin. */
function viewerShellCss(zoom: number, theme: string): string {
  const faces = Object.entries(VAZIRMATN_WEIGHTS)
    .map(
      ([name, weight]) =>
        `@font-face { font-family: "Vazirmatn"; src: url("/fonts/Vazirmatn-${name}.ttf") format("truetype"); font-weight: ${weight}; font-style: normal; font-display: swap; }`
    )
    .join('\n');
  const dark =
    theme === 'dark'
      ? `body, .markdown-body { background-color: #121214 !important; color: #e4e4e7 !important; }
         h1,h2,h3,h4,h5,h6 { color: #fafafa !important; }
         code { background: #27272a !important; color: #f43f5e !important; }
         pre { background: #18181b !important; }
         table th { background: #1f1f23 !important; color: #f4f4f5 !important; }
         table td { background: #121214 !important; color: #e4e4e7 !important; }
         blockquote { background: #1e1e24 !important; color: #d4d4d8 !important; }
         .mermaid { filter: invert(0.88) hue-rotate(180deg); }`
      : '';
  return `<style>${faces}
    html { zoom: ${zoom}%; }
    html, body { margin: 0; padding: 0; }
    .markdown-body { padding: 36px 44px !important; max-width: 860px !important;
      margin: 0 auto !important; box-sizing: border-box !important; min-height: 100vh; }
    img { max-width: 100%; height: auto; }
    ${dark}</style>`;
}

export type PreviewSource =
  | { kind: 'url'; url: string }
  | { kind: 'document'; html: string }
  | { kind: 'error'; message: string };

/**
 * The dev runtime streams preview HTML from the local bridge; the packaged app has no
 * server, so it asks the Rust command and hands the result to the iframe directly.
 */
export async function loadPreviewDocument(
  path: string,
  theme: 'dark' | 'light',
  zoom: number
): Promise<PreviewSource> {
  const pct = Math.min(250, Math.max(50, Math.round(zoom)));
  if (!isTauri()) return { kind: 'url', url: previewEndpointUrl(path, theme, pct) };

  try {
    const { invoke, convertFileSrc } = await import('@tauri-apps/api/core');
    const { html } = await invoke<{ html: string }>('preview_html', {
      request: { path, theme, zoom: pct },
    });
    // A webview cannot load file://; route local assets through the asset protocol.
    const mapped = html.replace(/file:\/\/([^"')\s]+)/g, (_m, raw: string) => {
      const p = decodeURIComponent(raw).replace(/^\/([A-Za-z]:)/, '$1');
      const name = p.split(/[\\/]/).pop() || '';
      if (/\.ttf$/i.test(name)) return `/fonts/${name}`;
      if (/mermaid.*\.js$/i.test(name)) return `/vendor/${name}`;
      return convertFileSrc(p);
    });
    return { kind: 'document', html: mapped.replace('</head>', `${viewerShellCss(pct, theme)}</head>`) };
  } catch (err: any) {
    return { kind: 'error', message: err?.message || String(err) };
  }
}

export type { LogEntry };
export { log as pushLog };
