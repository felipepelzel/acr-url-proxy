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

app.get('/', (req, res) => res.json({ status: 'ok', service: 'Influencer Platform Proxy v7 — Creativity Stack' }));
app.get('/health', async (req, res) => {
  try { const { stdout } = await execAsync('yt-dlp --version'); res.json({ status: 'ok', ytdlp: stdout.trim() }); }
  catch(e) { res.json({ status: 'error', error: e.message }); }
});

// ─── COPYRIGHT ─────────────────────────────────────────────
app.post('/analyze', async (req, res) => {
  let { url, acr_host, access_key, access_secret } = req.body;
  if (!url || !acr_host || !access_key || !access_secret) return res.status(400).json({ error: 'Missing fields' });
  if (url.includes('tiktok.com')) url = url.replace('http://tiktok.com','https://www.tiktok.com').replace('https://tiktok.com','https://www.tiktok.com');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acr-'));
  try {
    const cmd = `yt-dlp --no-playlist --extract-audio --audio-format mp3 --audio-quality 5 --output "${path.join(tmpDir,'audio.%(ext)s')}" --no-warnings --quiet "${url}"`;
    try { await execAsync(cmd, { timeout: 90000 }); } catch { return res.json({ status: { code: 2000, msg: 'No verificable' }, metadata: {}, _download_error: true }); }
    const files = fs.readdirSync(tmpDir);
    const audioFile = files.find(f => /\.(mp3|m4a|webm|ogg|opus)$/.test(f));
    if (!audioFile) return res.json({ status: { code: 2000, msg: 'No verificable' }, metadata: {}, _download_error: true });
    let audioBuffer = fs.readFileSync(path.join(tmpDir, audioFile));
    if (audioBuffer.length > 1048576) audioBuffer = audioBuffer.slice(0, 1048576);
    res.json(await sendToACRCloud(audioBuffer, acr_host, access_key, access_secret));
  } catch(err) { res.status(500).json({ error: err.message }); }
  finally { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} }
});

// ─── SCORING — CREATIVITY STACK ────────────────────────────
app.post('/score', async (req, res) => {
  let { url, platform, creator, anthropic_key } = req.body;
  if (!url || !anthropic_key) return res.status(400).json({ error: 'Missing fields: url, anthropic_key' });
  if (!platform || platform === 'auto') {
    if (url.includes('tiktok.com')) platform = 'tiktok';
    else if (url.includes('instagram.com')) platform = 'instagram';
    else if (url.includes('youtube.com') || url.includes('youtu.be')) platform = 'youtube';
    else platform = 'tiktok';
  }
  if (url.includes('tiktok.com')) url = url.replace('http://tiktok.com','https://www.tiktok.com').replace('https://tiktok.com','https://www.tiktok.com');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'score-'));
  try {
    console.log('Scoring:', url, '| Platform:', platform);

    // 1. Descargar video
    const dlCmd = `yt-dlp --no-playlist --format "worst[ext=mp4]/worst" --output "${path.join(tmpDir,'video.%(ext)s')}" --no-warnings --quiet "${url}"`;
    try { await execAsync(dlCmd, { timeout: 120000 }); }
    catch(dlErr) { return res.status(500).json({ error: 'No se pudo descargar el video: ' + dlErr.message.slice(0,200) }); }

    const files = fs.readdirSync(tmpDir);
    const videoFile = files.find(f => /\.(mp4|webm|mkv|mov|m4v)$/.test(f));
    if (!videoFile) return res.status(500).json({ error: 'No se encontró el archivo de video' });
    const fullVideoPath = path.join(tmpDir, videoFile);
    console.log('Video downloaded:', fs.statSync(fullVideoPath).size, 'bytes');

    // 2. Metadatos reales del video
    let videoMeta = {};
    try {
      const { stdout } = await execAsync(`yt-dlp --dump-json --no-playlist --quiet "${url}"`, { timeout: 30000 });
      videoMeta = JSON.parse(stdout.trim());
    } catch(e) { console.log('Meta failed:', e.message.slice(0,60)); }

    // 3. Duración real
    let duration = 30;
    try {
      const { stdout } = await execAsync(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${fullVideoPath}"`);
      duration = parseFloat(stdout.trim()) || 30;
    } catch(e) {}

    // 4. Extraer 5 frames estratégicos
    const framesDir = path.join(tmpDir, 'frames');
    fs.mkdirSync(framesDir);
    const frames = [];
    const frameConfig = [
      { t: 0.5, label: 'FRAME 1 — HOOK (primer segundo)' },
      { t: duration * 0.20, label: 'FRAME 2 — 20% (desarrollo inicial)' },
      { t: duration * 0.45, label: 'FRAME 3 — 45% (nudo/clímax)' },
      { t: duration * 0.70, label: 'FRAME 4 — 70% (resolución/producto)' },
      { t: duration * 0.90, label: 'FRAME 5 — 90% (cierre/CTA)' }
    ];
    for (let i = 0; i < frameConfig.length; i++) {
      const ts = Math.max(0.1, Math.min(frameConfig[i].t, duration - 0.1));
      const framePath = path.join(framesDir, `frame_${i}.jpg`);
      try {
        await execAsync(`ffmpeg -ss ${ts.toFixed(2)} -i "${fullVideoPath}" -frames:v 1 -q:v 2 -vf scale=600:-1 "${framePath}" -y -loglevel quiet`);
        if (fs.existsSync(framePath)) {
          const frameData = fs.readFileSync(framePath);
          frames.push({ b64: frameData.toString('base64'), label: frameConfig[i].label });
        }
      } catch(e) { console.log('Frame', i, 'failed'); }
    }
    console.log('Frames:', frames.length, '| Duration:', duration.toFixed(1), 's');

    // 5. Prompt basado en Creativity Stack (System1/Effie) + TikTok Playbook + Effectiveness Code
    const platformNames = { tiktok: 'TikTok', instagram: 'Instagram Reels', youtube: 'YouTube Shorts' };
    const platformName = platformNames[platform] || 'TikTok';
    const metaContext = videoMeta.title
      ? `Título: "${videoMeta.title}" | Duración: ${Math.round(duration)}s | Likes: ${videoMeta.like_count||'N/D'} | Views: ${videoMeta.view_count||'N/D'} | Descripción: "${(videoMeta.description||'').slice(0,200)}"`
      : `Duración: ${Math.round(duration)}s`;

    const prompt = `Sos un experto en creative effectiveness para L'Oréal Group con experiencia en evaluación de contenido de influencers. Tu framework de evaluación combina:
- The Creative Dividend (System1 + Effie): Creativity Stack — Emotion, Distinctiveness, Showmanship, Consistency
- The Effectiveness Code (Cannes Lions + WARC): storytelling emocional, participación, narrativa
- TikTok Playbook: entretener para ganar (Awe, Surprise, Humor), contenido nativo, slice of life
- Orlando Wood (Lemon/Look Out): features de showmanship ("right brain") vs. salesmanship ("left brain")

VIDEO A EVALUAR:
Plataforma: ${platformName}
${creator ? 'Creator: ' + creator : ''}
${metaContext}

Se adjuntan ${frames.length} frames del video real. Analizá cada frame con rigor y honestidad.

═══════════════════════════════════════════════
FRAMEWORK DE SCORING — CREATIVITY STACK
═══════════════════════════════════════════════

**1. EMOTION / RESPUESTA EMOCIONAL** (peso 25%)
Basado en System1 Star Rating y el principio "The More We Feel, The More We Buy":
- ¿El video genera una respuesta emocional clara (humor, sorpresa, awe, ternura, orgullo, inspiración)?
- ¿Evita la "neutralidad" (el mayor enemigo de la efectividad según System1)?
- ¿El arco emocional es dinámico (tensión → resolución) o plano?
- ¿La emoción es genuina o forzada/performativa?
- Señales positivas: humor real, sorpresa visual, momentos íntimos, awe, transformación visible
- Señales negativas: "empty smile", emoción actuada, tono corporativo frío, ausencia de sentimiento

**2. DISTINCTIVENESS / RECONOCIMIENTO DE MARCA** (peso 20%)
Basado en System1 Fluency Rating y el principio de Distinctive Brand Assets (DBAs):
- ¿La marca/producto aparece de forma que crea reconocimiento rápido sin interrumpir?
- ¿Se usan assets de marca coherentes (colores, tipografía, producto, personaje recurrente)?
- ¿El producto aparece en contexto dentro de la narrativa (ideal) o pegado de forma obvia (mal)?
- En short-form: ¿el logo/marca aparece en los primeros 2s? (aumenta skip rate si es forzado; funciona si está integrado naturalmente en la idea)
- ¿Hay un "Fluent Device" (personaje recurrente, escenario repetible, jingle)?
- ¿Se puede identificar la marca antes de que termine el video?

**3. SHOWMANSHIP / CRAFT CREATIVO** (peso 25%)
Basado en Orlando Wood's Right-Brain Creative Features (showmanship > salesmanship):
SE�ALES DE SHOWMANSHIP (positivas):
✓ Sentido de lugar claro y establece contexto visual
✓ Una escena que se desarrolla con progresión (no cortes abruptos sin sentido)
✓ Personajes con agencia (voz, movimiento, expresión genuina)
✓ Comunicación implícita, no verbal (miradas, gestos naturales)
✓ Diálogo real (no monólogo corporativo ni testimonial forzado)
✓ Música con melodía recognoscible
✓ Algo fuera de lo ordinario (sorpresa visual, juego con la forma)
✓ Expresión facial espontánea (no la "empty smile" de catálogo)
✓ Referencia cultural o juego de palabras/subversión del lenguaje

SE�ALES DE SALESMANSHIP (negativas):
✗ Producto abstracto / feature shot sin contexto humano
✗ Voiceover genérico leyendo atributos
✗ Monólogo testimonial corporativo
✗ Freeze-frame de producto
✗ Split-screen efecto (abstracción visual)
✗ Product-centricity extrema (las cosas son el personaje)
✗ "Self-consciousness" (creator mirando a cámara explicando el producto de forma obvia)
✗ Efectos visuales random sin propósito narrativo

**4. HOOK & NARRATIVE ARC** (peso 20%)
Basado en TikTok Playbook (entretener: Awe, Surprise, Humor) + Effectiveness Code:
- ¿Los primeros 2-3s paran el scroll? ¿Hay una pregunta, tensión, o promesa visual inmediata?
- ¿Hay una narrativa de 3 actos: situación inicial → tensión/conflicto → resolución/transformación?
- ¿El producto/marca aparece como RESOLUCIÓN (ideal, en el 55-70% del video) o como INTRODUCCIÓN forzada?
- ¿El video entretiene PRIMERO y vende DESPUÉS? (el principio core del TikTok Playbook)
- ¿Hay "slice of life" genuino o es claramente un ad?

**5. AUTHENTICITY & PLATFORM NATIVE** (peso 10%)
- ¿El contenido se siente nativo de la plataforma o es un TV ad repurposeado?
- ¿El creator habla en su voz o recita un brief?
- ¿Formato vertical 9:16, zonas seguras respetadas, ritmo editorial apropiado?
- ¿Hay elementos nativos de la plataforma (sounds, stitch, duet, trending format)?

═══════════════════════════════════════════════
INSTRUCCIÓN CRÍTICA: Sé brutalmente honesto.
- Un video donde el producto "aparece flotando" sin relación con la narrativa → brand_integration bajo
- Un video con "empty smile" y product shot freeze-frame → showmanship bajo  
- Un video donde no se siente nada → emotion bajo (neutrality = dullness = costo)
- Un video donde el creator claramente lee un guión → authenticity bajo
NO inflés los scores. El promedio real de los mejores ads de consumo es 65-75/100.
Un score de 90+ debería ser excepcional (nivel Cannes Lions).
═══════════════════════════════════════════════

Respondé EXCLUSIVAMENTE con este JSON (sin markdown, sin texto adicional):
{
  "overall_score": <0-100>,
  "overall_grade": "<A+|A|B+|B|C+|C|D>",
  "star_rating": <1-5>,
  "overall_verdict": "<3-4 oraciones honestas sobre la calidad creativa real observada en los frames>",
  "creativity_stack": {
    "emotion": {
      "score": <0-100>,
      "emotion_type": "<humor|sorpresa|awe|ternura|orgullo|inspiración|neutro|múltiple>",
      "detail": "<qué emoción se observa en los frames y qué tan genuina es>"
    },
    "distinctiveness": {
      "score": <0-100>,
      "brand_fluency_timing": "<primeros 2s|primer tercio|mitad|final|no identificable>",
      "detail": "<cómo aparece la marca/producto y si crea reconocimiento rápido>"
    },
    "showmanship": {
      "score": <0-100>,
      "dominant_style": "<showmanship|salesmanship|mixto>",
      "right_brain_features": ["<feature observada>", "<feature>"],
      "left_brain_features": ["<feature problemática>", "<feature>"],
      "detail": "<análisis del craft visual y narrativo basado en los frames>"
    },
    "hook_narrative": {
      "score": <0-100>,
      "narrative_arc": "<tensión-resolución|slice of life|demo producto|testimonial|trend|sin arco>",
      "product_timing": "<resolución (ideal)|introducción forzada|integrado naturalmente|no visible>",
      "detail": "<cómo arranca el video y si tiene arco narrativo>"
    },
    "authenticity": {
      "score": <0-100>,
      "platform_native": <true|false>,
      "detail": "<qué tan genuino es el creator y el formato>"
    }
  },
  "strengths": ["<fortaleza concreta y específica observable>", "<fortaleza>"],
  "weaknesses": ["<debilidad concreta y específica>", "<debilidad>"],
  "recommendations": [
    {"priority": "high", "dimension": "emotion|distinctiveness|showmanship|hook_narrative|authenticity", "text": "<recomendación concreta y accionable para el próximo brief>"},
    {"priority": "high", "dimension": "<dimensión>", "text": "<recomendación>"},
    {"priority": "med", "dimension": "<dimensión>", "text": "<recomendación>"},
    {"priority": "low", "dimension": "<dimensión>", "text": "<recomendación>"}
  ],
  "creative_archetype": "<Slice of Life|Demo aspiracional|Storytelling emocional|Humor/entretenimiento|Tutorial|Testimonial|Trend/format nativo|UGC auténtico|Ad disfrazado>",
  "dullness_risk": "<bajo|medio|alto>",
  "brand_integration_quality": "<resolución narrativa|integración natural|placement forzado|interrupción>"
}`;

    // 6. Construir mensaje con frames reales
    const messageContent = [];
    for (const frame of frames) {
      messageContent.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: frame.b64 } });
      messageContent.push({ type: 'text', text: frame.label });
    }
    messageContent.push({ type: 'text', text: prompt });

    // 7. Claude Vision
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': anthropic_key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 2000, messages: [{ role: 'user', content: messageContent }] })
    });
    if (!claudeRes.ok) { const e = await claudeRes.text(); throw new Error('Claude API ' + claudeRes.status + ': ' + e.slice(0,200)); }
    const claudeData = await claudeRes.json();
    const rawText = claudeData.content?.[0]?.text || '';
    const result = JSON.parse(rawText.replace(/```json|```/g,'').trim());
    console.log('Score:', result.overall_score, '| Grade:', result.overall_grade, '| Stars:', result.star_rating);
    res.json({ ...result, _frames_used: frames.length, _duration: Math.round(duration), _meta: { title: videoMeta.title, views: videoMeta.view_count, likes: videoMeta.like_count } });

  } catch(err) {
    console.error('Score error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

async function sendToACRCloud(audioBuffer, host, key, secret) {
  const timestamp = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha1', secret).update(['POST','/v1/identify',key,'audio','1',timestamp].join('\n')).digest('base64');
  const form = new FormData();
  form.append('sample', audioBuffer, { filename: 'sample.mp3', contentType: 'audio/mpeg' });
  form.append('access_key', key); form.append('data_type', 'audio');
  form.append('signature_version', '1'); form.append('signature', sig);
  form.append('sample_bytes', audioBuffer.length); form.append('timestamp', timestamp);
  const response = await fetch(`https://${host}/v1/identify`, { method: 'POST', body: form, headers: form.getHeaders() });
  return response.json();
}

app.listen(PORT, async () => { console.log(`Proxy v7 port ${PORT}`); await ensureTools(); });
