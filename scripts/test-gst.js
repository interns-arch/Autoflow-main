#!/usr/bin/env node
'use strict';
// GST: THE SHAPE, THE PHOTO, AND THE FORM.
//
// CREDITS ARE REAL MONEY. gstinapi.in meters every lookup and the account was
// down to 40 on 24 Sep, so nothing in here calls the register. The shape check
// runs before the network for exactly this reason — a typo must never cost a
// credit — and that is what is tested instead.
//
// The photo half DOES call Gemini vision, because there is no way to test
// "can it read a certificate" without reading one. It renders its own
// certificate, so it needs no fixture and no customer's real document.
//
//   npm run test:gst
const path = require('path');
const os = require('os');
process.env.SCRATCH = process.env.SCRATCH || path.join(os.tmpdir(), 'autoflow-gst-test');
require('fs').mkdirSync(process.env.SCRATCH, { recursive: true });
require('fs').writeFileSync(path.join(process.env.SCRATCH, 'state.json'), '{}');
process.env.DATA_DIR = process.env.SCRATCH;
require('dotenv').config();

const fs = require('fs');
const config = require('../src/config');
const gst = require('../src/integrations/gst');

let pass = 0;
let fail = 0;
let skip = 0;
const ok = (name, cond, detail) => {
  if (cond) {
    pass++;
    console.log('  PASS  ' + name);
  } else {
    fail++;
    console.log('  FAIL  ' + name + (detail ? '\n        ' + detail : ''));
  }
};
const skipped = (name, why) => {
  skip++;
  console.log('  SKIP  ' + name + '  (' + why + ')');
};

// ------------------------------------------------- the shape, offline
function shapeChecks() {
  console.log('\nTHE SHAPE (offline — no credit spent)\n');

  ok('a real GSTIN is accepted', gst.looksValid('06CIYPK2053H1ZZ'));
  ok('lower case and spaces are tolerated', gst.looksValid(' 06ciypk2053h1zz '));
  ok('fourteen characters is not a GSTIN', !gst.looksValid('06CIYPK2053H1Z'));
  ok('the Z in position 14 is required', !gst.looksValid('06CIYPK2053H1AZ'));
  ok('a PAN on its own is not a GSTIN', !gst.looksValid('CIYPK2053H'));
  ok('a part number is not a GSTIN', !gst.looksValid('13780M68P01'));

  // THE POINT OF CHECKING SHAPE FIRST: a typo must not reach the paid API.
  // This asserts the guard, not the network — lookup() returns immediately.
  return gst.lookup('NOT-A-GSTIN').then((r) => {
    ok('a badly shaped GSTIN is refused before the network, costing nothing', r && r.error === 'shape', JSON.stringify(r));
  });
}

// ------------------------------------------------- the form accepts a photo
function formChecks() {
  console.log('\nTHE FORM\n');
  const cc = require('../src/core/customerCreate');
  const notAnAnswer = cc._internals && cc._internals.notAnAnswer;
  if (!notAnAnswer) return skipped('a photo is an answer to "GST number?"', 'notAnAnswer is not exported');

  const gstField = { key: 'gstNo', type: 'gst' };
  ok(
    'a photo IS an answer to "GST number?"',
    notAnAnswer(gstField, { mediaType: 'image' }, '') === false,
  );
  ok(
    'a voice note is still NOT an answer to it',
    notAnAnswer(gstField, { mediaType: 'audio' }, '') === true,
  );
}

// ------------------------------------------------- reading one, with vision
async function photoChecks() {
  console.log('\nTHE PHOTOGRAPH (live vision)\n');
  if (!config.gemini || !config.gemini.apiKey) {
    return skipped('a GSTIN is read off a certificate', 'GEMINI_API_KEY not set');
  }

  const png = path.join(process.env.SCRATCH, 'cert.png');
  if (!renderCertificate(png, '06CIYPK2053H1ZZ')) {
    return skipped('a GSTIN is read off a certificate', 'no image library on this machine');
  }

  const b64 = fs.readFileSync(png).toString('base64');
  const read = await gst.readFromImage(b64, 'image/png');
  ok(
    'a GSTIN is read off a certificate photo',
    read && read.gstin === '06CIYPK2053H1ZZ',
    JSON.stringify(read),
  );

  // A picture with no GSTIN must say so, not invent one. This is the failure
  // that would open an account against a firm nobody asked for.
  const blank = path.join(process.env.SCRATCH, 'blank.png');
  fs.writeFileSync(
    blank,
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
  );
  const none = await gst.readFromImage(fs.readFileSync(blank).toString('base64'), 'image/png');
  ok('a photo with no GSTIN in it invents nothing', none && none.error === 'none', JSON.stringify(none));
}

// A certificate to read, drawn here so the suite needs no fixture and no
// customer's real document. Windows only; skipped elsewhere.
function renderCertificate(outPath, gstin) {
  if (process.platform !== 'win32') return false;
  const ps = `
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap 900,400
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::White)
$f1 = New-Object System.Drawing.Font("Arial",22,[System.Drawing.FontStyle]::Bold)
$f2 = New-Object System.Drawing.Font("Arial",18)
$br = [System.Drawing.Brushes]::Black
$g.DrawString("GOVERNMENT OF INDIA", $f1, $br, 200, 30)
$g.DrawString("FORM GST REG-06", $f2, $br, 300, 75)
$g.DrawString("GSTIN : ${gstin}", $f1, $br, 60, 180)
$g.DrawString("Legal Name : KALRA MOTORS", $f2, $br, 60, 240)
$bmp.Save("${outPath.replace(/\\/g, '\\\\')}", [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()`;
  try {
    require('child_process').execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore' });
    return fs.existsSync(outPath);
  } catch (e) {
    return false;
  }
}

(async () => {
  await shapeChecks();
  formChecks();
  await photoChecks();
  console.log('\n' + pass + ' passed, ' + fail + ' failed' + (skip ? ', ' + skip + ' skipped' : '') + '\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
