# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for the DB Desk sidecar (onedir — fast cold start)."""

from PyInstaller.utils.hooks import collect_all, collect_data_files, collect_submodules

datas = []
binaries = []
hiddenimports = collect_submodules("uvicorn") + [
    "fastapi",
    "mcp_gateway",
    "mcp_stdio",
    "starlette",
    "anyio",
    "cryptography",
    "uvicorn.logging",
    "uvicorn.loops.auto",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.lifespan.on",
]

# CA bundle for outbound HTTPS (AI providers, MCP gateways).
datas += collect_data_files("certifi")

# Native drivers: psycopg needs its bundled libpq, PyMySQL is pure Python.
for package in ("psycopg", "psycopg_binary", "pymysql", "pymongo", "bson", "redis"):
    try:
        package_datas, package_binaries, package_hidden = collect_all(package)
    except Exception:
        continue
    datas += package_datas
    binaries += package_binaries
    hiddenimports += package_hidden

a = Analysis(
    ["app.py"],
    pathex=["."],
    binaries=binaries,
    datas=datas + [("../ui/dist", "ui/dist")],
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
    [],
    exclude_binaries=True,
    name="dbdesk-server",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="dbdesk-server",
)
