//=============================================================================
// win32.js - the small slice of user32 the launcher needs.
//
// Enough to find a window by class and process, read its title, and click a
// button inside it. It exists because GM8 answers a runtime error with a modal
// dialog that freezes the game and every pending bridge call, and only a click
// from outside can clear it.
//
// Everything here posts rather than sends. PostMessageW returns immediately;
// SendMessageW would block until the target's message loop answers, and the
// windows this deals with are, by definition, the ones that stop answering.
//
// Top-level windows are walked with FindWindowExW(NULL, prev, ...), which needs
// no callback into JS - a nice simplification over EnumWindows.
//=============================================================================

const koffi = require('koffi');

const user32 = koffi.load('user32.dll');

const FindWindowExW = user32.func('void* __stdcall FindWindowExW(void*, void*, void*, void*)');
const GetClassNameW = user32.func('int __stdcall GetClassNameW(void*, void*, int)');
const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(void*, void*, int)');
const GetWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(void*, void*)');
const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(void*)');
// wParam and lParam are integers here rather than pointers: every message this
// module posts carries nothing at all, and the one that needs a buffer
// (WM_GETTEXT) goes through SendMessageTimeoutW instead.
const PostMessageW = user32.func('bool __stdcall PostMessageW(void*, uint32, size_t, size_t)');
const SendMessageTimeoutW = user32.func(
  'void* __stdcall SendMessageTimeoutW(void*, uint32, size_t, void*, uint32, uint32, void*)'
);
const GetWindowRect = user32.func('bool __stdcall GetWindowRect(void*, void*)');
const GetDC = user32.func('void* __stdcall GetDC(void*)');
const ReleaseDC = user32.func('int __stdcall ReleaseDC(void*, void*)');
const PrintWindow = user32.func('bool __stdcall PrintWindow(void*, void*, uint32)');

const gdi32 = koffi.load('gdi32.dll');
const CreateCompatibleDC = gdi32.func('void* __stdcall CreateCompatibleDC(void*)');
const CreateCompatibleBitmap = gdi32.func('void* __stdcall CreateCompatibleBitmap(void*, int, int)');
const SelectObject = gdi32.func('void* __stdcall SelectObject(void*, void*)');
const DeleteDC = gdi32.func('bool __stdcall DeleteDC(void*)');
const DeleteObject = gdi32.func('bool __stdcall DeleteObject(void*)');
const GetDIBits = gdi32.func('int __stdcall GetDIBits(void*, void*, uint32, uint32, void*, void*, uint32)');

const BM_CLICK = 0x00f5;
const WM_GETTEXT = 0x000d;
const WM_CLOSE = 0x0010;
const SMTO_ABORTIFHUNG = 0x0002;

// A UTF-16 buffer, read back as far as the API says it wrote.
function readWide(fn, hwnd, max = 256) {
  const buf = Buffer.alloc(max * 2);
  const n = fn(hwnd, buf, max);
  return n > 0 ? buf.toString('utf16le', 0, n * 2) : '';
}

const classOf = (hwnd) => readWide(GetClassNameW, hwnd);
const titleOf = (hwnd) => readWide(GetWindowTextW, hwnd);

function pidOf(hwnd) {
  const buf = Buffer.alloc(4);
  GetWindowThreadProcessId(hwnd, buf);
  return buf.readUInt32LE(0);
}

// Every visible top-level window, optionally filtered by class and owning pid.
function windows({ cls = null, pid = null } = {}) {
  const found = [];
  let hwnd = null;
  for (;;) {
    hwnd = FindWindowExW(null, hwnd, null, null);
    if (!hwnd) break;
    if (!IsWindowVisible(hwnd)) continue;
    const c = classOf(hwnd);
    if (cls !== null && c !== cls) continue;
    const p = pidOf(hwnd);
    if (pid !== null && p !== pid) continue;
    found.push({ hwnd, cls: c, title: titleOf(hwnd), pid: p });
  }
  return found;
}

// Direct children of a window, with their class and caption.
function children(parent) {
  const found = [];
  let hwnd = null;
  for (;;) {
    hwnd = FindWindowExW(parent, hwnd, null, null);
    if (!hwnd) break;
    found.push({ hwnd, cls: classOf(hwnd), text: titleOf(hwnd) });
  }
  return found;
}

// GetWindowText only returns a caption, and only ever an empty string for a
// control living in another process - the content of an edit box has to be
// asked for with WM_GETTEXT. Time-limited, because the windows this reads from
// belong to a game that has just stopped responding.
function controlText(hwnd, max = 4096, timeoutMs = 500) {
  const buf = Buffer.alloc(max * 2);
  const result = Buffer.alloc(8);
  const sent = SendMessageTimeoutW(hwnd, WM_GETTEXT, max, buf, SMTO_ABORTIFHUNG, timeoutMs, result);
  if (!sent) return '';
  const chars = Number(result.readBigUInt64LE(0));
  return chars > 0 ? buf.toString('utf16le', 0, Math.min(chars, max) * 2) : '';
}

const clickButton = (hwnd) => PostMessageW(hwnd, BM_CLICK, 0, 0);

const closeWindow = (hwnd) => PostMessageW(hwnd, WM_CLOSE, 0, 0);

const PW_RENDERFULLCONTENT = 0x00000002;

// A window's pixels as a BMP buffer, for the dialogs `controlText` cannot read -
// Delphi paints some captions with no window handle, so the text is gone but the
// pixels are not. GetWindowRect sizes a compatible bitmap, PrintWindow renders
// the target into it (falling back to the plain flag for a window that ignores
// PW_RENDERFULLCONTENT), and GetDIBits reads it back top-down as 32bpp BI_RGB so
// it can be wrapped in a plain BMP file header with no palette to worry about.
// Returns null rather than throwing - this is always a best-effort addition to
// a diagnosis that already has a text fallback.
function captureWindow(hwnd) {
  const rect = Buffer.alloc(16);
  if (!GetWindowRect(hwnd, rect)) return null;
  const width = rect.readInt32LE(8) - rect.readInt32LE(0);
  const height = rect.readInt32LE(12) - rect.readInt32LE(4);
  if (width <= 0 || height <= 0 || width > 8192 || height > 8192) return null;

  const screenDC = GetDC(null);
  if (!screenDC) return null;
  const memDC = CreateCompatibleDC(screenDC);
  const bmp = CreateCompatibleBitmap(screenDC, width, height);
  const old = SelectObject(memDC, bmp);
  try {
    if (!PrintWindow(hwnd, memDC, PW_RENDERFULLCONTENT)) PrintWindow(hwnd, memDC, 0);

    const headerSize = 40;
    const info = Buffer.alloc(headerSize);
    info.writeInt32LE(headerSize, 0);
    info.writeInt32LE(width, 4);
    info.writeInt32LE(-height, 8); // negative height = top-down rows
    info.writeInt16LE(1, 12); // biPlanes
    info.writeInt16LE(32, 14); // biBitCount
    info.writeInt32LE(0, 16); // BI_RGB

    const pixels = Buffer.alloc(width * 4 * height);
    if (!GetDIBits(memDC, bmp, 0, height, pixels, info, 0)) return null;

    const fileHeader = Buffer.alloc(14);
    fileHeader.write('BM', 0, 'ascii');
    fileHeader.writeUInt32LE(fileHeader.length + info.length + pixels.length, 2);
    fileHeader.writeUInt32LE(fileHeader.length + info.length, 10);
    return Buffer.concat([fileHeader, info, pixels]);
  } finally {
    SelectObject(memDC, old);
    DeleteObject(bmp);
    DeleteDC(memDC);
    ReleaseDC(null, screenDC);
  }
}

module.exports = { windows, children, controlText, clickButton, closeWindow, captureWindow };

if (require.main === module) {
  const pid = process.argv[2] ? Number(process.argv[2]) : null;
  for (const w of windows({ pid })) {
    console.log(`pid ${String(w.pid).padStart(6)}  ${w.cls.padEnd(28)}  ${w.title}`);
  }
}
