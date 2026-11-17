// Audition page behaviour for docs/move-event-sounds.html: one sound at a time, a "stop" control,
// and the group buttons that play checks, castles or a move comparison in sequence. Kept in its own
// file because the extension's lint run rejects inline scripts (docs are not packaged, but the
// repository should lint clean).
const audios = [...document.querySelectorAll('audio')], status = document.querySelector('.status');
let generation = 0, queued = false;
function stop() { generation++; queued = false; audios.forEach(audio => { audio.pause(); audio.currentTime = 0; }); }
audios.forEach(audio => {
  audio.addEventListener('play', () => {
    if (!queued) generation++;
    audios.forEach(other => { if (other !== audio) { other.pause(); other.currentTime = 0; } });
    status.textContent = 'Playing · ' + audio.getAttribute('aria-label');
  });
  audio.addEventListener('error', () => { status.textContent = 'Could not load ' + audio.getAttribute('aria-label'); });
});
document.querySelector('#stop').onclick = () => { stop(); status.textContent = 'Playback stopped.'; };
document.querySelectorAll('[data-play]').forEach(button => button.onclick = async () => {
  stop(); const token = generation, mode = button.dataset.play;
  const rows = [...button.closest('section').querySelectorAll('article')];
  const list = mode === 'compare' ? rows.flatMap(row => [audios[0], ...row.querySelectorAll('audio')])
    : rows.map(row => row.querySelectorAll('audio')[mode === 'check' ? 0 : 1]);
  for (const audio of list) {
    if (token !== generation) return;
    queued = true;
    try { await audio.play(); } catch {
      if (token !== generation) return;
      queued = false; status.textContent = 'Press a sound’s play button to start playback.'; return;
    }
    if (token !== generation) return;
    queued = false;
    const end = performance.now() + (audio.duration || .6) * 1000 + 650;
    while (performance.now() < end) { if (token !== generation) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  if (token === generation) status.textContent = 'Group finished.';
});
