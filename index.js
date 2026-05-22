const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const fetch = require('node-fetch');
const FormData = require('form-data');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
const PORT = process.env.PORT || 3000;

async function ensureTools() {
  try { await execAsync('yt-dlp --version'); } catch {
    try { await execAsync('pip3 install yt-dlp'); } catch {
      await execAsync('curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && chmod a+rx /usr/local/bin/yt-dlp');
    }
  }
  console.log('yt-dlp ready');
}

app.get('/', (req, res) => res.json({ status: 'ok', service: 'Influencer Platform Proxy v5' }));

app.get('/health', async (req, res) => {
  try {
    const { stdout } = await execAsync('yt-dlp --version');
    res.json({ status: 'ok', ytdlp: stdout.trim() });
  } catch(e) {
    res.json({ status: 'error', error: e.message });
  }
});

// ─── COPYRIGHT: analiza audio con ACRCloud ─────────────────
app.post('/analyze', async (req, res) => {
  let { url, acr_host, access_key, access_secret } = req.body;
  if (!url || !acr_host || !access_key || !access_secret)
    return res.status(400).json({ error: 'Missing fields' });

  if (url.includes('tiktok.com'))
    url = url.replace('http://tiktok.com', 'https://www.tiktok.com')
             .replace('https://tiktok.com', 'https://www.tiktok.com');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acr-'));
  const outTemplate = path.join(tmpDir, 'audio.%(ext)s');

  try {
    console.log('Copyright check:', url);
    const cmd = `yt-dlp --no-playlist --extract-audio --audio-format mp3 --audio-quality 5 --output "${outTemplate}" --no-warnings --quiet "${url}"`;

    try {
      await execAsync(cmd, { timeout: 90000 });
    } catch(dlErr) {
      console.log('Download failed:', dlErr.message.slice(0, 100));
      return res.json({ status: { code: 2000, msg: 'No verificable' }, metadata: {}, _download_error: true });
    }

    const files = fs.readdirSync(tmpDir);
    const audioFile = files.find(f => /\.(mp3|m4a|webm|ogg|opus)$/.test(f));
    if (!audioFile)
      return res.json({ status: { code: 2000, msg: 'No verificable' }, metadata: {}, _download_error: true });

    let audioBuffer = fs.readFileSync(path.join(tmpDir, audioFile));
    if (audioBuffer.length > 1048576) audioBuffer = audioBuffer.slice(0, 1048576);

    const result = await sendToACRCloud(audioBuffer, acr_host, access_key, access_secret);
    console.log('ACRCloud code:', result.status?.code);
    res.json(result);

  } catch(err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

// ─── SCORING: descarga video, extrae frames, analiza con Claude ─
app.post('/score', async (req, res) => {
  let { url, platform, creator, anthropic_key } = req.body;
  if (!url || !anthropic_key)
    return res.status(400).json({ error: 'Missing fields: url, anthropic_key' });

  if (!platform || platform === 'auto') {
    if (url.includes('tiktok.com')) platform = 'tiktok';
    else if (url.includes('instagram.com')) platform = 'instagram';
    else if (url.includes('youtube.com') || url.includes('youtu.be')) platform = 'youtube';
    else platform = 'tiktok';
  }

  if (url.includes('tiktok.com'))
    url = url.replace('http://tiktok.com', 'https://www.tiktok.com')
             .replace('https://tiktok.com', 'https://www.tiktok.com');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'score-'));
  const videoPath = path.join(tmpDir, 'video.%(ext)s');

  try {
    console.log('Scoring:', url, '| Platform:', platform);

    // 1. Descargar video (con audio, calidad baja para velocidad)
    const dlCmd = `yt-dlp --no-playlist --format "worst[ext=mp4]/worst" --output "${videoPath}" --no-warnings --quiet "${url}"`;
    try {
      await execAsync(dlCmd, { timeout: 120000 });
    } catch(dlErr) {
      return res.status(500).json({ error: 'No se pudo descargar el video: ' + dlErr.message.slice(0, 200) });
    }

    // Encontrar el video descargado
    const files = fs.readdirSync(tmpDir);
    const videoFile = files.find(f => /\.(mp4|webm|mkv|mov|m4v)$/.test(f));
    if (!videoFile)
      return res.status(500).json({ error: 'No se encontró el archivo de video descargado' });

    const fullVideoPath = path.join(tmpDir, videoFile);
    const videoStats = fs.statSync(fullVideoPath);
    console.log('Video downloaded:', videoStats.size, 'bytes');

    // 2. Extraer metadatos del video con yt-dlp
    let videoMeta = {};
    try {
      const metaCmd = `yt-dlp --dump-json --no-playlist --quiet "${url}"`;
      const { stdout } = await execAsync(metaCmd, { timeout: 30000 });
      videoMeta = JSON.parse(stdout.trim());
    } catch(e) {
      console.log('Meta extraction failed:', e.message.slice(0, 80));
    }

    // 3. Extraer frames clave con ffmpeg
    const framesDir = path.join(tmpDir, 'frames');
    fs.mkdirSync(framesDir);
    const frames = [];

    try {
      // Obtener duración
      const { stdout: durationOut } = await execAsync(
        `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${fullVideoPath}"`
      );
      const duration = parseFloat(durationOut.trim()) || 30;
      console.log('Duration:', duration, 's');

      // Extraer 4 frames: 0s, 25%, 50%, 75%
      const timestamps = [0.5, duration * 0.25, duration * 0.5, duration * 0.75].map(t => Math.min(t, duration - 0.1));
      for (let i = 0; i < timestamps.length; i++) {
        const framePath = path.join(framesDir, `frame_${i}.jpg`);
        try {
          await execAsync(`ffmpeg -ss ${timestamps[i].toFixed(2)} -i "${fullVideoPath}" -frames:v 1 -q:v 5 -vf scale=480:-1 "${framePath}" -y -loglevel quiet`);
          if (fs.existsSync(framePath)) {
            const frameData = fs.readFileSync(framePath);
            frames.push(frameData.toString('base64'));
          }
        } catch(e) { console.log('Frame', i, 'failed:', e.message.slice(0,50)); }
      }
    } catch(e) {
      console.log('ffprobe/ffmpeg failed:', e.message.slice(0, 80));
    }

    console.log('Frames extracted:', frames.length);

    // 4. Construir prompt para Claude con frames reales
    const BP = {
      tiktok: {
        name: 'TikTok',
        categories: [
          { id: 'hook', name: 'Hook 0–3s', weight: 25, desc: 'Los primeros 3 segundos evitan el scroll' },
          { id: 'authenticity', name: 'Autenticidad', weight: 20, desc: 'Estilo UGC, natural, no sobre-producido' },
          { id: 'format', name: 'Formato técnico', weight: 15, desc: 'Vertical 9:16, HD, zona segura UI' },
          { id: 'audio', name: 'Audio / Música', weight: 15, desc: 'Sonido trending o original, sincronía' },
          { id: 'retention', name: 'Retención', weight: 15, desc: '15–60s, loop natural, rewatch value' },
          { id: 'cta', name: 'CTA / Engagement', weight: 10, desc: 'Call to action claro, invita a interactuar' }
        ]
      },
      instagram: {
        name: 'Instagram Reels',
        categories: [
          { id: 'hook', name: 'Hook 0–3s', weight: 25, desc: 'Parar el scroll en los primeros 3 segundos' },
          { id: 'visual', name: 'Calidad visual', weight: 20, desc: 'Iluminación, estética, edición fluida, 9:16' },
          { id: 'captions', name: 'Subtítulos / Texto', weight: 15, desc: 'Subtítulos para mudo, texto overlay legible' },
          { id: 'audio', name: 'Audio trending', weight: 15, desc: 'Música trending, sin copyright, sincronía' },
          { id: 'cta', name: 'CTA / Caption', weight: 15, desc: 'CTA visible, caption con keywords, hashtags' },
          { id: 'completion', name: 'Completion rate', weight: 10, desc: 'Narrativa que lleva al final, loop natural' }
        ]
      },
      youtube: {
        name: 'YouTube Shorts',
        categories: [
          { id: 'hook', name: 'Hook 0–3s', weight: 25, desc: 'Curiosity gap, bold claim, valor inmediato' },
          { id: 'retention', name: 'Retención 90%+', weight: 25, desc: '25–35s óptimo, alto completion rate' },
          { id: 'value', name: 'Valor / Utilidad', weight: 20, desc: 'Tutorial, info útil, entretenimiento claro' },
          { id: 'format', name: 'Formato técnico', weight: 15, desc: 'Vertical, audio claro, funciona sin sonido' },
          { id: 'seo', name: 'SEO / Metadata', weight: 10, desc: 'Título keywords, descripción, hashtags' },
          { id: 'cta', name: 'CTA / Loop', weight: 5, desc: 'Final que invita, loop o cliffhanger' }
        ]
      }
    };

    const bp = BP[platform] || BP['tiktok'];
    const catList = bp.categories.map(c => `- ${c.id} (${c.name}, peso ${c.weight}%): ${c.desc}`).join('\n');

    const metaContext = videoMeta.title
      ? `Título del video: "${videoMeta.title}"\nDescripción: "${(videoMeta.description || '').slice(0, 300)}"\nDuración: ${Math.round(videoMeta.duration || 0)}s\nLikes: ${videoMeta.like_count || 'N/D'}\nViews: ${videoMeta.view_count || 'N/D'}`
      : '';

    const textContent = `Sos un experto en marketing digital y análisis de contenido para redes sociales. Analizá este video de ${bp.name} basándote en los frames reales del video que te adjunto.

URL: ${url}
${creator ? 'Creador: ' + creator : ''}
${metaContext}

Te adjunto ${frames.length} frames del video (inicio, 25%, 50%, 75% de la duración). Analizá el contenido REAL que ves en los frames para evaluar cada categoría con precisión.

Categorías a evaluar:
${catList}

Basándote en lo que ves REALMENTE en los frames, responde SOLO con este JSON (sin markdown):
{"overall_score":<0-100>,"overall_verdict":"<2-3 oraciones sobre calidad general basadas en el video real>","categories":{${bp.categories.map(c => `"${c.id}":{"score":<0-100>,"detail":"<observación específica de lo visto en los frames>"}`).join(',')}},"recommendations":[{"priority":"high","text":"<recomendación concreta>"},{"priority":"high","text":"<recomendación concreta>"},{"priority":"med","text":"<recomendación>"},{"priority":"low","text":"<recomendación>"}],"checklist":[{"ok":true,"item":"<práctica cumplida visible en el video>"},{"ok":false,"item":"<práctica no cumplida>"},{"ok":true,"item":"<práctica cumplida>"},{"ok":false,"item":"<práctica no cumplida>"},{"ok":true,"item":"<práctica cumplida>"}]}`;

    // 5. Construir mensaje para Claude con imágenes
    const messageContent = [];

    // Agregar frames como imágenes
    if (frames.length > 0) {
      frames.forEach((frameB64, i) => {
        messageContent.push({
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: frameB64 }
        });
        messageContent.push({
          type: 'text',
          text: `Frame ${i + 1} de ${frames.length} (${['inicio', '25%', '50%', '75%'][i]})`
        });
      });
    }

    messageContent.push({ type: 'text', text: textContent });

    // 6. Llamar a Claude API
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropic_key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1500,
        messages: [{ role: 'user', content: messageContent }]
      })
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      throw new Error('Claude API ' + claudeRes.status + ': ' + errText.slice(0, 200));
    }

    const claudeData = await claudeRes.json();
    const rawText = claudeData.content?.[0]?.text || '';
    const jsonText = rawText.replace(/```json|```/g, '').trim();
    const result = JSON.parse(jsonText);

    console.log('Scoring complete. Score:', result.overall_score);
    res.json({ ...result, _frames_used: frames.length, _meta: { title: videoMeta.title, duration: videoMeta.duration } });

  } catch(err) {
    console.error('Score error:', err.message);
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
  console.log(`Influencer Platform Proxy v5 on port ${PORT}`);
  await ensureTools();
});
