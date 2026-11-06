# MyDoc Vault

A private web app for storing and downloading your **ebooks** and **personal documents**.
It uses React for the frontend, Node.js/Express for the backend and Supabase Storage for the files.

## Features

- Username/password login. Every API call needs a valid session token.
- Sections:
  - **Ebooks**
  - **Personal Documents**: **Rakesh**, **Priyanka** and **Ananya**
- Upload with the button or by drag & drop. You can upload several files at once and see a progress bar for each.
- Files are stored **byte-for-byte as uploaded**: no compression or conversion, so they keep their original quality.
- Download keeps the original file name. You can also open a file in a new tab to preview it.
- Rename, delete, multi-select download/delete, search, and sort by name, size or date.
- Works on phones (the sidebar becomes a menu).
- The storage bucket is **private**. Downloads use short-lived signed links (5 minutes), and the Supabase secret key stays on the server.

## How it works

```
Browser (React) ──login──▶ Node/Express (checks username/password, issues a JWT)
        │                      │  uses the Supabase SECRET key (server only)
        │◀── signed upload/download URL ──┘
        └──── file bytes go directly to/from Supabase Storage (bucket "mydoc")
```

Files are stored in the bucket as `ebooks/…`, `rakesh/…`, `priyanka/…` and `ananya/…`.
The server creates the private bucket automatically on its first start.

## Setup

1. Install Node.js 18 or newer.
2. Create `server/.env` from the example:

   ```bash
   cp server/.env.example server/.env
   ```

   Then fill in the values: `APP_USERNAME`, `APP_PASSWORD`, `JWT_SECRET`, `SUPABASE_PUBLISHABLE_KEY` and `SUPABASE_SECRET_KEY`.
   **Never commit `server/.env`.** It is already listed in `.gitignore`.
3. Install the dependencies and run the app in development mode:

   ```bash
   npm install
   npm run install:all
   npm run dev
   ```

   Open http://localhost:5173.

## Production

```bash
npm run build
npm start
```

This starts a single Node server on `PORT` (default 4000) that serves both the API and the built React app.
It deploys as-is to Render, Railway, Fly.io or a VPS:

- Build command: `npm install && npm run build`
- Start command: `npm start`
- Set the variables from `server/.env.example` in the host's environment settings.

## File size limit

Uploads go straight from your browser to Supabase, so this server sets no size limit.
Supabase does: the global per-file limit is **50 MB on the Free plan**. On paid plans you can raise it under
*Supabase Dashboard → Storage → Settings*.
