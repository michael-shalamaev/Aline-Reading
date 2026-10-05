// A stand-in for Microsoft's Speech SDK, for browser tests only.
// It "reads" the reference text aloud, word by word, following window.__fakeReading:
//   { skip: [word indexes to leave out], mis: [indexes said badly], perWordMs: 25 }
(function () {
  const RECOGNIZED = 3;

  function result(words) {
    const json = { NBest: [{ Words: words.map((w) => ({ Word: w.word, PronunciationAssessment: { AccuracyScore: w.acc, ErrorType: 'None' } })) }] };
    return {
      reason: RECOGNIZED,
      text: words.map((w) => w.word).join(' '),
      properties: { getProperty: () => JSON.stringify(json) }
    };
  }

  class SpeechRecognizer {
    constructor() { this.timers = []; this.authorizationToken = ''; }
    startContinuousRecognitionAsync(ok) {
      ok();
      const plan = Object.assign({ skip: [], mis: [], perWordMs: 25 }, window.__fakeReading || {});
      const words = this._ref.split(' ')
        .map((w, i) => ({ word: w.toLowerCase(), acc: plan.mis.includes(i) ? 20 : 95, i }))
        .filter((w) => !plan.skip.includes(w.i));
      let segment = [];
      words.forEach((w, k) => {
        this.timers.push(setTimeout(() => {
          segment.push(w);
          this.recognizing && this.recognizing(this, { result: { text: segment.map((x) => x.word).join(' ') } });
          if (segment.length === 8 || k === words.length - 1) {
            const done = segment;
            segment = [];
            this.recognized && this.recognized(this, { result: result(done) });
          }
        }, (k + 1) * plan.perWordMs));
      });
    }
    stopContinuousRecognitionAsync(ok) { this.timers.forEach(clearTimeout); setTimeout(ok, 10); }
    recognizeOnceAsync(ok) { setTimeout(() => ok(result([{ word: this._ref.toLowerCase(), acc: 90 }])), 50); }
    close() {}
  }

  window.SpeechSDK = {
    SpeechConfig: { fromAuthorizationToken: () => ({ setProperty() {}, speechRecognitionLanguage: '' }) },
    AudioConfig: { fromDefaultMicrophoneInput: () => ({}) },
    PropertyId: { Speech_SegmentationSilenceTimeoutMs: 1, SpeechServiceResponse_JsonResult: 2 },
    ResultReason: { RecognizedSpeech: RECOGNIZED },
    CancellationReason: { Error: 1 },
    PronunciationAssessmentConfig: {
      fromJSON: (j) => ({ applyTo: (rec) => { rec._ref = JSON.parse(j).referenceText; } })
    },
    SpeechRecognizer
  };
})();
