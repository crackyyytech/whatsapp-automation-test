# WhatsApp Document Sender - Server

Node.js server that sends PDF documents to multiple WhatsApp numbers.
It is the backend for the VB.NET (Framework 3.5) `WhatsAppDocumentSender` desktop client.

Uses [`@whiskeysockets/baileys`](https://www.npmjs.com/package/@whiskeysockets/baileys) sixth-v6 WhatsApp Web implementation - no phone, SIM, or Chrome required to run. First-time linking is done once by scanning a QR code.

## Endpoints (mounted both at `/` and `/api/`)

| Method | Path | Body | Description |
| ------ | ---- | ---- | ----------- |
| GET | `/status` | - | `{ "connected": bool, "sending": bool, "qr": "data:image/png;base64,..." }` |
| POST | `/send` | multipart form: `document` (file), `numbers` (JSON array string, e.g. `["919876543210"]`), `message`, `delay` | Sends the document to each number. Returns `{ success, message, results: [{ number, status, error }] }` |
| POST | `/stop` | - | Stops an in-progress send job |
| GET | `/hello` | - | Health check |

## Run locally

```bash
npm install
npm start        # default http://0.0.0.0:8080
```

In the desktop app, set ApiUrl to `http://SERVER-IP:8080/api/` (or `http://localhost:8080/`).

## Environment variables

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `PORT` | `8080` | Listening port |
| `HOST` | `0.0.0.0` | Bind address |
| `SESSION_DIR` | `./session` | Folder that holds the WhatsApp login session. Keep it between restarts so the phone is not asked to re-link. |
| `FORCE_COUNTRY_CODE` | *(empty)* | e.g. `91`. Prepended to numbers shorter than 12 digits (so `9876543210` becomes `+91 9876543210`). |
| `STATE_TEST` | *(empty)* | `1` = dry-run mode: replies like a connected server but never contacts WhatsApp (used for endpoint testing only). |

## First run (linking the phone)

1. Start the server.
2. Open the desktop client and press **Connect** (or open `/status`).
3. The response contains a QR image - scan it from **WhatsApp > Settings > Linked devices > Link a device**.
4. Session is saved into `SESSION_DIR`; the next start reconnects without scanning again.

## Hosting on Hostinger

WhatsApp Web needs a long-running process, so shared "PHP" hosting cannot run this.

Preferred: a small **Hostinger VPS** (or Hostinger's **Node.js** hosting plan if your region offers it), with Node 18+.

```bash
# on the VPS (Ubuntu/Debian)
apt install nodejs npm   # or use nvm for Node 18/20/22
git clone <your-repo> whatsapp-server && cd whatsapp-server
npm install
PORT=3000 npm start &
```

Make it permanent with pm2:

```bash
npm install -g pm2
PORT=3000 pm2 start server.js --name whatsapp
pm2 save && pm2 startup
```

Then point **one subdomain** (e.g. `wa.yourdomain.com`) at the VPS IP in Hostinger DNS and, if you want HTTPS (recommended - the server exposes a QR plus its content), put nginx in front:

```nginx
server {
  listen 80;
  server_name wa.yourdomain.com;
  location / { proxy_pass http://127.0.0.1:3000; proxy_set_header Host $host; }
}
```

Get a free certificate with `certbot --nginx -d wa.yourdomain.com`.

Finally set the desktop app's ApiUrl to `https://wa.yourdomain.com/api/` and link the phone once (scan the QR from the desktop app).

## Notes

- Numbers should be in international format without `+` (e.g. `919876543210`). Server strips anything that is not a digit and only keeps numbers of 7+ digits.
- The `session/` folder is the login key: back it up, and never share it.
- If you are logged out ("logged out" appears in the logs), delete `session/` and restart to get a fresh QR.
- Real messages arrive from *your* WhatsApp account (the linked phone), subject to WhatsApp's normal anti-spam rules - keep message rates reasonable.