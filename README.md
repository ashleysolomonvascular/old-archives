# Old archives

Personal, phone-first password vault (PWA). Static site, no backend; data lives only in the phone's IndexedDB, encrypted.

- KDF: Argon2id (hash-wasm, 64 MB / 3 iterations) → master key wraps a random vault key → AES-256-GCM.
- No third-party scripts at runtime; strict CSP. All dependencies are bundled.
- Master password is unrecoverable.

## Develop
    npm install
    npm test        # crypto round-trip, wrong password, tamper detection, backup restore
    npm run dev
    npm run build   # → dist/

## Deploy (GitHub Pages)
Repo Settings → Pages → Source: **GitHub Actions**. Merge to `main`; the workflow tests, builds and publishes.
The app uses relative paths, so it works under `https://<user>.github.io/old-archives/`.

## Stages
1. Vault core (this) · 2. Fingerprint unlock · 3. Drive auto-backup · 4. Memory Bank import · 5. TOTP
