"""Acceptance against the actual installed Tauri/WebView2 application on Windows.

Uses an isolated WebView2 profile and a temporary CDP port. No dev server or
mock bridge is involved. The executable and engine run with a restricted PATH.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import platform
import socket
import struct
import subprocess
import time
from urllib.request import urlopen
import zipfile
import zlib

from playwright.sync_api import expect, sync_playwright


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def owned_processes(directory: Path) -> list[dict]:
    literal = str(directory).replace("'", "''")
    query = f"Get-CimInstance Win32_Process | Where-Object {{ $_.ExecutablePath -and $_.ExecutablePath.StartsWith('{literal}', [StringComparison]::OrdinalIgnoreCase) }} | Select-Object ProcessId,Name,WorkingSetSize | ConvertTo-Json -Compress"
    result = subprocess.check_output(['powershell.exe', '-NoProfile', '-Command', query], text=True)
    value = json.loads(result) if result.strip() else []
    return value if isinstance(value, list) else [value]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('executable', type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    exe, output = args.executable.resolve(), args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    port = free_port()
    profile = output / ('profile-' + str(time.time_ns()))
    env = {**os.environ, 'PATH': os.path.join(os.environ['SYSTEMROOT'], 'System32'),
        'WEBVIEW2_USER_DATA_FOLDER': str(profile),
        'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS': f'--remote-debugging-port={port} --remote-debugging-address=127.0.0.1 --no-first-run'}
    for key in ('PYTHONHOME', 'PYTHONPATH', 'PLAYWRIGHT_BROWSERS_PATH'):
        env.pop(key, None)
    original = '# سند نخست\r\n\r\n- Host: localhost برای اتصال\r\n\r\nEnglish Solver: example.\r\n\r\n![local](local-image.png)\r\n\r\n```mermaid\r\ngraph LR\r\nA[شروع]-->B[پایان]\r\n```\r\n'
    first, second, third = [output / name for name in ('فایل نخست.md', 'second.markdown', 'third.md')]
    first.write_bytes(original.encode('utf-8-sig'))
    second.write_text('# سند دوم\n\nمتن دوم.', encoding='utf-8')
    third.write_text('# سند سوم\n\nمتن سوم.', encoding='utf-8')
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind+data))
    image = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 80, 30, 8, 2, 0, 0, 0))
    image += chunk(b'IDAT', zlib.compress((b'\0'+b'\x46\x82\xb4'*80)*30)) + chunk(b'IEND', b'')
    (output / 'local-image.png').write_bytes(image)
    started = time.perf_counter()
    proc = subprocess.Popen([str(exe), str(first)], cwd=output, env=env)
    report = {'os': platform.platform(), 'executable': str(exe), 'restrictedPath': env['PATH']}
    errors = []
    try:
        with sync_playwright() as p:
            deadline = time.monotonic() + 40
            while True:
                try:
                    urlopen(f'http://127.0.0.1:{port}/json/version', timeout=.2).close()
                    break
                except OSError:
                    if proc.poll() is not None:
                        raise RuntimeError(f'Native app exited: {proc.returncode}')
                    if time.monotonic() > deadline:
                        raise TimeoutError('WebView2 CDP endpoint did not become ready')
                    time.sleep(.1)
            browser = p.chromium.connect_over_cdp(f'http://127.0.0.1:{port}')
            page = browser.contexts[0].pages[0]
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.wait_for_function('Boolean(window.__TAURI_INTERNALS__)')
            frame = page.frame_locator('iframe')
            frame.get_by_role('heading', name='سند نخست', exact=True).wait_for(timeout=30000)
            report['launchToRenderedHeadingSeconds'] = round(time.perf_counter()-started, 3)
            frame.locator('.mermaid svg').wait_for(timeout=30000)
            frame.locator('img').wait_for()
            assert frame.locator('img').evaluate('(el)=>el.complete && el.naturalWidth>0')
            assert frame.locator('body').evaluate('async()=>{await document.fonts.ready;return document.fonts.check("16px Vazirmatn")}')
            report['nativePreviewWithLocalImageFontAndMermaid'] = True
            for file in (second, third):
                subprocess.run([str(exe), str(file)], cwd=output, env=env, timeout=15, check=True)
            expect(page.locator('tbody tr')).to_have_count(3)
            frame.get_by_role('heading', name='سند سوم', exact=True).wait_for()
            subprocess.run([str(exe), str(first)], cwd=output, env=env, timeout=15, check=True)
            expect(page.locator('tbody tr')).to_have_count(3)
            frame.get_by_role('heading', name='سند نخست', exact=True).wait_for()
            report['successiveOpensAppendAndReopenDeduplicates'] = True
            page.get_by_role('button', name='ویرایش سند', exact=True).click()
            content = page.locator('.cm-content[contenteditable=true]')
            expect(content).to_be_visible()
            content.click()
            page.keyboard.press('Control+a')
            changed = original.replace('\r\n', '\n').replace('سند نخست', 'سند ویرایش‌شده') + '\nذخیرهٔ واقعی در نصب\n'
            page.keyboard.insert_text(changed)
            frame.get_by_role('heading', name='سند ویرایش‌شده', exact=True).wait_for(timeout=15000)
            page.keyboard.press('Control+s')
            expect(page.get_by_role('button', name='ذخیره سند', exact=True)).to_be_disabled()
            assert first.read_bytes() == changed.replace('\n', '\r\n').encode('utf-8-sig')
            report['nativeLiveEditAndActualCtrlSSave'] = True
            page.keyboard.insert_text('\nپیش‌نویس برای آزمون خروج\n')
            page.evaluate('void window.__TAURI_INTERNALS__.invoke("plugin:window|close",{label:"main"})')
            guard = page.get_by_role('dialog', name='تغییرات ذخیره‌نشده', exact=True)
            expect(guard).to_be_visible()
            guard.get_by_role('button', name='انصراف', exact=True).click()
            page.keyboard.press('Control+s')
            expect(page.get_by_role('button', name='ذخیره سند', exact=True)).to_be_disabled()
            report['nativeCloseGuardPreservesUnsavedEdits'] = True
            # Exercise the native directory command against actual files.
            scanned = page.evaluate('(folderPath)=>window.__TAURI_INTERNALS__.invoke("scan_folder",{folderPath,recursive:true})', str(output))
            assert {first.name, second.name, third.name} <= {f['name'] for f in scanned}
            report['nativeFolderScan'] = True
            page.get_by_role('button', name='پایان ویرایش', exact=True).click()
            page.get_by_role('button', name='DOCX (Word)', exact=True).click()
            page.get_by_role('button', name='شروع تبدیل اسناد', exact=True).click()
            page.get_by_text('فرآیند تبدیل پایان یافت: 3 موفق، 0 ناموفق.', exact=True).wait_for(timeout=90000)
            for file in (first, second, third):
                with zipfile.ZipFile(file.with_suffix('.docx')) as archive:
                    assert 'word/document.xml' in archive.namelist()
            report['realNativeBatchDocxConversion'] = True
            page.get_by_role('tab', name='پیشرفته', exact=True).click()
            watch = page.get_by_label('حالت پایش زنده (Watch Mode)', exact=True)
            watch.check()
            page.get_by_role('button', name='شروع تبدیل اسناد', exact=True).click()
            console = page.locator('.console-report')
            console.get_by_text('پایش زنده فعال است', exact=True).wait_for(timeout=30000)
            first.write_text('# ویرایش بیرونی\n\nآزمون پایش نصب واقعی.', encoding='utf-8')
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                try:
                    with zipfile.ZipFile(first.with_suffix('.docx')) as archive:
                        if 'ویرایش بیرونی' in archive.read('word/document.xml').decode('utf-8'):
                            break
                except (OSError, zipfile.BadZipFile):
                    pass
                page.wait_for_timeout(200)
            else:
                raise AssertionError('Native watch did not rebuild Word output')
            console.get_by_role('button', name='توقف پایش', exact=True).click()
            expect(page.get_by_role('button', name='شروع تبدیل اسناد', exact=True)).to_be_enabled(timeout=10000)
            watch.uncheck()
            report['nativeWatchRebuildAndCancellation'] = True
            page.get_by_role('tab', name='پیش‌نمایش سند', exact=True).click()
            page.screenshot(path=str(output / 'native-workspace.png'))
            report['ownedProcessesWhileReading'] = owned_processes(exe.parent)
            assert sum(row['Name'].lower() == 'mdpersia.exe' for row in report['ownedProcessesWhileReading']) == 1
            assert not any(row['Name'].lower() == 'chrome-headless-shell.exe' for row in report['ownedProcessesWhileReading'])
            report['noConversionBrowserRemainsWhileReading'] = True
            assert not errors, errors
            report['pageErrors'] = errors
            page.evaluate('void window.__TAURI_INTERNALS__.invoke("plugin:window|close",{label:"main"})')
            proc.wait(timeout=15)
            for _ in range(30):
                if not owned_processes(exe.parent):
                    break
                time.sleep(.1)
            assert not owned_processes(exe.parent), 'Application children remained after exit'
            report['engineAndConversionTreesStopOnExit'] = True
    except Exception:
        report['pageErrors'] = errors
        raise
    finally:
        if proc.poll() is None:
            # Only the specific acceptance application and its descendants.
            subprocess.run(['taskkill.exe', '/PID', str(proc.pid), '/T', '/F'], capture_output=True)
        (output / 'native-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=True, indent=2))


if __name__ == '__main__':
    main()
