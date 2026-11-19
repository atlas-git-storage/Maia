/**
 * In-browser video player with a subtitle picker.
 *
 * Browsers ignore subtitle streams embedded in video files, so the menu offers:
 *   - embedded MKV/WebM text tracks: the server collects their cues from the
 *     video bytes it streams (see embeddedsubs.ts) and the page polls
 *     `?subtitles` for new ones while playing;
 *   - sidecar .srt/.vtt files found in the vault;
 *   - a file picked from the device (parsed in the page, never uploaded).
 * All become TextTracks filled with VTTCues. Image subtitles (PGS, VobSub)
 * still need VLC (the "copy URL" button).
 */

import type { Snapshot } from "../types.ts";
import type { SubtitleFile } from "../subtitles.ts";
import { htmlShell } from "./layout.ts";
import { escapeAttr, escapeHtml } from "./escape.ts";

function fileUrl(snap: Snapshot, path: string): string {
  return `/${encodeURIComponent(snap.id)}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/** @param embedded the file is Matroska, so the page polls for embedded tracks */
export function renderPlayer(
  snap: Snapshot,
  videoPath: string,
  subs: SubtitleFile[],
  embedded: boolean,
): string {
  const name = videoPath.slice(videoPath.lastIndexOf("/") + 1);
  const dir = videoPath.slice(0, videoPath.lastIndexOf("/") + 1);
  const back = fileUrl(snap, dir).replace(/\/?$/, "/");
  const options = subs.map((s) =>
    `<option value="${escapeAttr(fileUrl(snap, s.path))}">${escapeHtml(s.label)}</option>`
  ).join("");

  const body = `<p><a href="${escapeAttr(back)}">← back</a></p>
<h1>${escapeHtml(name)}</h1>
<video id="v" data-embedded="${
    embedded ? escapeAttr(fileUrl(snap, videoPath) + "?subtitles") : ""
  }" controls autoplay playsinline preload="metadata" src="${
    escapeAttr(fileUrl(snap, videoPath))
  }" style="width:100%;max-height:80vh;background:#000"></video>
<p class="subs">
<label>Subtitles <select id="s"><option value="">off</option>${options}</select></label>
<label class="load">load file… <input id="f" type="file" accept=".srt,.vtt" hidden></label>
<span id="m" class="meta"></span>
</p>
<script>
const v = document.getElementById('v'), s = document.getElementById('s'),
      f = document.getElementById('f'), m = document.getElementById('m');
const tracks = new Map(); // option value -> TextTrack
const secs = (t) => t.replace(',', '.').split(':').map(Number).reduce((a, x) => a * 60 + x, 0);
function decode(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { return new TextDecoder('windows-1252').decode(buf); }
}
function addTrack(key, label, text) {
  const tr = v.addTextTrack('subtitles', label);
  let n = 0;
  for (const block of text.replace(/^\\uFEFF/, '').replace(/\\r/g, '').split(/\\n{2,}/)) {
    const lines = block.split('\\n');
    const i = lines.findIndex((l) => l.includes('-->'));
    const t = i < 0 ? null : lines[i].match(/([\\d:.,]+)\\s*-->\\s*([\\d:.,]+)/);
    if (!t) continue;
    const body = lines.slice(i + 1).join('\\n').replace(/\\{\\\\[^}]*\\}/g, '').trim();
    const a = secs(t[1]), b = secs(t[2]);
    if (body && a <= b) { tr.addCue(new VTTCue(a, b, body)); n++; }
  }
  tracks.set(key, tr);
  return n;
}
// Non-selected tracks stay 'hidden' (not 'disabled') so embedded cues keep
// accumulating in them while another track is showing.
function show(key) {
  for (const [k, tr] of tracks) tr.mode = k === key ? 'showing' : 'hidden';
}

// Embedded tracks: the server finds cues as it streams the video; fetch the
// new ones every couple of seconds while playing, and right after a seek.
const embeddedUrl = v.dataset.embedded;
let after = 0, embeddedTracks = null, busy = false;
async function pollEmbedded() {
  if (busy) return;
  busy = true;
  try {
    const r = await fetch(embeddedUrl + '&after=' + after, { credentials: 'same-origin' });
    if (!r.ok) return;
    const d = await r.json();
    if (!embeddedTracks) {
      embeddedTracks = new Map();
      const group = document.createElement('optgroup');
      group.label = 'in video';
      for (const t of d.tracks) {
        const label = [t.language, t.name, t.forced ? 'forced' : ''].filter(Boolean).join(' · ') ||
          'track ' + t.number;
        const o = new Option(t.text ? label : label + ' (image, VLC only)', 'mkv:' + t.number);
        o.disabled = !t.text;
        group.append(o);
        if (t.text) {
          const tr = v.addTextTrack('subtitles', label, t.language);
          tr.mode = 'hidden';
          tracks.set(o.value, tr);
          embeddedTracks.set(t.number, tr);
        }
      }
      if (d.tracks.length) s.insertBefore(group, s.options[1] ?? null);
      if (!embeddedTracks.size) clearInterval(timer);
    }
    for (const c of d.cues) {
      const tr = embeddedTracks.get(c.track);
      const start = Math.max(0, c.start / 1000);
      const end = c.end === null ? start + 4 : Math.max(start, c.end / 1000);
      if (tr) tr.addCue(new VTTCue(start, end, c.text));
    }
    after = d.next;
  } catch { /* transient; the next poll retries */ } finally { busy = false; }
}
let timer = 0;
if (embeddedUrl) {
  timer = setInterval(() => { if (!v.paused) pollEmbedded(); }, 2000);
  v.addEventListener('seeked', () => setTimeout(pollEmbedded, 500));
  pollEmbedded();
}
s.onchange = async () => {
  const key = s.value;
  if (key && !tracks.has(key) && !key.startsWith('mkv:')) {
    m.textContent = 'loading…';
    try {
      const r = await fetch(key, { credentials: 'same-origin' });
      if (!r.ok) throw new Error(r.status + ' ' + r.statusText);
      const n = addTrack(key, s.selectedOptions[0].text, decode(await r.arrayBuffer()));
      m.textContent = n ? '' : 'no cues found';
    } catch (e) { m.textContent = 'failed: ' + e.message; s.value = ''; }
  }
  show(s.value);
};
f.onchange = async () => {
  const file = f.files[0];
  if (!file) return;
  const key = 'local:' + file.name + ':' + Date.now();
  const n = addTrack(key, file.name, decode(await file.arrayBuffer()));
  s.add(new Option(file.name, key));
  s.value = key;
  show(key);
  m.textContent = n ? '' : 'no cues found';
  f.value = '';
};
</script>`;
  return htmlShell(`maia — ${name}`, body);
}
