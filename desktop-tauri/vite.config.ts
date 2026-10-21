import { defineConfig, Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import { spawn, execFile } from 'child_process';
import fs from 'fs';

const projectRoot = path.resolve(__dirname, '..');
const fontsDir = path.join(projectRoot, 'fonts');
const vendorDir = path.join(projectRoot, 'vendor');

/**
 * Bundled Vazirmatn weights are served from /fonts in dev and copied into dist at build,
 * so the app shell never depends on a CDN (offline viewer requirement).
 */
const FONT_WEIGHTS: Record<string, number> = {
  'Vazirmatn-Thin.ttf': 100,
  'Vazirmatn-ExtraLight.ttf': 200,
  'Vazirmatn-Light.ttf': 300,
  'Vazirmatn-Regular.ttf': 400,
  'Vazirmatn-Medium.ttf': 500,
  'Vazirmatn-SemiBold.ttf': 600,
  'Vazirmatn-Bold.ttf': 700,
  'Vazirmatn-ExtraBold.ttf': 800,
  'Vazirmatn-Black.ttf': 900,
};

function fontFaceCss(): string {
  return Object.entries(FONT_WEIGHTS)
    .map(
      ([file, weight]) =>
        `@font-face { font-family: "Vazirmatn"; src: url("/fonts/${file}") format("truetype"); font-weight: ${weight}; font-style: normal; font-display: swap; }`
    )
    .join('\n');
}

type Picker = 'files' | 'folder';

/**
 * Windows native picker. The script travels as UTF-16LE base64 through -EncodedCommand so
 * cmd.exe cannot damage its quoting, and it always answers ok / cancelled / error so the
 * caller can report an outcome instead of leaving the button looking dead.
 */
function pickerScript(kind: Picker, title: string, filter: string): string {
  const safe = title.replace(/'/g, "''");
  // FolderBrowserDialog only has Description; OpenFileDialog only has Title.
  const dialog =
    kind === 'folder'
      ? `$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = '${safe}'
$d.ShowNewFolderButton = $true`
      : `$d = New-Object System.Windows.Forms.OpenFileDialog
$d.Multiselect = $true
$d.Title = '${safe}'
$d.Filter = '${filter.replace(/'/g, "''")}'`;
  const result =
    kind === 'folder'
      ? `if ($d.SelectedPath) { [Console]::Out.Write((ConvertTo-Json -Compress @{ ok = $true; paths = @($d.SelectedPath) })) } else { [Console]::Out.Write('{"ok":false,"cancelled":true}') }`
      : `if ($d.FileNames.Count -gt 0) { [Console]::Out.Write((ConvertTo-Json -Compress @{ ok = $true; paths = $d.FileNames })) } else { [Console]::Out.Write('{"ok":false,"cancelled":true}') }`;

  return [
    "$ProgressPreference = 'SilentlyContinue'",
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
    '$owner = New-Object System.Windows.Forms.Form',
    '$owner.TopMost = $true',
    '$owner.Width = 0',
    '$owner.Height = 0',
    '$owner.Opacity = 0',
    '$owner.ShowInTaskbar = $false',
    '$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen',
    'try {',
    '  $owner.Show()',
    '  $owner.Activate()',
    '  $owner.BringToFront()',
    dialog,
    '  $r = $d.ShowDialog($owner)',
    `  if ($r -eq [System.Windows.Forms.DialogResult]::OK) { ${result} } else { [Console]::Out.Write('{"ok":false,"cancelled":true}') }`,
    '} catch {',
    `  [Console]::Out.Write((ConvertTo-Json -Compress @{ ok = $false; error = $_.Exception.Message }))`,
    '} finally {',
    '  if ($owner -ne $null) { $owner.Dispose() }',
    '  [System.Windows.Forms.Application]::ExitThread()',
    '}',
  ].join('\n');
}

type PickerResult = { paths?: string[]; cancelled?: boolean; error?: string };

/** execFile puts the whole argv, encoded script included, into its error text. */
function failReason(err: Error): string {
  const first = (err.message || String(err)).split('\n')[0];
  return first.length > 200 ? first.slice(0, 200) : first;
}

function runPicker(
  kind: Picker,
  title: string,
  filter: string,
  done: (r: PickerResult) => void
): void {
  const encoded = Buffer.from(pickerScript(kind, title, filter), 'utf16le').toString('base64');
  execFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-STA', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
    { windowsVerbatimArguments: true, maxBuffer: 8 * 1024 * 1024 },
    (err, stdout) => {
      if (err && !(stdout || '').trim()) {
        done({ error: failReason(err) });
        return;
      }
      try {
        done(JSON.parse((stdout || '').trim()) as PickerResult);
      } catch {
        done({ error: 'Native picker returned an unreadable response.' });
      }
    }
  );
}

function openInExplorerNative(rawPath: string, done: (err?: string) => void): void {
  let target = rawPath ? String(rawPath).trim() : projectRoot;
  if (!path.isAbsolute(target)) {
    target = path.resolve(projectRoot, target);
  }
  target = path.normalize(target);
  if (/^[A-Za-z]:$/.test(target)) {
    target += '\\';
  }

  // If path doesn't exist, try parent folder or fallback to projectRoot
  if (!fs.existsSync(target)) {
    const parent = path.dirname(target);
    if (fs.existsSync(parent)) {
      target = parent;
    } else {
      target = projectRoot;
    }
  }

  const isFile = fs.existsSync(target) && fs.statSync(target).isFile();

  const script = [
    "$ProgressPreference = 'SilentlyContinue'",
    `$target = '${target.replace(/'/g, "''")}'`,
    `$isDir = ${!isFile ? '$true' : '$false'}`,
    'if ($isDir) {',
    '  Start-Process -FilePath "explorer.exe" -ArgumentList "`"$target`""',
    '} else {',
    '  Start-Process -FilePath "explorer.exe" -ArgumentList ("/select,`"" + $target + "`"")',
    '}',
    'Start-Sleep -Milliseconds 350',
    'Add-Type -MemberDefinition \'[DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);\' -Name "NativeWin" -Namespace "Win32" -ErrorAction SilentlyContinue',
    '$sh = New-Object -ComObject Shell.Application',
    'for ($i = 0; $i -lt $sh.Windows().Count; $i++) {',
    '  try {',
    '    $w = $sh.Windows().Item($i)',
    '    if ($w.HWND) {',
    '      [Win32.NativeWin]::SwitchToThisWindow([IntPtr][long]$w.HWND, $true)',
    '    }',
    '  } catch {}',
    '}',
  ].join('\r\n');

  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  execFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-STA', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
    (err) => {
      done(err ? failReason(err) : undefined);
    }
  );
}

function json(res: import('http').ServerResponse, body: unknown, status = 200): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function readBody(req: import('http').IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => resolve(body));
  });
}

/** Preview assets must reach the browser over HTTP; file:// URLs are blocked by Chromium. */
function rewriteLocalUrls(html: string): string {
  return html.replace(/file:\/\/([^"')\s]+)/g, (_m, raw: string) => {
    let p = decodeURIComponent(raw);
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
    p = p.replace(/\//g, path.sep);
    if (path.dirname(p) === fontsDir) {
      return `/fonts/${path.basename(p).replace(/\\/g, '/')}`;
    }
    if (path.dirname(p) === vendorDir) {
      return `/vendor/${path.basename(p).replace(/\\/g, '/')}`;
    }
    return `/api/asset?path=${encodeURIComponent(p.replace(/\\/g, '/'))}`;
  });
}

const ASSET_ALLOWLIST = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.avif',
  '.ttf', '.otf', '.woff', '.woff2',
]);

function windowsNativePlugin(): Plugin {
  const pythonBin = path.join(projectRoot, '.venv', 'Scripts', 'python.exe');
  const pythonPath =
    process.env.PYTHON_EXECUTABLE || (fs.existsSync(pythonBin) ? pythonBin : 'python');

  // Every python spawn needs src/ on PYTHONPATH: fa_md_pdf is a source checkout here,
  // not an installed distribution, so the fallback `python` cannot import it otherwise.
  const bridgeEnv = (): NodeJS.ProcessEnv => ({
    ...process.env,
    PYTHONPATH:
      path.join(projectRoot, 'src') +
      (process.env.PYTHONPATH ? path.delimiter + process.env.PYTHONPATH : ''),
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
  });

  return {
    name: 'windows-native-bridge',
    configureServer(server) {
      // Bundled fonts, served with CORS + cache headers for the preview iframe.
      server.middlewares.use('/fonts', (req, res, next) => {
        const cleanUrl = (req.url || '').split('?')[0].replace(/^\//, '');
        const fontFile = path.join(fontsDir, cleanUrl);
        if (cleanUrl && fs.existsSync(fontFile) && fs.statSync(fontFile).isFile()) {
          res.setHeader('Content-Type', 'font/ttf');
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          fs.createReadStream(fontFile).pipe(res);
        } else {
          next();
        }
      });

      // 1. Native Windows folder picker.
      server.middlewares.use('/api/pick-folder', async (req, res) => {
        const url = new URL(req.url || '', 'http://localhost');
        const title = url.searchParams.get('title') || 'انتخاب پوشه حاوی اسناد';
        runPicker('folder', title, '', (r) => {
          if (r.error) return json(res, { path: '', error: r.error });
          json(res, { path: r.paths?.[0] || '', cancelled: !!r.cancelled });
        });
      });

      // 1b. Bundled Mermaid runtime so diagrams render without a CDN.
      server.middlewares.use('/vendor', (req, res, next) => {
        const cleanUrl = (req.url || '').split('?')[0].replace(/^\//, '');
        const file = path.join(vendorDir, cleanUrl);
        if (cleanUrl && fs.existsSync(file) && fs.statSync(file).isFile()) {
          res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          fs.createReadStream(file).pipe(res);
        } else {
          next();
        }
      });

      // 2. Native Windows multi-file picker.
      server.middlewares.use('/api/pick-files', async (req, res) => {
        const url = new URL(req.url || '', 'http://localhost');
        const exts = (url.searchParams.get('exts') || 'md,markdown')
          .split(',')
          .map((e) => e.trim().replace(/^\./, ''))
          .filter(Boolean);
        const pattern = exts.map((e) => `*.${e}`).join(';');
        const filter = `Markdown Files (${pattern})|${pattern}|All Files (*.*)|*.*`;
        const title = url.searchParams.get('title') || 'انتخاب اسناد مارک‌داون';

        runPicker('files', title, filter, (r) => {
          if (r.error) return json(res, { files: [], error: r.error });
          const files = (r.paths || []).filter(Boolean).map((f) => {
            const stat = fs.existsSync(f) ? fs.statSync(f) : { size: 0 };
            return {
              name: path.basename(f),
              path: f.replace(/\\/g, '/'),
              sizeBytes: stat.size,
              sizeStr: `${(stat.size / 1024).toFixed(1)} KB`,
            };
          });
          json(res, { files, cancelled: !!r.cancelled });
        });
      });

      // 3. Recursive folder scan.
      server.middlewares.use('/api/scan-folder', async (req, res) => {
        try {
          const { folderPath, recursive = true } = JSON.parse((await readBody(req)) || '{}');
          if (!folderPath || !fs.existsSync(folderPath)) {
            // A missing folder is a failure, not an empty result: never report it as
            // "no markdown found", which is what made the button look dead.
            return json(res, { files: [], error: 'Folder does not exist' }, 404);
          }

          const entries = fs.readdirSync(folderPath, {
            recursive: Boolean(recursive),
            withFileTypes: true,
          });
          const files = entries
            .filter((e) => e.isFile() && (e.name.endsWith('.md') || e.name.endsWith('.markdown')))
            .map((e) => {
              const parent = (e as any).parentPath || folderPath;
              const fullPath = path.join(parent, e.name);
              const stat = fs.statSync(fullPath);
              return {
                name: e.name,
                path: fullPath.replace(/\\/g, '/'),
                sizeBytes: stat.size,
                relativePath: path.relative(folderPath, fullPath).replace(/\\/g, '/'),
              };
            });
          json(res, { files });
        } catch (e: any) {
          json(res, { files: [], error: e.message }, 500);
        }
      });

      // 4. Reveal in Windows Explorer with foreground activation and path resolution.
      server.middlewares.use('/api/open-folder', async (req, res) => {
        try {
          const { targetPath } = JSON.parse((await readBody(req)) || '{}');
          openInExplorerNative(targetPath, (err) => {
            if (err) {
              json(res, { success: false, error: err }, 500);
            } else {
              json(res, { success: true });
            }
          });
        } catch (e: any) {
          json(res, { success: false, error: e.message }, 500);
        }
      });

      // 5. Raw markdown text for the source view.
      server.middlewares.use('/api/read-file', async (req, res) => {
        try {
          const { filePath } = JSON.parse((await readBody(req)) || '{}');
          if (filePath && fs.existsSync(filePath)) {
            json(res, { ok: true, content: fs.readFileSync(filePath, 'utf-8') });
          } else {
            json(res, { ok: false, error: 'File not found' }, 404);
          }
        } catch (e: any) {
          json(res, { ok: false, error: e.message }, 500);
        }
      });

      // 5a. Binary preview assets (images/fonts) referenced by file:// in the generated HTML.
      server.middlewares.use('/api/asset', (req, res) => {
        const url = new URL(req.url || '', 'http://localhost');
        const p = url.searchParams.get('path');
        if (!p || !fs.existsSync(p) || !fs.statSync(p).isFile()) {
          res.statusCode = 404;
          res.end('Not found');
          return;
        }
        if (!ASSET_ALLOWLIST.has(path.extname(p).toLowerCase())) {
          res.statusCode = 403;
          res.end('Forbidden');
          return;
        }
        const type = path.extname(p).toLowerCase() === '.svg' ? 'image/svg+xml' : 'application/octet-stream';
        res.setHeader('Content-Type', type);
        res.setHeader('Cache-Control', 'no-cache');
        fs.createReadStream(p).pipe(res);
      });

      // 5b. Initial queue: the file handed to the app on the command line, else repo docs.
      server.middlewares.use('/api/initial-items', async (req, res) => {
        type InitialItem = {
          id: string;
          name: string;
          path: string;
          sizeBytes: number;
          sizeStr: string;
          status: string;
          relativePath: string;
        };
        const toItem = (abs: string, id: string): InitialItem => {
          const stat = fs.statSync(abs);
          return {
            id,
            name: path.basename(abs),
            path: abs.replace(/\\/g, '/'),
            sizeBytes: stat.size,
            sizeStr: `${(stat.size / 1024).toFixed(1)} KB`,
            status: 'pending',
            relativePath: path.relative(projectRoot, abs).replace(/\\/g, '/') || path.basename(abs),
          };
        };

        const url = new URL(req.url || '', 'http://localhost');
        const wanted = [url.searchParams.get('file'), process.env.MDPERSIA_INITIAL_FILE]
          .map((v) => (v || '').trim())
          .filter(Boolean);

        const items: InitialItem[] = [];
        for (const w of wanted) {
          const abs = path.resolve(w);
          if (fs.existsSync(abs) && fs.statSync(abs).isFile()) items.push(toItem(abs, `open-${items.length}`));
        }
        // Non-empty here means the queue came from the command line, not the repo docs.
        const viewer = items.length > 0;
        if (items.length === 0) {
          for (const doc of [
            path.join(projectRoot, 'README.md'),
            path.join(projectRoot, 'docs', 'architecture.md'),
          ]) {
            if (fs.existsSync(doc)) items.push(toItem(doc, `init-${items.length}`));
          }
        }
        json(res, { items, viewer });
      });

      // 5c. Preview HTML rendered by the Python engine, with local-only fonts.
      server.middlewares.use('/api/preview-html', (req, res) => {
        const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
        const targetFile = url.searchParams.get('path');
        const theme = url.searchParams.get('theme') || 'dark';
        const zoomRaw = Number(url.searchParams.get('zoom') || '100');
        const zoom = Number.isFinite(zoomRaw) ? Math.min(250, Math.max(50, Math.round(zoomRaw))) : 100;

        const fail = (status: number, msg: string) => {
          res.statusCode = status;
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end(
            `<div dir="rtl" style="font-family:sans-serif;padding:24px;color:#b91c1c;">${msg}</div>`
          );
        };
        if (!targetFile || !fs.existsSync(targetFile)) return fail(404, 'فایل یافت نشد.');

        const pyScript = [
          'import sys',
          'from pathlib import Path',
          'from fa_md_pdf.html_builder import build_html, HtmlBuildOptions',
          'p = Path(sys.argv[1]).resolve()',
          'fonts, vendor = Path(sys.argv[2]), Path(sys.argv[3])',
          'opts = HtmlBuildOptions(',
          '    source_path=p,',
          '    font_dir=fonts if fonts.is_dir() else None,',
          "    mermaid_source=vendor.as_uri() if vendor.is_file() else 'https://cdn.jsdelivr.net/npm/mermaid@11.15.0/dist/mermaid.min.js',",
          ')',
          'doc = build_html(p.read_text(encoding="utf-8", errors="replace"), opts)',
          'sys.stdout.buffer.write(doc.html.encode("utf-8"))',
        ].join('\n');

        const proc = spawn(pythonPath, ['-c', pyScript, targetFile, fontsDir, path.join(vendorDir, 'mermaid.min.js')], {
          cwd: projectRoot,
          env: bridgeEnv(),
        });

        const chunks: Buffer[] = [];
        const errChunks: Buffer[] = [];
        proc.stdout.on('data', (d) => chunks.push(d));
        proc.stderr.on('data', (d) => errChunks.push(d));
        proc.on('error', (err) => fail(500, `خطای اجرای موتور پیش‌نمایش: ${err.message}`));
        proc.on('close', (code) => {
          if (code !== 0) {
            return fail(500, `خطا در ساخت پیش‌نمایش: ${Buffer.concat(errChunks).toString('utf-8')}`);
          }
          const shell = [
            '<style>',
            fontFaceCss(),
            'html { zoom: ' + zoom + '%; }',
            'html, body { margin: 0; padding: 0; }',
            'html, body, .markdown-body, h1, h2, h3, h4, h5, h6, p, li, td, th, blockquote, figcaption, div, span {',
            '  font-family: "Vazirmatn", "Segoe UI", Tahoma, sans-serif !important;',
            '}',
            'pre { font-family: "Cascadia Mono", Consolas, monospace !important; direction: ltr !important; text-align: left !important; unicode-bidi: isolate !important; }',
            'code { font-family: "Cascadia Mono", Consolas, monospace !important; unicode-bidi: isolate !important; }',
            '.markdown-body { padding: 36px 44px !important; max-width: 860px !important;',
            '  margin: 0 auto !important; box-sizing: border-box !important; min-height: 100vh; }',
            'img { max-width: 100%; height: auto; }',
            ':is([dir="ltr"]:not(html, body), [dir="ltr"]:not(html, body) :is(p, li, dd, dt, blockquote, h1, h2, h3, h4, h5, h6, th, td)) {',
            '  direction: ltr !important; text-align: left !important; unicode-bidi: isolate;',
            '}',
            ':is([dir="rtl"]:not(html, body), [dir="rtl"]:not(html, body) :is(p, li, dd, dt, blockquote, h1, h2, h3, h4, h5, h6, th, td)) {',
            '  direction: rtl !important; text-align: right !important; unicode-bidi: isolate;',
            '}',
            'ul[dir="rtl"], ol[dir="rtl"] { padding-inline-start: 1.6em !important; padding-inline-end: 0 !important; direction: rtl !important; }',
            'ul[dir="ltr"], ol[dir="ltr"] { padding-inline-start: 1.6em !important; padding-inline-end: 0 !important; direction: ltr !important; }',
            '</style>',
          ].join('\n');
          const dark = [
            '<style>',
            'body, .markdown-body { background-color: #121214 !important; color: #e4e4e7 !important; }',
            'h1,h2,h3,h4,h5,h6 { color: #fafafa !important; border-bottom-color: #27272a !important; }',
            'code { background: #27272a !important; color: #f43f5e !important; }',
            'pre { background: #18181b !important; border-color: #27272a !important; }',
            'table th { background: #1f1f23 !important; color: #f4f4f5 !important; border-color: #27272a !important; }',
            'table td { border-color: #27272a !important; background: #121214 !important; color: #e4e4e7 !important; }',
            'blockquote { border-inline-start-color: #3f3f46 !important; background: #1e1e24 !important; color: #d4d4d8 !important; }',
            '.mermaid { filter: invert(0.88) hue-rotate(180deg); }',
            '</style>',
          ].join('\n');

          let out = rewriteLocalUrls(Buffer.concat(chunks).toString('utf-8'));
          out = out.replace('</head>', shell + (theme === 'dark' ? dark : '') + '</head>');
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          res.end(out);
        });
      });

      // 6. Conversion execution with SSE streaming.
      server.middlewares.use('/api/convert-job', async (req, res) => {
        try {
          const { args } = JSON.parse((await readBody(req)) || '{}');
          if (!Array.isArray(args)) return void ((res.statusCode = 400), res.end('Missing args'));

          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');

          const proc = spawn(pythonPath, ['-m', 'fa_md_pdf.cli', ...args], {
            cwd: projectRoot,
            env: bridgeEnv(),
          });
          proc.stdout.on('data', (c) =>
            res.write(`data: ${JSON.stringify({ type: 'stdout', text: c.toString('utf-8') })}\n\n`)
          );
          let stderrTail = '';
          proc.stderr.on('data', (c) => {
            const text = c.toString('utf-8');
            stderrTail = (stderrTail + text).slice(-4000);
            res.write(`data: ${JSON.stringify({ type: 'stderr', text })}\n\n`);
          });
          proc.on('close', (code) => {
            if (code) {
              // A raw traceback is not actionable; name the interpreter and the fix.
              const missing = /ModuleNotFoundError: No module named '([^']+)'/.exec(stderrTail);
              if (missing) {
                const hint =
                  `محیط پایتونِ «${pythonPath}» ماژول «${missing[1]}» را ندارد. ` +
                  `با متغیر PYTHON_EXECUTABLE مسیر محیطِ درست را مشخص کن.\n`;
                res.write(`data: ${JSON.stringify({ type: 'stderr', text: hint })}\n\n`);
              }
            }
            res.write(`data: ${JSON.stringify({ type: 'exit', code })}\n\n`);
            res.end();
          });
          proc.on('error', (err) => {
            res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
            res.end();
          });
        } catch (err: any) {
          res.statusCode = 500;
          res.end(err.message);
        }
      });
    },

    // Ship the bundled fonts and Mermaid runtime into the production dist (offline viewer).
    closeBundle() {
      if (fs.existsSync(fontsDir)) {
        const target = path.resolve(__dirname, 'dist', 'fonts');
        fs.mkdirSync(target, { recursive: true });
        for (const f of fs.readdirSync(fontsDir)) {
          if (f.toLowerCase().endsWith('.ttf')) {
            fs.copyFileSync(path.join(fontsDir, f), path.join(target, f));
          }
        }
      }
      if (fs.existsSync(vendorDir)) {
        const target = path.resolve(__dirname, 'dist', 'vendor');
        fs.mkdirSync(target, { recursive: true });
        for (const f of fs.readdirSync(vendorDir)) {
          if (f.toLowerCase().endsWith('.js')) {
            fs.copyFileSync(path.join(vendorDir, f), path.join(target, f));
          }
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), windowsNativePlugin()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // Loopback only: the native bridge can read local files and open Explorer windows.
    host: process.env.MDPERSIA_DEV_HOST || '127.0.0.1',
  },
});
