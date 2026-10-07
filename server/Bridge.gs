/**
 * Bridge.gs — lets the new server (Cloudflare) use this script for what lives in Google:
 * the children's settings in the sheet, and the parent's log rows, hard words, errors
 * and e-mails. Every bridge request must carry BRIDGE_SECRET (a Script Property);
 * without it, these two actions refuse. Nothing else in this script changes.
 */


function bridgeCheck(req) {
  var secret = prop('BRIDGE_SECRET');
  if (!secret || String(req.secret || '') !== secret) fail('unauthorized', 'Bad bridge secret');
}

/** The children's settings, read fresh from the sheet. */
function actBridgeSettings(child, req) {
  bridgeCheck(req);
  clearSettingsCache();
  return { children: readChildren(), sheetUrl: sheetUrl() };
}

/** Rows and mails, in the order the new server sends them. One failed item does not stop the rest. */
function actBridgeReport(child, req) {
  bridgeCheck(req);
  var results = (req.items || []).map(function (it) {
    try {
      bridgeItem(it);
      return { id: it.id, ok: true };
    } catch (e) {
      logError(it.childId || '', 'bridge ' + it.kind, e);
      return { id: it.id, ok: false, error: String((e && e.message) || e) };
    }
  });
  return { results: results };
}

function bridgeChild(id) {
  var found = readChildren().filter(function (c) { return c.id === id; })[0];
  return found || { id: id, name: id, emails: '' };
}

function bridgeItem(it) {
  var child = bridgeChild(it.childId);
  var sess = it.sess;
  switch (it.kind) {
    case 'pageAttempt':
      logPageAttempt(child, sess, it.page, it.attemptNo, it.attempt, it.below);
      return;
    case 'session':
      logSession(child, sess, it.result);
      withLock(function () { updateHardWords(child, sess); });
      sendSummaryMail(child, sess, it.result);
      return;
    case 'expired':
      logExpired(child, sess, it.pagesDone);
      sendExpiredMail(child, sess, it.pagesDone);
      return;
    case 'practice':
      withLock(function () { logPracticeResults(child, it.results || []); });
      return;
    case 'error':
      sheet(SHEETS.errors).appendRow([
        new Date(it.at || Date.now()), it.childId || '', String(it.action || '').slice(0, 80),
        String(it.message || '').slice(0, 600), String(it.details || '').slice(0, 4000)
      ]);
      return;
    default:
      fail('bad_payload', 'Unknown report kind ' + it.kind);
  }
}

/**
 * Run once from the editor: makes a long random secret, keeps it in the Script Properties
 * (BRIDGE_SECRET) and prints it, to paste into Cloudflare as the secret of the same name.
 * Running it again makes a new secret (then paste the new one in Cloudflare too).
 */
function makeBridgeSecret() {
  var secret = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  setProp('BRIDGE_SECRET', secret);
  Logger.log('BRIDGE_SECRET (להעתיק לקלאודפלייר): ' + secret);
  return secret;
}
