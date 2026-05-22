const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const FormData = require('form-data');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

const app = express();
app.use(cors());
app.use(express.json());
const PORT = process.env.PORT || 3000;

// Instalar yt-dlp al arrancar si no existe
async function ensureYtDlp() {
  try {
    await execAsync('yt-dlp --version');
    console.log('yt-dlp already installed');
  } catch {
    console.log('Installing yt-dlp...');
    try {
      await execAsync('pip3 install yt-dlp');
      console.log('yt-dlp installed via pip3');
    } catch {
      try {
        await execAsync('pip install yt-dlp');
        console.log('yt-dlp installed via pip');
      } catch {
        // Descargar binario directamente
        console.log('Downloading yt-dlp binary...');
        await execAsync('curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && chmod a+rx /usr/local/bin/yt-dlp');
        console.log('yt-dlp binary installed');
      }
    }
  }
}

app.get('/', (req, res) => res.json({ status: 'ok', service: 'ACR URL Proxy v3' }));

app.get('/health', async (req, res) => {
  try {
    const { stdout } = await execAsync('yt-dlp --version');
    res.json({ status: 'ok', ytdlp: stdout.trim() });
  } catch(e) {
    res.json({ status: 'error', ytdlp: 'not found', error: e.message });
  }
});

app.post('/analyze', async (req, res) => {
  const { url, acr_host, access_key, access_secret } = req.body;
  if (!url || !acr_host || !access_key || !access_secret) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acr-'));
  const outTemplate = path.join(tmpDir, 'audio.%(ext)s');

  try {
    console.log('Downloading:', url);

    const cmd = `yt-dlp --no-playlist --extract-audio --audio-format mp3 --audio-quality 5 --output "${outTemplate}" --no-warnings --quiet "${url}"`;
    await execAsync(cmd, { timeout: 90000 });

    const files = fs.readdirSync(tmpDir);
    const audioFile = files.find(f => /\.(mp3|m4a|webm|ogg|opus)$/.test(f));
    if (!audioFile) throw new Error('No audio file downloaded');

    let audioBuffer = fs.readFileSync(path.join(tmpDir, audioFile));
    console.log('Audio:', audioBuffer.length, 'bytes');
    if (audioBuffer.length > 1048576) audioBuffer = audioBuffer.slice(0, 1048576);

    const result = await sendToACRCloud(audioBuffer, acr_host, access_key, access_secret);
    console.log('ACRCloud code:', result.status?.code);
    res.json(result);

  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

async function sendToACRCloud(audioBuffer, host, key, secret) {
  const timestamp = Math.floor(Date.now() / 1000);
  const sigStr = ['POST', '/v1/identify', key, 'audio', '1', timestamp].join('\n');
  const signature = crypto.createHmac('sha1', secret).update(sigStr).digest('base64');
  const form = new FormData();
  form.append('sample', audioBuffer, { filename: 'sample.mp3', contentType: 'audio/mpeg' });
  form.append('access_key', key);
  form.append('data_type', 'audio');
  form.append('signature_version', '1');
  form.append('signature', signature);
  form.append('sample_bytes', audioBuffer.length);
  form.append('timestamp', timestamp);
  const response = await fetch(`https://${host}/v1/identify`, {
    method: 'POST', body: form, headers: form.getHeaders(),
  });
  return response.json();
}

app.listen(PORT, async () => {
  console.log(`ACR URL Proxy v3 running on port ${PORT}`);
  await ensureYtDlp();
});
