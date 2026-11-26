# Contributing

Thanks for considering a contribution.

1. Fork the repository and create a branch.
2. Keep changes consistent with the existing style:
   - `dashboard/plugin_api.py` — one file, standard library + FastAPI/cryptography,
     no new service dependencies.
   - `desktop/plugin.js` — loaded uncompiled; imports only
     `@hermes/plugin-sdk`, `react`, `react/jsx-runtime`; use `jsx()`/`jsxs()`,
     no JSX syntax and no build step.
3. Add tests for backend/agent changes in `tests/test_plugin.py` and run:

   ```bash
   ./tests/run.sh
   cp desktop/plugin.js /tmp/plugin.mjs && node --check /tmp/plugin.mjs
   ```

4. Do not commit secrets, real connection files, or screenshots with real
   customer data. Use a demo database and placeholder hosts (`example.com`).
5. Open a pull request describing the change, the user-visible behaviour and
   how you tested it.

New features that touch writes, tunnels or credentials should update
`SECURITY.md` and the user guide.
