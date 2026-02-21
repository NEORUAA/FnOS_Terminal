#!/usr/bin/env python3
import argparse
import hashlib
import hmac
import json
import os
import pty
import secrets
import signal
import struct
import subprocess
import threading
import time
import uuid
from http import HTTPStatus
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Optional
from urllib.parse import parse_qs, urlparse

import fcntl
import termios


DEFAULT_PORT = 38473
READ_CHUNK_SIZE = 8192
MAX_BUFFER_BYTES = 1024 * 1024
SESSION_IDLE_TIMEOUT_SEC = 30 * 60
READ_TIMEOUT_SEC = 20
AUTH_MIN_PASSWORD_LEN = 8
AUTH_MAX_PASSWORD_LEN = 128
AUTH_COOKIE_NAME = "fnos_terminal_auth"
AUTH_SESSION_IDLE_TIMEOUT_SEC = 12 * 60 * 60

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".txt": "text/plain; charset=utf-8",
}

class AuthManager:
    def __init__(self, auth_file: Path):
        self._auth_file = auth_file
        self._lock = threading.Lock()
        self._credential = None
        self._sessions = {}
        self._last_cleanup = 0
        self._load_credential()

    def _load_credential(self):
        if not self._auth_file.exists():
            self._credential = None
            return

        try:
            data = json.loads(self._auth_file.read_text(encoding="utf-8"))
            salt = bytes.fromhex(data["salt"])
            digest = bytes.fromhex(data["hash"])
            iterations = int(data.get("iterations", 200000))
            if not salt or not digest or iterations <= 0:
                self._credential = None
                return
            self._credential = {
                "salt": salt,
                "hash": digest,
                "iterations": iterations,
            }
        except Exception:
            self._credential = None

    def _hash_password(self, password: str, salt: bytes, iterations: int) -> bytes:
        return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations, dklen=32)

    def _save_credential(self, salt: bytes, digest: bytes, iterations: int):
        self._auth_file.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "salt": salt.hex(),
            "hash": digest.hex(),
            "iterations": iterations,
        }
        tmp_file = self._auth_file.with_suffix(".tmp")
        tmp_file.write_text(json.dumps(payload), encoding="utf-8")
        os.chmod(tmp_file, 0o600)
        os.replace(tmp_file, self._auth_file)

    @property
    def is_configured(self) -> bool:
        with self._lock:
            return self._credential is not None

    def setup_password(self, password: str) -> bool:
        with self._lock:
            if self._credential is not None:
                return False
            salt = secrets.token_bytes(16)
            iterations = 200000
            digest = self._hash_password(password, salt, iterations)
            self._save_credential(salt, digest, iterations)
            self._credential = {
                "salt": salt,
                "hash": digest,
                "iterations": iterations,
            }
            return True

    def verify_password(self, password: str) -> bool:
        with self._lock:
            if self._credential is None:
                return False
            expected = self._credential["hash"]
            digest = self._hash_password(password, self._credential["salt"], self._credential["iterations"])
            return hmac.compare_digest(digest, expected)

    def create_auth_session(self) -> str:
        with self._lock:
            token = secrets.token_urlsafe(32)
            now = time.time()
            self._sessions[token] = {
                "created_at": now,
                "last_active": now,
            }
            return token

    def validate_auth_session(self, token: Optional[str]) -> bool:
        if not token:
            return False

        with self._lock:
            self._cleanup_sessions_locked()
            session = self._sessions.get(token)
            if not session:
                return False
            session["last_active"] = time.time()
            return True

    def destroy_auth_session(self, token: Optional[str]):
        if not token:
            return
        with self._lock:
            self._sessions.pop(token, None)

    def _cleanup_sessions_locked(self):
        now = time.time()
        if now - self._last_cleanup < 60:
            return

        self._last_cleanup = now
        stale = []
        for token, item in self._sessions.items():
            if now - item["last_active"] > AUTH_SESSION_IDLE_TIMEOUT_SEC:
                stale.append(token)
        for token in stale:
            self._sessions.pop(token, None)


class TerminalSession:
    def __init__(self, shell="/bin/bash", cols=120, rows=30):
        self.id = uuid.uuid4().hex
        self.created_at = time.time()
        self.last_active = self.created_at
        self._closed = False
        self._master_fd = None
        self._process = None
        self._buffer = bytearray()
        self._lock = threading.Lock()
        self._cond = threading.Condition(self._lock)

        master_fd, slave_fd = pty.openpty()
        self._master_fd = master_fd

        env = os.environ.copy()
        env.setdefault("TERM", "xterm-256color")
        env.setdefault("LANG", "C.UTF-8")
        cwd = env.get("TRIM_PKGHOME", "/")

        # Use a single shared history file with SSH so records interleave
        # naturally by execution order in both SSH and app terminals.
        ssh_hist_file = Path(env.get("HOME", "/root")) / ".bash_history"
        hist_file = ssh_hist_file
        try:
            ssh_hist_file.parent.mkdir(parents=True, exist_ok=True)
            if not ssh_hist_file.exists():
                ssh_hist_file.touch(mode=0o600, exist_ok=True)
            else:
                os.chmod(ssh_hist_file, 0o600)
        except Exception:
            hist_file = Path(cwd) / ".bash_history"
            hist_file.parent.mkdir(parents=True, exist_ok=True)
            if not hist_file.exists():
                hist_file.touch(mode=0o600, exist_ok=True)
            else:
                os.chmod(hist_file, 0o600)

        env["HISTFILE"] = str(hist_file)
        env.setdefault("HISTSIZE", "5000")
        env.setdefault("HISTFILESIZE", "20000")
        env.setdefault("HISTCONTROL", "ignoredups:erasedups")
        history_sync_cmd = "history -a; history -n"
        current_prompt_command = (env.get("PROMPT_COMMAND") or "").strip()
        if current_prompt_command:
            if history_sync_cmd not in current_prompt_command:
                env["PROMPT_COMMAND"] = f"{history_sync_cmd}; {current_prompt_command}"
        else:
            env["PROMPT_COMMAND"] = history_sync_cmd

        shell_args = [shell, "-i"]
        self._process = subprocess.Popen(
            shell_args,
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            env=env,
            cwd=cwd,
            preexec_fn=os.setsid,
            close_fds=True,
        )
        os.close(slave_fd)
        self.resize(cols=cols, rows=rows)

        self._reader_thread = threading.Thread(target=self._read_output_loop, daemon=True)
        self._reader_thread.start()

    def _read_output_loop(self):
        while not self._closed:
            try:
                chunk = os.read(self._master_fd, READ_CHUNK_SIZE)
            except OSError:
                break

            if not chunk:
                break

            with self._cond:
                self._buffer.extend(chunk)
                if len(self._buffer) > MAX_BUFFER_BYTES:
                    overflow = len(self._buffer) - MAX_BUFFER_BYTES
                    del self._buffer[:overflow]
                self.last_active = time.time()
                self._cond.notify_all()

        with self._cond:
            self._closed = True
            self._cond.notify_all()

    def write_input(self, data: bytes):
        if not data:
            return
        with self._cond:
            if self._closed:
                return
        os.write(self._master_fd, data)
        with self._cond:
            self.last_active = time.time()

    def read_output(self, timeout=READ_TIMEOUT_SEC, max_bytes=READ_CHUNK_SIZE * 8) -> bytes:
        deadline = time.time() + max(0, timeout)
        with self._cond:
            while not self._buffer and not self._closed:
                remaining = deadline - time.time()
                if remaining <= 0:
                    return b""
                self._cond.wait(timeout=remaining)

            if not self._buffer:
                return b""

            data = bytes(self._buffer[:max_bytes])
            del self._buffer[:max_bytes]
            self.last_active = time.time()
            return data

    def resize(self, cols=120, rows=30):
        cols = max(20, int(cols))
        rows = max(8, int(rows))
        size = struct.pack("HHHH", rows, cols, 0, 0)
        fcntl.ioctl(self._master_fd, termios.TIOCSWINSZ, size)
        self.last_active = time.time()

    @property
    def has_pending_output(self):
        with self._lock:
            return bool(self._buffer)

    @property
    def is_closed(self):
        with self._lock:
            return self._closed

    @property
    def exit_code(self):
        if self._process is None:
            return None
        return self._process.poll()

    def close(self):
        with self._cond:
            if self._closed:
                return
            self._closed = True
            self._cond.notify_all()

        if self._process and self._process.poll() is None:
            try:
                os.killpg(self._process.pid, signal.SIGTERM)
                self._process.wait(timeout=2)
            except Exception:
                try:
                    os.killpg(self._process.pid, signal.SIGKILL)
                except Exception:
                    pass

        if self._master_fd is not None:
            try:
                os.close(self._master_fd)
            except OSError:
                pass
            self._master_fd = None


class SessionManager:
    def __init__(self):
        self._sessions = {}
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._reaper = threading.Thread(target=self._cleanup_loop, daemon=True)
        self._reaper.start()

    def create(self, cols=120, rows=30) -> TerminalSession:
        session = TerminalSession(cols=cols, rows=rows)
        with self._lock:
            self._sessions[session.id] = session
        return session

    def get(self, sid) -> Optional[TerminalSession]:
        with self._lock:
            return self._sessions.get(sid)

    def close(self, sid):
        session = None
        with self._lock:
            session = self._sessions.pop(sid, None)
        if session:
            session.close()

    def close_all(self):
        with self._lock:
            sessions = list(self._sessions.values())
            self._sessions.clear()
        for session in sessions:
            session.close()
        self._stop.set()

    def _cleanup_loop(self):
        while not self._stop.is_set():
            now = time.time()
            stale_ids = []
            with self._lock:
                for sid, session in self._sessions.items():
                    inactive_for = now - session.last_active
                    if inactive_for > SESSION_IDLE_TIMEOUT_SEC:
                        stale_ids.append(sid)
                    elif session.is_closed and not session.has_pending_output:
                        stale_ids.append(sid)
            for sid in stale_ids:
                self.close(sid)
            self._stop.wait(timeout=60)


class TerminalHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    manager: SessionManager = None
    auth: AuthManager = None
    ui_dir: Path = None

    def _send_response(self, status, body, content_type="application/json; charset=utf-8", headers=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        if headers:
            for key, value in headers:
                self.send_header(key, value)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, status, payload, headers=None):
        body = json.dumps(payload).encode("utf-8")
        self._send_response(status, body, headers=headers)

    def _get_content_length(self) -> int:
        try:
            return int(self.headers.get("Content-Length", "0") or "0")
        except (TypeError, ValueError):
            return 0

    def _read_body(self):
        content_length = self._get_content_length()
        if content_length <= 0:
            return b""
        return self.rfile.read(content_length)

    def _drain_request_body(self):
        content_length = self._get_content_length()
        if content_length <= 0:
            return
        try:
            self.rfile.read(content_length)
        except Exception:
            # Best-effort body drain to keep HTTP/1.1 connection parsable.
            pass

    def _parse_json_body(self):
        body = self._read_body()
        if not body:
            return {}
        try:
            return json.loads(body.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return {}

    def _get_cookie_value(self, name: str) -> Optional[str]:
        header = self.headers.get("Cookie")
        if not header:
            return None
        jar = cookies.SimpleCookie()
        try:
            jar.load(header)
        except Exception:
            return None
        morsel = jar.get(name)
        if not morsel:
            return None
        return morsel.value

    def _get_header_auth_token(self) -> Optional[str]:
        token = self.headers.get("X-Auth-Token")
        if not token:
            return None
        token = token.strip()
        if not token or len(token) > 512:
            return None
        return token

    def _build_auth_cookie(self, token: str) -> str:
        return f"{AUTH_COOKIE_NAME}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={AUTH_SESSION_IDLE_TIMEOUT_SEC}"

    def _build_clear_auth_cookie(self) -> str:
        return f"{AUTH_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"

    def _is_authenticated(self) -> tuple[bool, Optional[str], Optional[str]]:
        header_token = self._get_header_auth_token()
        if self.auth.validate_auth_session(header_token):
            return True, header_token, "header"

        cookie_token = self._get_cookie_value(AUTH_COOKIE_NAME)
        if self.auth.validate_auth_session(cookie_token):
            return True, cookie_token, "cookie"

        if cookie_token:
            return False, cookie_token, "cookie"
        if header_token:
            return False, header_token, "header"
        return False, None, None

    def _require_auth(self) -> bool:
        ok, token, source = self._is_authenticated()
        if ok:
            return True

        # Drain unread POST body before responding 401, otherwise keep-alive
        # may treat payload bytes as the next request line (causing 501).
        self._drain_request_body()

        headers = None
        if source == "cookie" and token:
            headers = [("Set-Cookie", self._build_clear_auth_cookie())]
        self._send_json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"}, headers=headers)
        return False

    def _serve_static(self, parsed_path):
        target = parsed_path.path
        if target == "/":
            target = "/index.html"

        rel_path = target.lstrip("/")
        file_path = (self.ui_dir / rel_path).resolve()

        if not str(file_path).startswith(str(self.ui_dir.resolve())):
            self._send_json(HTTPStatus.FORBIDDEN, {"error": "forbidden"})
            return

        if not file_path.is_file():
            self._send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return

        content = file_path.read_bytes()
        content_type = CONTENT_TYPES.get(file_path.suffix.lower(), "application/octet-stream")
        self._send_response(HTTPStatus.OK, content, content_type=content_type)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/auth/state":
            self._handle_auth_state()
            return
        if parsed.path == "/api/read":
            if not self._require_auth():
                return
            self._handle_read(parsed)
            return

        self._serve_static(parsed)

    def do_POST(self):
        parsed = urlparse(self.path)

        if parsed.path == "/api/auth/setup":
            self._handle_auth_setup()
            return
        if parsed.path == "/api/auth/login":
            self._handle_auth_login()
            return
        if parsed.path == "/api/auth/logout":
            self._handle_auth_logout()
            return

        if not self._require_auth():
            return

        if parsed.path == "/api/session":
            self._handle_create_session()
        elif parsed.path == "/api/input":
            self._handle_input()
        elif parsed.path == "/api/resize":
            self._handle_resize()
        elif parsed.path == "/api/close":
            self._handle_close()
        else:
            self._send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def _handle_auth_state(self):
        authenticated, _, _ = self._is_authenticated()
        self._send_json(
            HTTPStatus.OK,
            {
                "configured": self.auth.is_configured,
                "authenticated": authenticated,
            },
        )

    def _validate_password_payload(self, payload):
        password = payload.get("password", "")
        if not isinstance(password, str):
            return None, "invalid password"
        if len(password) < AUTH_MIN_PASSWORD_LEN:
            return None, f"password must be at least {AUTH_MIN_PASSWORD_LEN} characters"
        if len(password) > AUTH_MAX_PASSWORD_LEN:
            return None, f"password must be <= {AUTH_MAX_PASSWORD_LEN} characters"
        return password, ""

    def _handle_auth_setup(self):
        if self.auth.is_configured:
            self._send_json(HTTPStatus.CONFLICT, {"error": "password already configured"})
            return

        payload = self._parse_json_body()
        password, message = self._validate_password_payload(payload)
        if not password:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": message})
            return

        if not self.auth.setup_password(password):
            self._send_json(HTTPStatus.CONFLICT, {"error": "password already configured"})
            return

        token = self.auth.create_auth_session()
        self._send_json(
            HTTPStatus.OK,
            {"ok": True, "configured": True, "authenticated": True, "authToken": token},
            headers=[("Set-Cookie", self._build_auth_cookie(token))],
        )

    def _handle_auth_login(self):
        if not self.auth.is_configured:
            self._send_json(HTTPStatus.CONFLICT, {"error": "password is not configured"})
            return

        payload = self._parse_json_body()
        password = payload.get("password", "")
        if not isinstance(password, str):
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid password"})
            return

        if not self.auth.verify_password(password):
            self._send_json(HTTPStatus.UNAUTHORIZED, {"error": "invalid password"})
            return

        token = self.auth.create_auth_session()
        self._send_json(
            HTTPStatus.OK,
            {"ok": True, "authenticated": True, "authToken": token},
            headers=[("Set-Cookie", self._build_auth_cookie(token))],
        )

    def _handle_auth_logout(self):
        cookie_token = self._get_cookie_value(AUTH_COOKIE_NAME)
        header_token = self._get_header_auth_token()
        self.auth.destroy_auth_session(cookie_token)
        if header_token and header_token != cookie_token:
            self.auth.destroy_auth_session(header_token)
        self._send_json(HTTPStatus.OK, {"ok": True}, headers=[("Set-Cookie", self._build_clear_auth_cookie())])

    def _get_session(self, sid):
        if not sid:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "missing sid"})
            return None
        session = self.manager.get(sid)
        if not session:
            self._send_json(HTTPStatus.NOT_FOUND, {"error": "session not found"})
            return None
        return session

    def _handle_create_session(self):
        payload = self._parse_json_body()
        cols = payload.get("cols", 120)
        rows = payload.get("rows", 30)
        session = self.manager.create(cols=cols, rows=rows)
        self._send_json(HTTPStatus.OK, {"sid": session.id})

    def _handle_input(self):
        payload = self._parse_json_body()
        sid = payload.get("sid")
        session = self._get_session(sid)
        if not session:
            return
        data = payload.get("data", "")
        if not isinstance(data, str):
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid input data"})
            return
        session.write_input(data.encode("utf-8", errors="ignore"))
        self._send_json(HTTPStatus.OK, {"ok": True})

    def _handle_resize(self):
        payload = self._parse_json_body()
        sid = payload.get("sid")
        session = self._get_session(sid)
        if not session:
            return

        try:
            cols = int(payload.get("cols", 120))
            rows = int(payload.get("rows", 30))
        except (TypeError, ValueError):
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid terminal size"})
            return

        session.resize(cols=cols, rows=rows)
        self._send_json(HTTPStatus.OK, {"ok": True})

    def _handle_read(self, parsed):
        query = parse_qs(parsed.query)
        sid = (query.get("sid") or [None])[0]
        timeout_value = (query.get("timeout") or [str(READ_TIMEOUT_SEC)])[0]

        session = self._get_session(sid)
        if not session:
            return

        try:
            timeout = max(0, min(30, int(timeout_value)))
        except ValueError:
            timeout = READ_TIMEOUT_SEC

        data = session.read_output(timeout=timeout)
        self._send_json(
            HTTPStatus.OK,
            {
                "data": data.decode("utf-8", errors="replace"),
                "closed": session.is_closed,
                "exitCode": session.exit_code,
            },
        )

    def _handle_close(self):
        payload = self._parse_json_body()
        sid = payload.get("sid")
        if not sid:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "missing sid"})
            return
        self.manager.close(sid)
        self._send_json(HTTPStatus.OK, {"ok": True})

    def log_message(self, fmt, *args):
        print("%s - - [%s] %s" % (self.address_string(), self.log_date_time_string(), fmt % args), flush=True)


def parse_args():
    parser = argparse.ArgumentParser(description="FnOS Terminal HTTP server")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", DEFAULT_PORT)))
    parser.add_argument("--ui-dir", default="")
    parser.add_argument("--auth-file", default=os.environ.get("AUTH_FILE", ""))
    return parser.parse_args()


def main():
    args = parse_args()
    base_dir = Path(__file__).resolve().parent.parent
    ui_dir = Path(args.ui_dir).resolve() if args.ui_dir else (base_dir / "ui").resolve()

    if args.auth_file:
        auth_file = Path(args.auth_file).resolve()
    else:
        auth_file = (base_dir / "terminal_auth.json").resolve()

    manager = SessionManager()
    auth = AuthManager(auth_file)

    TerminalHandler.manager = manager
    TerminalHandler.auth = auth
    TerminalHandler.ui_dir = ui_dir

    server = ThreadingHTTPServer((args.host, args.port), TerminalHandler)
    server.daemon_threads = True

    def _shutdown(*_):
        manager.close_all()
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)

    print(f"FnOS Terminal server listening on http://{args.host}:{args.port}", flush=True)
    print(f"Auth file: {auth_file}", flush=True)
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        manager.close_all()
        server.server_close()


if __name__ == "__main__":
    main()
