# Signing & notarization

[← Back to the README](../README.md)

The default CI builds are **unsigned** and free: they run on your own Mac after
the steps below. Signing + notarization is only needed for clean distribution to
other people, and requires a paid Apple Developer account.

### Install an unsigned build (no Apple Developer account)

**Build it on the Mac that will run it** — locally built apps are not
quarantined, so Gatekeeper does not complain at all:

```bash
git clone https://github.com/wzul/dbdesk-app
cd dbdesk-app
make install          # Node, Python deps
make bundle           # Python + Rust toolchain required
open "src-tauri/target/release/bundle/macos/DB Desk.app"
```

**Or download the CI DMG**, drag **DB Desk** to Applications, then:

- macOS 15+: open it once, then **System Settings → Privacy & Security → Open
  Anyway**; or
- remove the quarantine flag:

  ```bash
  xattr -dr com.apple.quarantine "/Applications/DB Desk.app"
  ```

Only do this for a build you trust (this repository's CI or your own).

### What you need

1. **Apple Developer Program** membership (paid, currently US$99/year).
2. A **Developer ID Application** certificate — not “Apple Development”.
3. Your **Team ID** (developer.apple.com → Membership).
4. Notarization credentials: either an **app-specific password** for your Apple
   ID, or an **App Store Connect API key**.

### Create the certificate

On a Mac, either:

- Xcode → Settings → Accounts → select your team → **Manage Certificates** → **+**
  → **Developer ID Application**, or
- developer.apple.com → Certificates, Identifiers & Profiles → **+** →
  **Developer ID Application** (upload a CSR made with Keychain Access).

Then export it: Keychain Access → **My Certificates** → right-click
`Developer ID Application: …` → **Export** → `.p12` with a password.

```bash
security find-identity -v -p codesigning
# "Developer ID Application: Your Name (ABCDE12345)"
```

### Add the GitHub secrets

```bash
# certificate (.p12) as base64
base64 -i DeveloperID.p12 | gh secret set APPLE_CERTIFICATE
gh secret set APPLE_CERTIFICATE_PASSWORD   # the .p12 password
gh secret set APPLE_SIGNING_IDENTITY --body "Developer ID Application: Your Name (ABCDE12345)"
gh secret set APPLE_TEAM_ID --body "ABCDE12345"

# notarization: Apple ID + app-specific password (appleid.apple.com → Sign-in
# and Security → App-Specific Passwords)
gh secret set APPLE_ID --body "you@example.com"
gh secret set APPLE_PASSWORD
```

API-key alternative (better for CI, no password/2FA):

```bash
gh secret set APPLE_API_ISSUER --body "<issuer-uuid>"
gh secret set APPLE_API_KEY --body "<key-id>"
# write AuthKey_<key-id>.p8 from a secret to a file before the build step
```

Tauri reads these environment variables directly; the workflow already passes
them through, and only signs when `APPLE_SIGNING_IDENTITY` is set.

### What the workflow does

1. Imports the `.p12` and signs `dbdesk-server` on its own with hardened runtime
   and the entitlements below (nested binaries must be signed before notarizing
   the app).
2. `tauri build` signs `DB Desk.app` (hardened runtime), notarizes it with
   `notarytool`, and staples the ticket.
3. Verifies with `codesign` and `spctl`.
4. Produces `DB Desk_<version>_<arch>.dmg`.

### Entitlements

`src-tauri/entitlements.plist` disables **library validation**:

```xml
<key>com.apple.security.cs.disable-library-validation</key>
<true/>
```

The Python sidecar is a PyInstaller one-file binary. On launch it extracts its
dylibs to a temp directory and `dlopen()`s them. Hardened runtime (required for
notarization) refuses to load libraries not signed by the same Team ID, so
without this entitlement the notarized app starts and then the backend dies.
`com.apple.security.cs.allow-unsigned-executable-memory` covers Python
extensions that map executable memory at runtime.

### Verify a build

```bash
codesign --verify --deep --strict --verbose=2 "DB Desk.app"
codesign -dv --verbose=4 "DB Desk.app"     # TeamIdentifier + hardened runtime
spctl --assess --type execute --verbose=2 "DB Desk.app"   # accepted / notarized
xcrun stapler validate "DB Desk.app"
```

If the DMG itself is not stapled (the app inside is), submit and staple it once:

```bash
xcrun notarytool submit "DB Desk_0.1.0_aarch64.dmg" \
  --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_PASSWORD" --wait
xcrun stapler staple "DB Desk_0.1.0_aarch64.dmg"
```

### Local signed build

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (ABCDE12345)"
export APPLE_ID="you@example.com" APPLE_PASSWORD="app-specific-password" APPLE_TEAM_ID="ABCDE12345"
make bundle
```

Keep the `.p12` and passwords out of the repo; the certificate can be revoked
from developer.apple.com if it leaks.
