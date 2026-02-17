const authScreenEl = document.getElementById("authScreen");
const authHintEl = document.getElementById("authHint");
const authErrorEl = document.getElementById("authError");
const setupFormEl = document.getElementById("setupForm");
const loginFormEl = document.getElementById("loginForm");
const setupPasswordEl = document.getElementById("setupPassword");
const setupPassword2El = document.getElementById("setupPassword2");
const loginPasswordEl = document.getElementById("loginPassword");

const terminalAppEl = document.getElementById("terminalApp");
const terminalContainer = document.getElementById("terminalContainer");
const terminalEl = document.getElementById("terminal");
const statusTextEl = document.getElementById("statusText");
const clearBtn = document.getElementById("clearBtn");
const ctrlCBtn = document.getElementById("ctrlCBtn");
const reconnectBtn = document.getElementById("reconnectBtn");
const logoutBtn = document.getElementById("logoutBtn");

const READ_TIMEOUT_SEC = 20;
const MIN_PASSWORD_LEN = 8;
const MAX_SCREEN_ROWS = 2500;

let sid = "";
let running = false;
let inputQueue = "";
let flushTimer = null;
let loopToken = 0;

let ansiRemainder = "";
let ansiState = createDefaultAnsiState();
let screenLines = [[]];
let cursorRow = 0;
let cursorCol = 0;
let renderScheduled = false;
let terminalCols = 120;

function setStatus(text) {
  statusTextEl.textContent = text;
}

function setAuthError(text) {
  authErrorEl.textContent = text || "";
}

function showAuth(mode, hintText = "") {
  authScreenEl.classList.remove("hidden");
  terminalAppEl.classList.add("hidden");
  setupFormEl.classList.toggle("hidden", mode !== "setup");
  loginFormEl.classList.toggle("hidden", mode !== "login");
  authHintEl.textContent = hintText;
  setAuthError("");

  if (mode === "setup") {
    setupPasswordEl.value = "";
    setupPassword2El.value = "";
    setupPasswordEl.focus();
  } else {
    loginPasswordEl.value = "";
    loginPasswordEl.focus();
  }
}

function showTerminal() {
  authScreenEl.classList.add("hidden");
  terminalAppEl.classList.remove("hidden");
  terminalContainer.focus();
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    cache: "no-store",
    credentials: "same-origin",
    ...options,
  });

  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }

  if (!response.ok) {
    const message = payload.error || `Request failed: ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }

  return payload;
}

function createDefaultAnsiState() {
  return {
    bold: false,
    italic: false,
    underline: false,
    strike: false,
    inverse: false,
    fg: null,
    bg: null,
  };
}

function cloneAnsiState(state) {
  return {
    bold: state.bold,
    italic: state.italic,
    underline: state.underline,
    strike: state.strike,
    inverse: state.inverse,
    fg: state.fg,
    bg: state.bg,
  };
}

function styleToCss(state) {
  let fg = state.fg;
  let bg = state.bg;
  if (state.inverse) {
    fg = state.bg || "var(--terminal-bg)";
    bg = state.fg || "var(--terminal-fg)";
  }

  const css = [];
  if (fg) css.push(`color:${fg}`);
  if (bg) css.push(`background-color:${bg}`);
  if (state.bold) css.push("font-weight:700");
  if (state.italic) css.push("font-style:italic");
  if (state.underline || state.strike) {
    const lines = [];
    if (state.underline) lines.push("underline");
    if (state.strike) lines.push("line-through");
    css.push(`text-decoration-line:${lines.join(" ")}`);
  }
  return css.join(";");
}

function currentCellStyle() {
  return styleToCss(ansiState);
}

function blankCell(style = "") {
  return { ch: " ", style };
}

function charDisplayWidth(ch) {
  if (!ch) return 1;
  const cp = ch.codePointAt(0);
  if (cp == null) return 1;

  // Combining marks
  if (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe20 && cp <= 0xfe2f)
  ) {
    return 0;
  }

  // East Asian Wide / Fullwidth ranges
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6)
  ) {
    return 2;
  }

  return 1;
}

function getAnsi16Color(code) {
  const fgNormal = ["#2c3a4a", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#d7dde5"];
  const fgBright = ["#5a6b7f", "#ef7d86", "#b3d98c", "#f2cf8f", "#7ebef7", "#d89bf0", "#7dd7df", "#eef3f8"];
  const bgNormal = ["#232a32", "#b44b4b", "#3f8f3f", "#b89644", "#4a78c2", "#9d5db8", "#3f9292", "#c2cad3"];
  const bgBright = ["#3b4652", "#ef7d86", "#b3d98c", "#f2cf8f", "#7ebef7", "#d89bf0", "#7dd7df", "#eef3f8"];

  if (code >= 30 && code <= 37) return fgNormal[code - 30];
  if (code >= 90 && code <= 97) return fgBright[code - 90];
  if (code >= 40 && code <= 47) return bgNormal[code - 40];
  if (code >= 100 && code <= 107) return bgBright[code - 100];
  return null;
}

function xterm256ToRgb(index) {
  if (index < 0 || index > 255) return null;
  if (index < 16) {
    const table = [
      [0, 0, 0],
      [128, 0, 0],
      [0, 128, 0],
      [128, 128, 0],
      [0, 0, 128],
      [128, 0, 128],
      [0, 128, 128],
      [192, 192, 192],
      [128, 128, 128],
      [255, 0, 0],
      [0, 255, 0],
      [255, 255, 0],
      [92, 92, 255],
      [255, 0, 255],
      [0, 255, 255],
      [255, 255, 255],
    ];
    const [r, g, b] = table[index];
    return `rgb(${r},${g},${b})`;
  }

  if (index >= 232) {
    const c = 8 + (index - 232) * 10;
    return `rgb(${c},${c},${c})`;
  }

  const i = index - 16;
  const r = Math.floor(i / 36);
  const g = Math.floor((i % 36) / 6);
  const b = i % 6;
  const map = [0, 95, 135, 175, 215, 255];
  return `rgb(${map[r]},${map[g]},${map[b]})`;
}

function applySgr(state, sgr) {
  const params = sgr.trim() ? sgr.split(";").map((v) => Number(v)) : [0];
  let i = 0;

  while (i < params.length) {
    const code = Number.isFinite(params[i]) ? params[i] : 0;
    i += 1;

    if (code === 0) {
      state.bold = false;
      state.italic = false;
      state.underline = false;
      state.strike = false;
      state.inverse = false;
      state.fg = null;
      state.bg = null;
      continue;
    }
    if (code === 1) {
      state.bold = true;
      continue;
    }
    if (code === 3) {
      state.italic = true;
      continue;
    }
    if (code === 4) {
      state.underline = true;
      continue;
    }
    if (code === 7) {
      state.inverse = true;
      continue;
    }
    if (code === 9) {
      state.strike = true;
      continue;
    }
    if (code === 22) {
      state.bold = false;
      continue;
    }
    if (code === 23) {
      state.italic = false;
      continue;
    }
    if (code === 24) {
      state.underline = false;
      continue;
    }
    if (code === 27) {
      state.inverse = false;
      continue;
    }
    if (code === 29) {
      state.strike = false;
      continue;
    }
    if (code === 39) {
      state.fg = null;
      continue;
    }
    if (code === 49) {
      state.bg = null;
      continue;
    }

    const ansi16 = getAnsi16Color(code);
    if (ansi16) {
      if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
        state.fg = ansi16;
      } else {
        state.bg = ansi16;
      }
      continue;
    }

    if ((code === 38 || code === 48) && i < params.length) {
      const mode = params[i];
      i += 1;
      if (mode === 5 && i < params.length) {
        const rgb = xterm256ToRgb(params[i]);
        i += 1;
        if (rgb) {
          if (code === 38) state.fg = rgb;
          else state.bg = rgb;
        }
      } else if (mode === 2 && i + 2 < params.length) {
        const r = Math.max(0, Math.min(255, params[i]));
        const g = Math.max(0, Math.min(255, params[i + 1]));
        const b = Math.max(0, Math.min(255, params[i + 2]));
        i += 3;
        const rgb = `rgb(${r},${g},${b})`;
        if (code === 38) state.fg = rgb;
        else state.bg = rgb;
      }
    }
  }
}

function ensureRow(row) {
  while (screenLines.length <= row) {
    screenLines.push([]);
  }
}

function clampAndTrimRows() {
  while (screenLines.length > MAX_SCREEN_ROWS) {
    screenLines.shift();
    cursorRow = Math.max(0, cursorRow - 1);
  }
}

function ensureCol(line, col) {
  while (line.length < col) {
    line.push(blankCell());
  }
}

function clearWideClusterAt(line, col) {
  if (col < 0 || col >= line.length) return;
  const cell = line[col];
  if (!cell) return;

  if (cell.cont) {
    line[col] = blankCell();
    if (col > 0 && line[col - 1] && line[col - 1].wide) {
      line[col - 1] = blankCell();
    }
    return;
  }

  if (cell.wide) {
    line[col] = blankCell();
    if (col + 1 < line.length && line[col + 1] && line[col + 1].cont) {
      line[col + 1] = blankCell();
    }
  }
}

function putChar(ch) {
  let width = charDisplayWidth(ch);
  if (width <= 0) width = 1;

  if (terminalCols > 0 && cursorCol >= terminalCols) {
    lineFeed();
  }
  if (terminalCols > 0 && width === 2 && cursorCol === terminalCols - 1) {
    lineFeed();
  }

  ensureRow(cursorRow);
  const line = screenLines[cursorRow];
  ensureCol(line, cursorCol);
  clearWideClusterAt(line, cursorCol);

  if (width === 2) {
    ensureCol(line, cursorCol + 1);
    clearWideClusterAt(line, cursorCol + 1);
    line[cursorCol] = { ch, style: currentCellStyle(), wide: true };
    line[cursorCol + 1] = { ch: "", style: currentCellStyle(), cont: true };
  } else {
    line[cursorCol] = { ch, style: currentCellStyle() };
  }

  cursorCol += width;
}

function lineFeed() {
  cursorRow += 1;
  ensureRow(cursorRow);
  cursorCol = 0;
  clampAndTrimRows();
}

function carriageReturn() {
  cursorCol = 0;
}

function backspace() {
  if (cursorCol > 0) cursorCol -= 1;
}

function eraseInLine(mode) {
  ensureRow(cursorRow);
  const line = screenLines[cursorRow];

  if (mode === 2) {
    line.length = 0;
    return;
  }

  if (mode === 1) {
    const end = Math.min(cursorCol + 1, line.length);
    for (let i = 0; i < end; i += 1) {
      line[i] = blankCell();
    }
    return;
  }

  if (cursorCol < line.length) {
    line.splice(cursorCol);
  }
}

function eraseInDisplay(mode) {
  ensureRow(cursorRow);

  if (mode === 2) {
    screenLines = [[]];
    cursorRow = 0;
    cursorCol = 0;
    return;
  }

  if (mode === 1) {
    for (let r = 0; r < cursorRow; r += 1) {
      screenLines[r] = [];
    }
    const line = screenLines[cursorRow];
    const end = Math.min(cursorCol + 1, line.length);
    for (let i = 0; i < end; i += 1) {
      line[i] = blankCell();
    }
    return;
  }

  eraseInLine(0);
  if (cursorRow + 1 < screenLines.length) {
    screenLines.splice(cursorRow + 1);
  }
}

function csiValue(raw, fallback = 1) {
  if (raw === "" || raw == null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function processCsi(paramsRaw, finalChar) {
  const params = paramsRaw === "" ? [] : paramsRaw.split(";");

  if (finalChar === "m") {
    applySgr(ansiState, paramsRaw);
    return;
  }

  if (finalChar === "K") {
    eraseInLine(csiValue(params[0], 0));
    return;
  }

  if (finalChar === "J") {
    eraseInDisplay(csiValue(params[0], 0));
    return;
  }

  if (finalChar === "A") {
    cursorRow = Math.max(0, cursorRow - csiValue(params[0], 1));
    ensureRow(cursorRow);
    return;
  }

  if (finalChar === "B") {
    cursorRow += csiValue(params[0], 1);
    ensureRow(cursorRow);
    clampAndTrimRows();
    return;
  }

  if (finalChar === "C") {
    cursorCol += csiValue(params[0], 1);
    if (terminalCols > 0) cursorCol = Math.min(cursorCol, terminalCols - 1);
    return;
  }

  if (finalChar === "D") {
    cursorCol = Math.max(0, cursorCol - csiValue(params[0], 1));
    return;
  }

  if (finalChar === "G") {
    cursorCol = Math.max(0, csiValue(params[0], 1) - 1);
    if (terminalCols > 0) cursorCol = Math.min(cursorCol, terminalCols - 1);
    return;
  }

  if (finalChar === "H" || finalChar === "f") {
    const row = Math.max(1, csiValue(params[0], 1)) - 1;
    const col = Math.max(1, csiValue(params[1], 1)) - 1;
    cursorRow = row;
    cursorCol = col;
    if (terminalCols > 0) cursorCol = Math.min(cursorCol, terminalCols - 1);
    ensureRow(cursorRow);
    clampAndTrimRows();
    return;
  }

  if (finalChar === "P") {
    ensureRow(cursorRow);
    const line = screenLines[cursorRow];
    if (cursorCol < line.length) {
      line.splice(cursorCol, csiValue(params[0], 1));
    }
    return;
  }

  if (finalChar === "@") {
    ensureRow(cursorRow);
    const line = screenLines[cursorRow];
    const count = csiValue(params[0], 1);
    ensureCol(line, cursorCol);
    for (let i = 0; i < count; i += 1) {
      line.splice(cursorCol, 0, blankCell());
    }
  }
}

function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(renderScreen);
}

function renderScreen() {
  renderScheduled = false;

  const fragment = document.createDocumentFragment();
  const rows = screenLines.length > 0 ? screenLines : [[]];

  for (let r = 0; r < rows.length; r += 1) {
    const line = rows[r];
    let cursorAt = -1;
    if (r === cursorRow) {
      cursorAt = Math.max(0, cursorCol);
      if (cursorAt < line.length && line[cursorAt] && line[cursorAt].cont) {
        cursorAt = Math.max(0, cursorAt - 1);
      }
    }

    let runStyle = null;
    let runText = "";

    const flushRun = () => {
      if (!runText) return;
      if (runStyle) {
        const span = document.createElement("span");
        span.style.cssText = runStyle;
        span.textContent = runText;
        fragment.appendChild(span);
      } else {
        fragment.appendChild(document.createTextNode(runText));
      }
      runText = "";
    };

    const maxCols = cursorAt >= 0 ? Math.max(line.length, cursorAt + 1) : line.length;
    for (let c = 0; c < maxCols; c += 1) {
      if (c === cursorAt) {
        flushRun();
        const cell = line[c] || blankCell();
        const cursorSpan = document.createElement("span");
        cursorSpan.className = "terminal-cursor";
        if (cell.style) cursorSpan.style.cssText = cell.style;
        cursorSpan.textContent = cell.cont ? " " : (cell.ch || " ");
        fragment.appendChild(cursorSpan);
        if (cell.wide) {
          c += 1;
        }
        continue;
      }

      const cell = line[c] || { ch: " ", style: "" };
      if (cell.cont) continue;
      const style = cell.style || "";
      if (style !== runStyle) {
        flushRun();
        runStyle = style;
      }
      runText += cell.ch || " ";
    }

    flushRun();
    if (r < rows.length - 1) {
      fragment.appendChild(document.createTextNode("\n"));
    }
  }

  terminalEl.replaceChildren(fragment);
  terminalContainer.scrollTop = terminalContainer.scrollHeight;
}

function processTerminalData(rawText) {
  const input = ansiRemainder + rawText;
  ansiRemainder = "";

  let i = 0;
  while (i < input.length) {
    const ch = input[i];

    if (ch === "\x1b") {
      if (i + 1 >= input.length) {
        ansiRemainder = input.slice(i);
        break;
      }

      const next = input[i + 1];

      if (next === "[") {
        let j = i + 2;
        while (j < input.length) {
          const code = input.charCodeAt(j);
          if (code >= 0x40 && code <= 0x7e) break;
          j += 1;
        }

        if (j >= input.length) {
          ansiRemainder = input.slice(i);
          break;
        }

        const finalChar = input[j];
        const params = input.slice(i + 2, j);
        processCsi(params, finalChar);
        i = j + 1;
        continue;
      }

      if (next === "]") {
        const bel = input.indexOf("\x07", i + 2);
        const st = input.indexOf("\x1b\\", i + 2);
        if (bel === -1 && st === -1) {
          ansiRemainder = input.slice(i);
          break;
        }
        let endIdx = -1;
        if (bel !== -1 && st !== -1) endIdx = Math.min(bel, st);
        else endIdx = bel !== -1 ? bel : st;
        i = endIdx + (endIdx === st ? 2 : 1);
        continue;
      }

      if (next === "c") {
        ansiState = createDefaultAnsiState();
        screenLines = [[]];
        cursorRow = 0;
        cursorCol = 0;
        i += 2;
        continue;
      }

      i += 2;
      continue;
    }

    if (ch === "\r") {
      if (i + 1 < input.length && input[i + 1] === "\n") {
        lineFeed();
        i += 2;
      } else {
        carriageReturn();
        i += 1;
      }
      continue;
    }

    if (ch === "\n") {
      lineFeed();
      i += 1;
      continue;
    }

    if (ch === "\b") {
      backspace();
      i += 1;
      continue;
    }

    if (ch === "\t") {
      let spaces = 8 - (cursorCol % 8);
      if (spaces === 0) spaces = 8;
      for (let s = 0; s < spaces; s += 1) {
        putChar(" ");
      }
      i += 1;
      continue;
    }

    if (ch >= " ") {
      putChar(ch);
    }

    i += 1;
  }

  scheduleRender();
}

function resetTerminalBuffer() {
  ansiRemainder = "";
  ansiState = createDefaultAnsiState();
  screenLines = [[]];
  cursorRow = 0;
  cursorCol = 0;
  const size = computeSize();
  terminalCols = size.cols;
  scheduleRender();
}

function computeSize() {
  const probe = document.createElement("span");
  probe.textContent = "MMMMMMMMMM";
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.font = getComputedStyle(terminalEl).font;
  terminalContainer.appendChild(probe);
  const charWidth = probe.getBoundingClientRect().width / 10 || 8;
  const lineHeight = parseFloat(getComputedStyle(terminalEl).lineHeight) || 18;
  probe.remove();

  const rect = terminalContainer.getBoundingClientRect();
  const cols = Math.max(20, Math.floor((rect.width - 12) / charWidth));
  const rows = Math.max(8, Math.floor((rect.height - 8) / lineHeight));
  return { cols, rows };
}

function queueInput(data) {
  if (!sid || !data) return;
  inputQueue += data;
  if (flushTimer) return;
  flushTimer = window.setTimeout(flushInputQueue, 16);
}

async function flushInputQueue() {
  flushTimer = null;
  if (!sid || !inputQueue) return;
  const data = inputQueue;
  inputQueue = "";
  try {
    await requestJson("/api/input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sid, data }),
    });
  } catch (error) {
    if (error.status === 401) {
      await handleUnauthorized();
      return;
    }
    setStatus(`输入发送失败: ${error.message}`);
  }
}

function keyToInput(event) {
  if (event.metaKey) return null;

  if (event.ctrlKey && !event.altKey && event.key.length === 1) {
    const ch = event.key.toUpperCase().charCodeAt(0);
    if (ch >= 65 && ch <= 90) {
      return String.fromCharCode(ch - 64);
    }
    if (event.key === " ") {
      return "\x00";
    }
  }

  if (event.altKey && !event.ctrlKey && event.key.length === 1) {
    return `\x1b${event.key}`;
  }

  switch (event.key) {
    case "Enter":
      return "\r";
    case "Backspace":
      return "\x7f";
    case "Tab":
      return "\t";
    case "Escape":
      return "\x1b";
    case "ArrowUp":
      return "\x1b[A";
    case "ArrowDown":
      return "\x1b[B";
    case "ArrowRight":
      return "\x1b[C";
    case "ArrowLeft":
      return "\x1b[D";
    case "Home":
      return "\x1b[H";
    case "End":
      return "\x1b[F";
    case "Delete":
      return "\x1b[3~";
    case "PageUp":
      return "\x1b[5~";
    case "PageDown":
      return "\x1b[6~";
    default:
      break;
  }

  if (!event.ctrlKey && !event.altKey && event.key.length === 1) {
    return event.key;
  }
  return null;
}

async function sendResize() {
  if (!sid) return;
  const { cols, rows } = computeSize();
  terminalCols = cols;
  try {
    await requestJson("/api/resize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sid, cols, rows }),
    });
  } catch (error) {
    if (error.status === 401) {
      await handleUnauthorized();
    }
  }
}

let resizeTimer = null;
function scheduleResize() {
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    resizeTimer = null;
    sendResize();
  }, 150);
}

async function createSession() {
  const { cols, rows } = computeSize();
  terminalCols = cols;
  const payload = await requestJson("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cols, rows }),
  });
  sid = payload.sid;
  setStatus(`${sid.slice(0, 8)}(root)`);
}

async function closeSession() {
  running = false;
  inputQueue = "";
  if (!sid) return;
  const oldSid = sid;
  sid = "";
  try {
    await requestJson("/api/close", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sid: oldSid }),
    });
  } catch {
    // Ignore if session already closed.
  }
}

async function pollOutput() {
  running = true;
  const token = ++loopToken;

  while (running && sid && token === loopToken) {
    try {
      const payload = await requestJson(`/api/read?sid=${encodeURIComponent(sid)}&timeout=${READ_TIMEOUT_SEC}`);
      if (payload.data) processTerminalData(payload.data);
      if (payload.closed) {
        setStatus(`会话已关闭，退出码: ${payload.exitCode ?? "unknown"}`);
        running = false;
        sid = "";
        break;
      }
    } catch (error) {
      if (error.status === 401) {
        await handleUnauthorized();
        break;
      }
      setStatus(`连接中断: ${error.message}`);
      running = false;
      break;
    }
  }
}

async function connectTerminal(resetBuffer = false) {
  await closeSession();
  if (resetBuffer) resetTerminalBuffer();

  try {
    setStatus("正在创建 root bash 会话...");
    await createSession();
    await sendResize();
    terminalContainer.focus();
    pollOutput();
  } catch (error) {
    if (error.status === 401) {
      await handleUnauthorized();
      return;
    }
    setStatus(`连接失败: ${error.message}`);
  }
}

async function handleUnauthorized() {
  await closeSession();
  showAuth("login", "会话已失效，请重新输入访问密码。");
}

async function loadAuthState() {
  const state = await requestJson("/api/auth/state");
  if (!state.configured) {
    showAuth("setup", "首次使用请先设置访问密码（至少 8 位）。");
    return;
  }

  if (!state.authenticated) {
    showAuth("login", "请输入你之前设置的访问密码。");
    return;
  }

  showTerminal();
  await connectTerminal(false);
}

setupFormEl.addEventListener("submit", async (event) => {
  event.preventDefault();
  const p1 = setupPasswordEl.value;
  const p2 = setupPassword2El.value;

  if (p1.length < MIN_PASSWORD_LEN) {
    setAuthError(`密码长度不能小于 ${MIN_PASSWORD_LEN} 位`);
    return;
  }
  if (p1 !== p2) {
    setAuthError("两次输入密码不一致");
    return;
  }

  try {
    await requestJson("/api/auth/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: p1 }),
    });
    showTerminal();
    resetTerminalBuffer();
    await connectTerminal(false);
  } catch (error) {
    setAuthError(error.message);
  }
});

loginFormEl.addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = loginPasswordEl.value;
  if (!password) {
    setAuthError("请输入访问密码");
    return;
  }

  try {
    await requestJson("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    showTerminal();
    resetTerminalBuffer();
    await connectTerminal(false);
  } catch (error) {
    setAuthError(error.message);
  }
});

logoutBtn.addEventListener("click", async () => {
  try {
    await requestJson("/api/auth/logout", { method: "POST" });
  } catch {
    // Logout best-effort.
  }
  await closeSession();
  showAuth("login", "已退出登录。请输入访问密码继续。");
});

terminalContainer.addEventListener("click", () => terminalContainer.focus());
terminalContainer.addEventListener("keydown", (event) => {
  const data = keyToInput(event);
  if (data === null) return;
  event.preventDefault();
  queueInput(data);
});

terminalContainer.addEventListener("paste", (event) => {
  event.preventDefault();
  const text = event.clipboardData.getData("text");
  queueInput(text);
});

window.addEventListener("resize", scheduleResize);
window.addEventListener("beforeunload", () => {
  closeSession();
});

clearBtn.addEventListener("click", () => {
  resetTerminalBuffer();
  if (sid) {
    queueInput("\x0c");
  }
  terminalContainer.focus();
});

ctrlCBtn.addEventListener("click", () => {
  queueInput("\x03");
  terminalContainer.focus();
});

reconnectBtn.addEventListener("click", () => {
  resetTerminalBuffer();
  connectTerminal(false);
});

loadAuthState().catch((error) => {
  showAuth("login", "无法获取鉴权状态，请稍后重试。");
  setAuthError(error.message);
});
