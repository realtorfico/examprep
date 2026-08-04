// Web Speech API — free, client-only, no backend involved.
// onEnd (optional) fires once speech finishes or fails/gets cancelled -- lets a caller (e.g.
// quiz auto-advance) wait for the read-aloud to actually finish instead of racing a fixed timer.
function speak(text, onEnd) {
  if (!('speechSynthesis' in window)) { if (onEnd) onEnd(); return; }
  window.speechSynthesis.cancel();
  var u = new SpeechSynthesisUtterance(text);
  u.rate = 0.95;
  if (onEnd) { u.onend = onEnd; u.onerror = onEnd; }
  window.speechSynthesis.speak(u);
}
function stopSpeaking() {
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
}
