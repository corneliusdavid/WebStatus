# WebStatus

A lightweight web-based monitoring dashboard for tracking website availability and Windows RDP server health. Built with Node.js and Express, hosted behind IIS.

**What it monitors:**
- Any number of websites — HTTP status code, response time, and up/down state
- A Windows RDP server — CPU usage, RAM usage, and active/disconnected remote desktop session counts

The dashboard auto-refreshes every 15 seconds without a full page reload. All checks run on the server every 60 seconds (configurable). Access is protected by a username and bcrypt-hashed password.

---

## Prerequisites

**On your development machine:**
- Node.js 18+

**On the Windows Server hosting the dashboard:**
- Node.js 18+
- IIS with the [URL Rewrite](https://www.iis.net/downloads/microsoft/url-rewrite) and [Application Request Routing (ARR)](https://www.iis.net/downloads/microsoft/application-request-routing) modules installed
- WinRM enabled and reachable on the RDP server (see [RDP Server Requirements](#rdp-server-requirements))

---

## Local Testing

Use this to verify site checks work and the UI looks right before deploying. RDP metrics will show as "down" locally — they only work when running on a Windows machine with domain access to the RDP server.

1. Install dependencies:
   ```
   npm install
   ```

2. Edit `config.json` — add your real site URLs and set a `sessionSecret`:
   ```json
   {
     "sessionSecret": "some-long-random-string",
     "sites": [
       { "name": "My Site", "url": "https://mysite.com", "expectedStatus": 200 }
     ]
   }
   ```

3. Set your login password:
   ```
   node set-password.js
   ```

4. Start the server:
   ```
   node server.js
   ```

5. Open `http://localhost:3001` and log in.

---

## Server Deployment

### 1. Copy files to the server

Copy the following to a folder on the server (e.g. `C:\inetpub\webstatus`). **Do not copy `node_modules/`.**

```
server.js
set-password.js
config.json
package.json
lib\
public\
web.config
```

### 2. Install dependencies on the server

Open a command prompt in the project folder and run:
```
npm install
```

### 3. Configure config.json

Edit `config.json` on the server with your real values:

| Field | Description |
|---|---|
| `port` | Port Node.js listens on (default: `3001`) |
| `checkIntervalSeconds` | How often sites and the RDP server are checked (default: `60`) |
| `slowResponseThresholdMs` | Response time above this is flagged as "Slow" (default: `3000`) |
| `auth.username` | Login username |
| `auth.passwordHash` | Set by running `node set-password.js` — do not edit manually |
| `sessionSecret` | A long random string used to sign session cookies — **change this** |
| `rdpServer.enabled` | Set to `false` to hide the server panel entirely |
| `rdpServer.hostname` | NetBIOS name or FQDN of the RDP server (e.g. `MYSERVER` or `myserver.domain.local`) |
| `rdpServer.displayName` | Friendly name shown in the dashboard |
| `sites[].name` | Display name for the site |
| `sites[].url` | Full URL to check (include `https://`) |
| `sites[].expectedStatus` | Expected HTTP status code — anything else is flagged as a warning |

### 4. Set the login password

```
node set-password.js
```

This hashes the password with bcrypt and saves it to `config.json`. Re-run any time you want to change the password; restart the server after.

### 5. Run Node.js as a Windows Service

The server must keep running after you close the terminal and survive reboots. Two options:

**Option A — PM2 (recommended):**
```
npm install -g pm2
pm2 start server.js --name webstatus
pm2 save
pm2-startup install
```

**Option B — NSSM (Non-Sucking Service Manager):**
```
nssm install WebStatus "C:\Program Files\nodejs\node.exe" "C:\inetpub\webstatus\server.js"
nssm set WebStatus AppDirectory "C:\inetpub\webstatus"
nssm start WebStatus
```

> **Important:** The service must run as a **domain account**, not Local System, so it has permission to query the RDP server over WinRM. Set this in Services → WebStatus → Properties → Log On, or via `nssm set WebStatus ObjectName DOMAIN\ServiceAccount`.

### 6. Configure IIS

1. Install the **URL Rewrite** and **ARR** modules if not already present (links in [Prerequisites](#prerequisites)).
2. In IIS Manager, click the server node → **Application Request Routing Cache** → **Server Proxy Settings** → check **Enable proxy** → Apply.
3. Create or open the IIS site that will host the dashboard.
4. Copy `web.config` to that site's root folder (it's already included in the file list above).
5. Make sure the IIS site's physical path points to the project folder, or that `web.config` is in the site root.

The `web.config` rewrites all requests to `http://localhost:3001`, where Node.js is listening.

---

## RDP Server Requirements

The dashboard queries the RDP server using PowerShell remoting (`Invoke-Command` over WinRM). On the **RDP server**:

1. Enable WinRM:
   ```powershell
   winrm quickconfig
   ```
2. Ensure Windows Firewall allows WinRM (port 5985) from the dashboard server.
3. The domain account running the Node.js service must have permission to run remote PowerShell commands on the RDP server. Members of the **Remote Management Users** local group on the RDP server have this permission:
   ```powershell
   Add-LocalGroupMember -Group "Remote Management Users" -Member "DOMAIN\ServiceAccount"
   ```

---

## Project Structure

```
WebStatus/
├── server.js           # Express server, auth, API, background check loop
├── set-password.js     # One-time utility to hash and save the login password
├── config.json         # All configuration — sites, RDP server, credentials
├── package.json
├── web.config          # IIS ARR reverse proxy rules
├── lib/
│   ├── checker.js      # HTTP site health checking (status code, response time)
│   └── rdpserver.js    # PowerShell remoting — CPU, RAM, RDP session counts
└── public/
    ├── login.html
    ├── dashboard.html  # Auto-polling dashboard UI
    └── style.css
```

---

## Adding or Removing Sites

Edit the `sites` array in `config.json` and restart the Node.js service. No redeployment needed.

```json
"sites": [
  { "name": "Corporate Site",  "url": "https://corp.example.com",  "expectedStatus": 200 },
  { "name": "Customer Portal", "url": "https://portal.example.com", "expectedStatus": 200 },
  { "name": "Admin Panel",     "url": "https://admin.example.com",  "expectedStatus": 302 }
]
```

Note the third entry: if the admin panel redirects to a login page, set `expectedStatus` to `302` so the check doesn't flag it as a warning.
