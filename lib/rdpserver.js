'use strict';
const { execFile } = require('child_process');

// The script runs on the remote server via WinRM (Invoke-Command).
// Requirements on the RDP server:
//   - WinRM enabled (run: winrm quickconfig)
//   - The account running this Node.js process must have permission to
//     execute Invoke-Command against the remote host (domain accounts work
//     automatically when both machines are on the same domain).
function getRdpMetrics(hostname) {
  return new Promise((resolve) => {
    const result = {
      hostname,
      state: 'pending',
      cpuPercent: null,
      totalMemoryMB: null,
      usedMemoryMB: null,
      activeSessions: null,
      disconnectedSessions: null,
      checkedAt: new Date().toISOString(),
      error: null,
    };

    const script = `
      try {
        $data = Invoke-Command -ComputerName '${hostname.replace(/'/g, "''")}' -ScriptBlock {
          $os  = Get-CimInstance Win32_OperatingSystem
          $cpu = [int]((Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average)
          $lines = & qwinsta 2>$null
          $active = ($lines | Select-String -Pattern 'Active').Count
          $disc   = ($lines | Select-String -Pattern 'rdp-tcp#' | Where-Object { $_ -notmatch 'Active' }).Count
          [PSCustomObject]@{
            CpuPercent           = $cpu
            TotalMemoryMB        = [int]($os.TotalVisibleMemorySize / 1024)
            FreeMemoryMB         = [int]($os.FreePhysicalMemory / 1024)
            ActiveSessions       = $active
            DisconnectedSessions = $disc
          }
        } -ErrorAction Stop
        $data | ConvertTo-Json -Compress
      } catch {
        [PSCustomObject]@{ Error = $_.Exception.Message } | ConvertTo-Json -Compress
      }
    `;

    // Use -EncodedCommand to avoid all quoting/escaping issues
    const encoded = Buffer.from(script, 'utf16le').toString('base64');

    execFile(
      'powershell.exe',
      ['-NonInteractive', '-NoProfile', '-EncodedCommand', encoded],
      { timeout: 20000 },
      (err, stdout) => {
        if (err && !stdout) {
          result.state = 'down';
          result.error = err.message;
          return resolve(result);
        }

        const raw = (stdout || '').trim();
        if (!raw) {
          result.state = 'down';
          result.error = 'No output from PowerShell';
          return resolve(result);
        }

        try {
          const data = JSON.parse(raw);
          if (data.Error) {
            result.state = 'down';
            result.error = data.Error;
          } else {
            result.state = 'up';
            result.cpuPercent = data.CpuPercent;
            result.totalMemoryMB = data.TotalMemoryMB;
            result.usedMemoryMB = data.TotalMemoryMB - data.FreeMemoryMB;
            result.activeSessions = data.ActiveSessions;
            result.disconnectedSessions = data.DisconnectedSessions;
          }
        } catch {
          result.state = 'down';
          result.error = `Could not parse response: ${raw.slice(0, 200)}`;
        }

        resolve(result);
      }
    );
  });
}

module.exports = { getRdpMetrics };
