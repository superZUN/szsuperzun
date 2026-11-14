// Injected into every test page before the app loads (page.addInitScript).
// Fakes for the browser parts a test cannot drive for real: speech recognition, the microphone, the screen wake lock.
//
// Speech recognition (window.__sr):
//   __say(text, {alts:[...], confidence})  final result on the live recogniser
//   __interim(text)                          interim (unfinished) result
//   __end()                                  the browser ends the session on its own (fires onend)
//   __err(code, {end:true})                  onerror, then onend unless end:false
//   __recStarts                              how many times start() was called (any instance)
//   __sr.startDelay   ms between start() and onstart (default 30)
//   __sr.denyStarts   the next N start() calls fail with not-allowed
//   __sr.phrases      expose SpeechRecognitionPhrase (Chrome contextual biasing)
//   __sr.instances    every instance created; __sr.live the one currently listening
// Microphone (window.__mic): getUserMedia gives a real MediaStream fed by oscillators
//   __mic.set({voice: 0..1, hum: 0..1})      voice = 900 Hz tone (speech band), hum = 60 Hz
//   __mic.deny = true                        next getUserMedia rejects with NotAllowedError
//   __mic.opened                             getUserMedia calls that succeeded
// Wake lock (window.__wake): requests, active, release() simulates the system dropping the lock
(() => {
  const w = window;

  /* ---------------- speech recognition ---------------- */
  const sr = (w.__sr = { startDelay: 30, denyStarts: 0, phrases: false, instances: [], live: null });
  w.__recStarts = 0;
  class FakeResultList extends Array {
    item(i) { return this[i]; }
  }
  class FakeRecognition extends EventTarget {
    constructor() {
      super();
      this.continuous = false; this.interimResults = false; this.maxAlternatives = 1; this.lang = "";
      this.onstart = this.onend = this.onresult = this.onerror = null;
      this.onaudiostart = this.onsoundstart = this.onspeechstart = this.onaudioend = this.onsoundend = this.onspeechend = null;
      this._state = "idle"; this._results = new FakeResultList();
      sr.instances.push(this);
    }
    _fire(type, props = {}) {
      const ev = new Event(type); Object.assign(ev, props);
      const h = this["on" + type]; if (typeof h === "function") h.call(this, ev);
      this.dispatchEvent(ev);
    }
    start() {
      if (this._state !== "idle") { const e = new Error("recognition has already started"); e.name = "InvalidStateError"; throw e; }
      w.__recStarts++; this._state = "starting"; this._results = new FakeResultList();
      const deny = sr.denyStarts > 0; if (deny) sr.denyStarts--;
      setTimeout(() => {
        if (this._state !== "starting") return;
        if (deny) { this._fire("error", { error: "not-allowed", message: "" }); this._finish(); return; }
        this._state = "live"; sr.live = this;
        this._fire("start"); this._fire("audiostart");
      }, sr.startDelay);
    }
    stop() { this._endSoon(); }
    abort() { if (this._state === "idle") return; this._fire("error", { error: "aborted", message: "" }); this._endSoon(); }
    _endSoon() { if (this._state === "idle" || this._state === "ending") return; this._state = "ending"; setTimeout(() => this._finish(), 5); }
    _finish() { if (this._state === "idle") return; this._state = "idle"; if (sr.live === this) sr.live = null; this._fire("end"); }
    _push(text, isFinal, alts = [], confidence = 0.9) {
      const res = [{ transcript: text, confidence }, ...alts.map((t) => ({ transcript: t, confidence: confidence * 0.8 }))];
      res.isFinal = isFinal; res.item = (i) => res[i];
      const last = this._results[this._results.length - 1];
      let index;
      if (last && !last.isFinal) { index = this._results.length - 1; this._results[index] = res; }
      else { index = this._results.length; this._results.push(res); }
      this._fire("result", { resultIndex: index, results: this._results });
    }
  }
  w.SpeechRecognition = FakeRecognition;
  w.webkitSpeechRecognition = FakeRecognition;
  Object.defineProperty(w, "SpeechRecognitionPhrase", {
    configurable: true,
    get: () => (sr.phrases ? class { constructor(phrase, boost) { this.phrase = phrase; this.boost = boost; } } : undefined),
  });
  const live = () => sr.live;
  w.__say = (text, o = {}) => { const r = live(); if (!r) return false; r._push(text, true, o.alts || [], o.confidence); return true; };
  w.__interim = (text) => { const r = live(); if (!r) return false; r._push(text, false); return true; };
  w.__end = () => { const r = live(); if (!r) return false; r._finish(); return true; };
  w.__err = (code, o = {}) => {
    const r = sr.live || sr.instances[sr.instances.length - 1]; if (!r) return false;
    r._fire("error", { error: code, message: "" }); if (o.end !== false) r._finish(); return true;
  };

  /* ---------------- microphone ---------------- */
  const mic = (w.__mic = { voice: 0, hum: 0, deny: false, opened: 0, ctx: null, gains: null });
  function micGraph() {
    if (mic.ctx) return mic.ctx;
    const AC = w.AudioContext || w.webkitAudioContext;
    const ctx = new AC();
    const dest = ctx.createMediaStreamDestination();
    const mk = (freq) => { const o = ctx.createOscillator(); o.frequency.value = freq; const g = ctx.createGain(); g.gain.value = 0; o.connect(g); g.connect(dest); o.start(); return g; };
    mic.gains = { voice: mk(900), hum: mk(60) };
    mic.dest = dest; mic.ctx = ctx;
    return ctx;
  }
  mic.set = (o) => {
    Object.assign(mic, o); micGraph();
    if (mic.ctx.state === "suspended") mic.ctx.resume();
    mic.gains.voice.gain.value = mic.voice * 0.5; mic.gains.hum.gain.value = mic.hum * 0.5;
  };
  const md = navigator.mediaDevices || (navigator.mediaDevices = {});
  md.getUserMedia = async (c) => {
    if (mic.deny) { mic.deny = false; const e = new Error("Permission denied"); e.name = "NotAllowedError"; throw e; }
    if (!c || !c.audio) throw new TypeError("audio only");
    micGraph(); if (mic.ctx.state === "suspended") await mic.ctx.resume().catch(() => {});
    mic.set({});
    mic.opened++;
    return new MediaStream(mic.dest.stream.getAudioTracks().map((t) => t.clone()));
  };

  /* ---------------- screen wake lock ---------------- */
  const wake = (w.__wake = { requests: 0, active: null });
  class Sentinel extends EventTarget {
    constructor() { super(); this.released = false; this.type = "screen"; this.onrelease = null; }
    async release() { if (this.released) return; this.released = true; if (wake.active === this) wake.active = null; const ev = new Event("release"); if (this.onrelease) this.onrelease(ev); this.dispatchEvent(ev); }
  }
  Object.defineProperty(navigator, "wakeLock", {
    configurable: true,
    value: { request: async (type) => { wake.requests++; const s = new Sentinel(); wake.active = s; return s; } },
  });
  wake.release = () => wake.active && wake.active.release();
})();
