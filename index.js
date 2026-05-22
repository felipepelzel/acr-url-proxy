const express = require('express');
const cors = require('cors');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const fetch = require('node-fetch');
const FormData = require('form-data');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
app.use(cors());
app.use(express.json());
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => res.json({ status: 'ok', service: 'ACR URL Proxy v2 (yt-dlp)' }));

app.post('/analyze', async (req, res) => {
  const { url, acr_host, access_key, access_secret } = req.body;
  if (!url || !acr_host || !access_key || !access_secret) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acr-'));
  const outPath = path.join(tmpDir, 'audio.%(ext)s');

  try {
    console.log('Downloading:', url);

    // yt-dlp: descargar solo audio, máx 60s, mejor calidad de audio disponible
    await execFileAsync('yt-dlp', [
      '--no-playlist',
      '--extract-audio',
      '--audio-format', 'mp3',
      '--audio-quality', '5',
      '--postprocessor-args', '-t 60',
      '--output', outPath,
      '--no-warnings',
      '--quiet',
      url
    ], { timeout: 60000 });

    // Buscar el archivo descargado
    const files = fs.readdirSync(tmpDir);
    const audioFile = files.find(f => f.endsWith('.mp3') || f.endsWith('.m4a') || f.endsWith('.webm') || f.endsWith('.ogg'));
    if (!audioFile) throw new Error('No audio file downloaded');

    const audioPath = path.join(tmpDir, audioFile);
    let audioBuffer = fs.readFileSync(audioPath);

    console.log('Audio downloaded:', audioBuffer.length, 'bytes');

    // Limitar a 1MB para ACRCloud
    if (audioBuffer.length > 1048576) audioBuffer = audioBuffer.slice(0, 1048576);

    const result = await sendToACRCloud(audioBuffer, acr_host, access_key, access_secret);
    console.log('ACRCloud code:', result.status?.code);
    res.json(result);

  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    // Limpiar archivos temporales
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
    method: 'POST',
    body: form,
    headers: form.getHeaders(),
  });
  return response.json();
}

app.listen(PORT, () => console.log(`ACR URL Proxy v2 running on port ${PORT}`));
