# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for the DB Desk sidecar (one file, no external runtime)."""

from PyInstaller.utils.hooks import collect_submodules

hiddenimports = collect_submodules("uvicorn") + [
    "fastapi",
    "starlette",
    "anyio",
    "cryptography",
    "uvicorn.logging",
    "uvicorn.loops.auto",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.lifespan.on",
]

a = Analysis(
    ["app.py"],
    pathex=["."],
    binaries=[],
    datas=[("../ui/dist", "ui/dist")],
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=["tkinter", "pytest", "setuptools", "pip"],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="dbdesk-server",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
)
