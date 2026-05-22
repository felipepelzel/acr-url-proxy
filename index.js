const express = require('express');
const cors = require('cors');
const ytdl = require('ytdl-core');
const fetch = require('node-fetch');
const FormData = require('form-data');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Health check
app.get('/', (req, res) => res.json({ status: 'ok', service: 'ACR URL Proxy' }));

app.post('/analyze', async (req, res) => {
  const { url, acr_host, access_key, access_secret } = req.body;

  if (!url || !acr_host || !access_key || !access_secret) {
    return res.status(400).json({ error: 'Missing fields: url, acr_host, access_key, access_secret' });
  }

  try {
    console.log('Downloading audio from:', url);

    // Detectar plataforma
    const platform = detectPlatform(url);
    console.log('Platform:', platform);

    // Descargar audio (solo audio, máx 30s)
    let audioBuffer;

    if (platform === 'youtube' || platform === 'tiktok') {
      audioBuffer = await downloadWithYtdl(url);
    } else {
      return res.status(400).json({ error: 'Platform not supported: ' + platform });
    }

    console.log('Audio downloaded:', audioBuffer.length, 'bytes');

    // Limitar a 1MB para ACRCloud
    const sample = audioBuffer.length > 1048576
      ? audioBuffer.slice(0, 1048576)
      : audioBuffer;

    // Firmar y enviar a ACRCloud
    const result = await sendToACRCloud(sample, acr_host, access_key, access_secret);
    console.log('ACRCloud response code:', result.status?.code);

    res.json(result);

  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

function detectPlatform(url) {
  if (url.includes('tiktok.com')) return 'tiktok';
  if (url.includes('youtube.com') || url.includes('youtu.be')) return 'youtube';
  if (url.includes('instagram.com')) return 'instagram';
  return 'unknown';
}

async function downloadWithYtdl(url) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const stream = ytdl(url, {
      quality: 'lowestaudio',
      filter: 'audioonly',
    });
    stream.on('data', chunk => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

async function sendToACRCloud(audioBuffer, host, key, secret) {
  const timestamp = Math.floor(Date.now() / 1000);
  const method = 'POST';
  const uri = '/v1/identify';
  const dataType = 'audio';
  const sigVersion = '1';

  const sigStr = [method, uri, key, dataType, sigVersion, timestamp].join('\n');
  const signature = crypto.createHmac('sha1', secret).update(sigStr).digest('base64');

  const form = new FormData();
  form.append('sample', audioBuffer, { filename: 'sample.mp3', contentType: 'audio/mpeg' });
  form.append('access_key', key);
  form.append('data_type', dataType);
  form.append('signature_version', sigVersion);
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

app.listen(PORT, () => console.log(`ACR URL Proxy running on port ${PORT}`));
