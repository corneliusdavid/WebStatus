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

### 5. Keep Node.js running across reboots

The server must keep running after you close the terminal and survive reboots.
Otherwise, after a reboot nothing listens on port 3001 and IIS returns **502 Bad
Gateway** until you launch it by hand.

> **Note:** You cannot point `sc.exe create` / `New-Service` directly at `node.exe`.
> A plain Node process doesn't speak to the Service Control Manager, so SCM kills
> it at startup with *"the service did not respond in a timely fashion"* (error
> 1053). You need either a scheduled task or a service wrapper.

**Option A — Task Scheduler (recommended, fully native, nothing to download):**

Run on the server, substituting your Node path, app folder, and domain account:
```powershell
$node = (Get-Command node).Source          # e.g. C:\Program Files\nodejs\node.exe
$dir  = "C:\inetpub\webstatus"             # folder containing server.js

$action  = New-ScheduledTaskAction -Execute $node -Argument "server.js" -WorkingDirectory $dir
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `        # no 3-day default kill
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `  # relaunch if it crashes
  -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName "WebStatus" `
  -Action $action -Trigger $trigger -Settings $settings `
  -User "DOMAIN\ServiceAccount" -Password "TheAccountPassword" `
  -RunLevel Highest `
  -Description "WebStatus Node backend, proxied by IIS on :3001"
```
Start it now (without rebooting) and verify — stop any manual `node server.js`
first so port 3001 is free:
```powershell
Start-ScheduledTask -TaskName "WebStatus"
Get-ScheduledTaskInfo -TaskName "WebStatus"      # LastTaskResult should be 0
Invoke-WebRequest http://localhost:3001/ -UseBasicParsing | Select-Object StatusCode
```

**Option B — WinSW** (modern, maintained NSSM replacement; use if you want true
service semantics with instant crash-restart): a single MIT-licensed `.exe` plus a
small XML config — https://github.com/winsw/winsw

**Option C — PM2:**
```
npm install -g pm2
pm2 start server.js --name webstatus
pm2 save
pm2-startup install
```

> **Important:** Whichever you choose, it must run as a **domain account**, not
> Local System, so it has permission to query the RDP server over WinRM. The
> Task Scheduler `-User`/`-Password` pair above handles this (it runs whether
> logged on or not, with real network credentials).

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
