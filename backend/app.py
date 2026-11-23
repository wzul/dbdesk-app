"""Standalone DB Desk server — REST API plus the built UI.

Runs without Hermes: one local process bound to 127.0.0.1 that serves
``/api/*`` (the same routes the Hermes plugin exposes) and the static page.

    python app.py            # http://127.0.0.1:8765
    PORT=9000 python app.py  # custom port

Storage defaults to the platform's application-data directory:

    macOS    ~/Library/Application Support/DB Desk/data
    Linux    ~/.local/share/dbdesk/data
    Windows  %APPDATA%\\DB Desk\\data

Set ``DBDESK_HOME`` to override it.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

APP_NAME = "DB Desk"
VERSION = "0.7.4"


def _app_home() -> Path:
    override = os.environ.get("DBDESK_HOME")
    if override:
        return Path(override).expanduser()
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / APP_NAME
    if os.name == "nt":
        return Path(os.environ.get("APPDATA") or Path.home()) / APP_NAME
    return Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share") / "dbdesk"


# The adapter module reads DBDESK_HOME when it resolves its data directory.
os.environ.setdefault("DBDESK_HOME", str(_app_home()))

from fastapi import FastAPI  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.responses import FileResponse, JSONResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402

from dbdesk_api import router  # noqa: E402

HERE = Path(__file__).resolve().parent


def _ui_dir() -> Path:
    override = os.environ.get("DBDESK_UI")
    if override:
        return Path(override)
    base = Path(getattr(sys, "_MEIPASS", HERE.parent))
    return base / "ui" / "dist"


UI_DIR = _ui_dir()

app = FastAPI(title=APP_NAME, version=VERSION, docs_url=None, redoc_url=None, openapi_url=None)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(router, prefix="/api")


@app.get("/health")
async def health() -> dict[str, object]:
    return {"ok": True, "app": APP_NAME, "version": VERSION, "home": str(_app_home())}


if (UI_DIR / "assets").is_dir():
    app.mount("/assets", StaticFiles(directory=UI_DIR / "assets"), name="assets")


@app.get("/{path:path}")
async def spa(path: str):
    if not (UI_DIR / "index.html").is_file():
        return JSONResponse(
            {"detail": "UI is not built yet — run `npm --prefix ui run build`."},
            status_code=503,
        )
    candidate = (UI_DIR / path).resolve()
    if path and candidate.is_file() and UI_DIR.resolve() in candidate.parents:
        return FileResponse(candidate)
    return FileResponse(UI_DIR / "index.html")


def main() -> None:
    import uvicorn

    host = os.environ.get("HOST") or "127.0.0.1"
    port = int(os.environ.get("PORT") or os.environ.get("DBDESK_PORT") or 8765)
    if os.environ.get("DBDESK_OPEN") == "1":
        import threading
        import webbrowser

        threading.Timer(1.0, lambda: webbrowser.open(f"http://{host}:{port}")).start()
    print(f"{APP_NAME} {VERSION} · http://{host}:{port} · data: {_app_home()}")
    uvicorn.run(app, host=host, port=port, log_level=os.environ.get("LOG_LEVEL") or "warning")


if __name__ == "__main__":
    main()
