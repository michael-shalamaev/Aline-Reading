/**
 * SpeechToken.gs — issues a short-lived Microsoft Speech token.
 * The permanent key never leaves this script; the phone gets a token valid 10 minutes.
 */

var TOKEN_LIFE_SEC = 600;   // Microsoft's token lifetime
var TOKEN_REUSE_SEC = 300;  // reuse one token for 5 minutes, so it always has 5+ left

function issueSpeechToken() {
  var region = prop('AZURE_SPEECH_REGION', true);
  var cache = CacheService.getScriptCache();
  var hit = cache.get('speech_token');
  if (hit) {
    var c = JSON.parse(hit);
    var left = TOKEN_LIFE_SEC - Math.floor((Date.now() - c.at) / 1000);
    return { token: c.token, region: region, ttlSec: left };
  }

  var res = UrlFetchApp.fetch('https://' + region + '.api.cognitive.microsoft.com/sts/v1.0/issueToken', {
    method: 'post',
    headers: { 'Ocp-Apim-Subscription-Key': prop('AZURE_SPEECH_KEY', true) },
    payload: '',
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    fail('speech_token_error', 'Microsoft ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200));
  }
  var token = res.getContentText();
  cache.put('speech_token', JSON.stringify({ token: token, at: Date.now() }), TOKEN_REUSE_SEC);
  return { token: token, region: region, ttlSec: TOKEN_LIFE_SEC };
}
