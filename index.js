const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Serve index.html cùng cấp
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const vpsLinks = [];

async function gh(url, token, method = 'GET', body = null) {
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'VPS-Manager/2.0'
    }
  };
  if (body) opts.body = JSON.stringify(body);
  return fetch(url, opts);
}

async function upsertFile(owner, repo, token, filePath, content, msg) {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`;
  const getRes = await gh(url, token);
  let sha;
  if (getRes.status === 200) { const d = await getRes.json(); sha = d.sha; }
  const payload = { message: msg, content: Buffer.from(content).toString('base64') };
  if (sha) payload.sha = sha;
  return gh(url, token, 'PUT', payload);
}

function makeWorkflow(osType, vncPassword) {
  if (osType === 'windows') {
    return `name: VPS Windows
on:
  workflow_dispatch:
jobs:
  vps:
    runs-on: windows-latest
    timeout-minutes: 330
    steps:
      - name: Setup RDP
        shell: powershell
        run: |
          Set-ItemProperty -Path 'HKLM:\\System\\CurrentControlSet\\Control\\Terminal Server' -name "fDenyTSConnections" -Value 0
          Enable-NetFirewallRule -DisplayGroup "Remote Desktop"
          net user runneradmin "${vncPassword}" /add
          net localgroup administrators runneradmin /add
          net user runner "${vncPassword}"

      - name: Install noVNC
        shell: powershell
        run: |
          pip install websockify
          Invoke-WebRequest -Uri "https://github.com/novnc/noVNC/archive/refs/heads/master.zip" -OutFile novnc.zip
          Expand-Archive novnc.zip -DestinationPath C:\\noVNC
          Rename-Item C:\\noVNC\\noVNC-master C:\\noVNC\\novnc

      - name: Tunnel + Keep Alive
        shell: powershell
        run: |
          Invoke-WebRequest -Uri "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" -OutFile cloudflared.exe
          Start-Process python -ArgumentList "-m websockify --web=C:\\noVNC\\novnc 6080 localhost:3389" -NoNewWindow
          Start-Sleep 3
          Start-Process .\\cloudflared.exe -ArgumentList "tunnel --url http://localhost:6080 --no-autoupdate" -NoNewWindow -RedirectStandardOutput C:\\cf.log -RedirectStandardError C:\\cf.log
          Start-Sleep 15
          $url = (Get-Content C:\\cf.log | Select-String "trycloudflare.com").Matches[0].Value
          Write-Host "VPS_URL: $url/vnc.html"
          Write-Host "PASS: ${vncPassword}"
          Start-Sleep 19500

      - name: Auto Restart
        if: always()
        shell: powershell
        run: |
          curl -X POST -H "Authorization: Bearer $env:GITHUB_TOKEN" -H "Accept: application/vnd.github+json" "https://api.github.com/repos/$env:GITHUB_REPOSITORY/actions/workflows/vps-windows.yml/dispatches" -d '{"ref":"main"}'
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
`;
  }

  const isMC = osType === 'minecraft';
  return `name: VPS ${isMC ? 'Minecraft' : 'Ubuntu'}
on:
  workflow_dispatch:
jobs:
  vps:
    runs-on: ubuntu-latest
    timeout-minutes: 330
    steps:
      - uses: actions/checkout@v4

      - name: Install Desktop
        run: |
          sudo apt-get update -qq
          sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \\
            xfce4 xfce4-goodies xterm \\
            tigervnc-standalone-server tigervnc-common \\
            novnc websockify openjdk-21-jdk \\
            wget curl dbus-x11 --no-install-recommends -qq
${isMC ? `
      - name: Download TLauncher
        run: |
          mkdir -p ~/Desktop
          wget -q "https://tlauncher.org/jar" -O ~/Desktop/TLauncher.jar
          echo "TLauncher ready"
` : ''}
      - name: Start VNC + noVNC
        run: |
          mkdir -p ~/.vnc
          echo "${vncPassword}" | vncpasswd -f > ~/.vnc/passwd
          chmod 600 ~/.vnc/passwd
          printf '#!/bin/bash\\nexport DISPLAY=:1\\ndbus-launch --exit-with-session xfce4-session &\\n' > ~/.vnc/xstartup
          chmod +x ~/.vnc/xstartup
          vncserver :1 -geometry 1280x720 -depth 24 -localhost no
          websockify --web=/usr/share/novnc/ 6080 localhost:5901 &
          sleep 2

      - name: Cloudflare Tunnel
        run: |
          curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared
          chmod +x /usr/local/bin/cloudflared
          cloudflared tunnel --url http://localhost:6080 --no-autoupdate 2>&1 | tee /tmp/cf.log &
          for i in \$(seq 1 40); do
            URL=\$(grep -o 'https://[a-zA-Z0-9-]*.trycloudflare.com' /tmp/cf.log | head -1)
            if [ -n "\$URL" ]; then
              echo "VPS_URL: \$URL/vnc.html"
              echo "PASS: ${vncPassword}"
              break
            fi
            sleep 3
          done
          ${isMC ? 'DISPLAY=:1 java -Xmx4G -jar ~/Desktop/TLauncher.jar &' : ''}
          sleep 19500

      - name: Auto Restart
        if: always()
        run: |
          curl -s -X POST \\
            -H "Authorization: Bearer \${{ secrets.GITHUB_TOKEN }}" \\
            -H "Accept: application/vnd.github+json" \\
            "https://api.github.com/repos/\${{ github.repository }}/actions/workflows/vps-${isMC ? 'minecraft' : 'ubuntu'}.yml/dispatches" \\
            -d '{"ref":"main"}'
`;
}

app.post('/api/create', async (req, res) => {
  const { token, owner, repo, os_type = 'ubuntu', vnc_password = 'thinhvn' } = req.body;
  if (!token || !owner || !repo) return res.status(400).json({ error: 'Thiếu token/owner/repo' });

  const wfName = `vps-${os_type}.yml`;
  const workflow = makeWorkflow(os_type, vnc_password);

  try {
    const up = await upsertFile(owner, repo, token, `.github/workflows/${wfName}`, workflow, `Add ${os_type} VPS workflow`);
    if (![200, 201].includes(up.status)) {
      const e = await up.text();
      return res.status(400).json({ error: `Upload thất bại: ${e}` });
    }

    let dispatched = false;
    for (const ref of ['main', 'master']) {
      const d = await gh(
        `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${wfName}/dispatches`,
        token, 'POST', { ref }
      );
      if (d.status === 204) { dispatched = true; break; }
    }
    if (!dispatched) return res.status(400).json({ error: 'Dispatch thất bại. Repo cần branch main/master.' });

    const actionsUrl = `https://github.com/${owner}/${repo}/actions`;
    vpsLinks.push({ owner, repo, os: os_type, actionsUrl, vnc_password, created: Date.now() });

    return res.json({ success: true, actionsUrl, os: os_type, vnc_password });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.get('/api/list', (req, res) => {
  const fresh = vpsLinks.filter(v => Date.now() - v.created < 6 * 3600 * 1000);
  res.json({ list: fresh });
});

app.listen(PORT, () => console.log(`VPS Manager running on port ${PORT}`));
