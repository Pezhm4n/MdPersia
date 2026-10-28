// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::Path;
use std::process::Command;
use std::process::Stdio;
use std::io::Write;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

#[derive(serde::Deserialize)]
struct PreviewRequest {
    path: String,
    theme: String,
    zoom: u32,
    text: Option<String>,
}

#[derive(Serialize)]
struct Preview {
    html: String,
}

fn project_root() -> std::path::PathBuf {
    // `tauri dev` runs with cwd = src-tauri; the release exe sits next to nothing useful,
    // so fall back to the current directory when the repo layout is absent.
    let cwd = std::env::current_dir().unwrap_or_default();
    let candidate = cwd.join("..").join("..");
    if candidate.join("src").join("fa_md_pdf").is_dir() {
        candidate
    } else if cwd.join("src").join("fa_md_pdf").is_dir() {
        cwd
    } else {
        cwd.join("..")
    }
}

fn is_markdown(arg: &str) -> bool {
    Path::new(arg).extension().and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("md") || ext.eq_ignore_ascii_case("markdown"))
        .unwrap_or(false)
}

/// Markdown documents handed to this process at launch (double-click / "Open with").
#[tauri::command]
fn startup_arguments() -> Vec<String> {
    std::env::args()
        .skip(1)
        .filter(|a| Path::new(a).is_file())
        .collect()
}

/// Render one document through the Python engine. Local asset URLs stay as file:// and are
/// mapped to the asset protocol by the front end, where that API lives.
#[tauri::command]
fn preview_html(request: PreviewRequest) -> Result<Preview, String> {
    let root = project_root();
    let fonts = root.join("fonts");
    let vendor = root.join("vendor").join("mermaid.min.js");

    const SCRIPT: &str = r#"
import sys
import secrets
from pathlib import Path
from fa_md_pdf.html_builder import build_html, HtmlBuildOptions, read_text_safely
p = Path(sys.argv[1]).resolve()
fonts, vendor = Path(sys.argv[2]), Path(sys.argv[3])
opts = HtmlBuildOptions(
    source_path=p,
    font_dir=fonts if fonts.is_dir() else None,
    mermaid_source=vendor.as_uri() if vendor.is_file() else '',
    preview_nonce=secrets.token_urlsafe(24),
)
doc = build_html(sys.stdin.read() if sys.argv[4] == 'draft' else read_text_safely(p), opts)
sys.stdout.buffer.write(doc.html.encode('utf-8'))
"#;

    let python =
        std::env::var("PYTHON_EXECUTABLE").unwrap_or_else(|_| "python".to_string());
    let mut command = Command::new(&python);
    #[cfg(windows)]
    { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
    let mut child = command
        .arg("-c")
        .arg(SCRIPT)
        .arg(&request.path)
        .arg(&fonts)
        .arg(&vendor)
        .arg(if request.text.is_some() { "draft" } else { "disk" })
        .current_dir(&root)
        .env("PYTHONPATH", root.join("src"))
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUTF8", "1")
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("MdPersia engine not reachable via '{python}': {e}"))?;
    if let Some(mut input) = child.stdin.take() {
        if let Some(text) = request.text { input.write_all(text.as_bytes()).map_err(|e| e.to_string())?; }
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;

    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }

    // Viewer chrome (zoom, theme, bundled fonts) is injected by the front end, which knows
    // where the packaged /fonts and /vendor assets live.
    Ok(Preview {
        html: String::from_utf8_lossy(&out.stdout).to_string(),
    })
}

/// Both desktop runtimes use the same codec, revision checks, and atomic file writer.
#[tauri::command]
fn document_io(request: serde_json::Value) -> Result<serde_json::Value, String> {
    let root = project_root();
    let python = std::env::var("PYTHON_EXECUTABLE").unwrap_or_else(|_| "python".to_string());
    let mut command = Command::new(&python);
    #[cfg(windows)]
    { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
    let mut child = command.args(["-m", "fa_md_pdf.document_io"])
        .current_dir(&root).env("PYTHONPATH", root.join("src"))
        .env("PYTHONIOENCODING", "utf-8").env("PYTHONUTF8", "1")
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .spawn().map_err(|e| e.to_string())?;
    if let Some(mut input) = child.stdin.take() {
        input.write_all(request.to_string().as_bytes()).map_err(|e| e.to_string())?;
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() { return Err(String::from_utf8_lossy(&out.stderr).to_string()); }
    serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())
}

/// Second launch: focus the existing window and hand it its documents.
fn forward_files(app: &AppHandle, args: Vec<String>) {
    let docs: Vec<String> = args.into_iter().filter(|a| is_markdown(a)).collect();
    if docs.is_empty() {
        return;
    }
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
    let _ = app.emit("open-files", &docs);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init());

    // One window handles every open request instead of piling up processes.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            forward_files(app, argv);
        }));
    }

    builder
        .invoke_handler(tauri::generate_handler![startup_arguments, preview_html, document_io])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
