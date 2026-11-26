# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for the DB Desk sidecar (onedir — fast cold start)."""

import importlib.util

from PyInstaller.utils.hooks import collect_all, collect_data_files, collect_submodules

datas = []
binaries = []


def _present(*names):
    """Only ask for what this platform actually installs.

    Windows on ARM has pycryptodome instead of cryptography (see the requirement
    comments), and a hard-coded hidden import that cannot be found is noise at best.
    """
    return [name for name in names if importlib.util.find_spec(name) is not None]


hiddenimports = collect_submodules("uvicorn") + _present(
    "cryptography", "Crypto", "Crypto.Cipher.AES"
) + [
    "fastapi",
    "mcp_gateway",
    "mcp_stdio",
    "starlette",
    "anyio",
    "uvicorn.logging",
    "uvicorn.loops.auto",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.lifespan.on",
]

# CA bundle for outbound HTTPS (AI providers, MCP gateways).
datas += collect_data_files("certifi")

# Native drivers: psycopg needs its bundled libpq, PyMySQL is pure Python.
for package in ("psycopg", "psycopg_binary", "pymysql", "pymongo", "bson", "redis", "Crypto"):
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
