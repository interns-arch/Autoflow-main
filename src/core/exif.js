'use strict';
// GPS out of a photograph's EXIF header.
//
// A shop owner photographing their own shop is standing at the location we
// are about to ask them to drop a pin on. If the camera wrote it into the
// file, asking again is asking a question we already know the answer to.
//
// READ THIS BEFORE TRUSTING IT: WhatsApp re-encodes photos sent as PHOTOS
// and strips EXIF doing it, so most shop pictures arrive with nothing here.
// A photo sent as a DOCUMENT (attach -> Document) keeps its metadata, and
// so do files forwarded from a gallery app that preserves them. So this is
// a shortcut that sometimes fires, never a replacement for the pin — the
// form still asks when there is no fix in the file.
//
// No dependency: a JPEG APP1/TIFF walk is about eighty lines and pulling a
// library in to read four tags is not worth the supply chain.

// The four GPS tags that matter. The rest of the GPS IFD (altitude, speed,
// the satellite string) has no box on the form.
const GPS_LAT_REF = 0x0001;
const GPS_LAT = 0x0002;
const GPS_LON_REF = 0x0003;
const GPS_LON = 0x0004;
const GPS_IFD_POINTER = 0x8825;

// Bytes per component, indexed by TIFF type. 5 = RATIONAL (two uint32),
// 10 = SRATIONAL. Anything else here is a tag we do not read.
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

function readU16(buf, off, le) {
  return le ? buf.readUInt16LE(off) : buf.readUInt16BE(off);
}
function readU32(buf, off, le) {
  return le ? buf.readUInt32LE(off) : buf.readUInt32BE(off);
}

// Degrees, minutes, seconds -> one number. EXIF stores each as a rational,
// and minutes or seconds may carry the fraction instead of degrees.
function dmsToDegrees(parts) {
  if (!parts || parts.length < 3) return null;
  const [d, m, s] = parts;
  if (![d, m, s].every((n) => Number.isFinite(n))) return null;
  return d + m / 60 + s / 3600;
}

// The APP1 segment that starts "Exif\0\0". A JPEG can carry several APP1s
// (XMP uses one too), so this looks for the right one rather than the first.
function findExif(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null; // not a JPEG
  let off = 2;
  while (off + 4 <= buf.length) {
    if (buf[off] !== 0xff) return null; // out of step with the marker chain
    const marker = buf[off + 1];
    // Start of scan: the image data begins and there are no more headers.
    if (marker === 0xda || marker === 0xd9) return null;
    const size = buf.readUInt16BE(off + 2);
    if (size < 2) return null;
    if (marker === 0xe1 && off + 4 + 6 <= buf.length && buf.slice(off + 4, off + 10).toString('latin1') === 'Exif\0\0') {
      return buf.slice(off + 10, off + 2 + size);
    }
    off += 2 + size;
  }
  return null;
}

// One IFD entry list -> { tag: value }. Only the tags asked for are read,
// and a malformed entry is skipped rather than throwing: a photo with a
// broken header is still a photo of a shop.
function readIfd(tiff, ifdOff, le, wanted) {
  const out = {};
  if (ifdOff + 2 > tiff.length) return out;
  const count = readU16(tiff, ifdOff, le);
  for (let i = 0; i < count; i++) {
    const e = ifdOff + 2 + i * 12;
    if (e + 12 > tiff.length) break;
    const tag = readU16(tiff, e, le);
    if (!wanted.has(tag)) continue;
    const type = readU16(tiff, e + 2, le);
    const n = readU32(tiff, e + 4, le);
    const size = (TYPE_SIZE[type] || 0) * n;
    if (!size) continue;
    // Four bytes or fewer live in the entry; anything longer is an offset.
    const at = size <= 4 ? e + 8 : readU32(tiff, e + 8, le);
    if (at + size > tiff.length) continue;

    if (type === 2) {
      out[tag] = tiff.slice(at, at + n).toString('latin1').replace(/\0.*$/, '').trim();
    } else if (type === 5 || type === 10) {
      const vals = [];
      for (let k = 0; k < n; k++) {
        const num = readU32(tiff, at + k * 8, le);
        const den = readU32(tiff, at + k * 8 + 4, le);
        vals.push(den ? num / den : 0);
      }
      out[tag] = vals;
    } else if (type === 3) {
      out[tag] = readU16(tiff, at, le);
    } else if (type === 4) {
      out[tag] = readU32(tiff, at, le);
    }
  }
  return out;
}

// base64 or Buffer -> { lat, lng } | null
//
// Never throws. A photo with no GPS, a photo that is not a JPEG, and a
// photo whose header is damaged all come back the same: null, meaning
// "ask for the pin".
function gpsFrom(image) {
  try {
    const buf = Buffer.isBuffer(image) ? image : Buffer.from(String(image || ''), 'base64');
    const tiff = findExif(buf);
    if (!tiff || tiff.length < 8) return null;

    const le = tiff.slice(0, 2).toString('latin1') === 'II';
    if (!le && tiff.slice(0, 2).toString('latin1') !== 'MM') return null;
    if (readU16(tiff, 2, le) !== 42) return null; // the TIFF magic

    const ifd0 = readU32(tiff, 4, le);
    const root = readIfd(tiff, ifd0, le, new Set([GPS_IFD_POINTER]));
    const gpsOff = root[GPS_IFD_POINTER];
    if (!gpsOff) return null;

    const gps = readIfd(tiff, gpsOff, le, new Set([GPS_LAT_REF, GPS_LAT, GPS_LON_REF, GPS_LON]));
    const lat = dmsToDegrees(gps[GPS_LAT]);
    const lng = dmsToDegrees(gps[GPS_LON]);
    if (lat === null || lng === null) return null;

    // S and W are the same numbers, the other way round the globe. Getting
    // this wrong puts an Indian shop in the Pacific.
    const latRef = String(gps[GPS_LAT_REF] || 'N').toUpperCase();
    const lonRef = String(gps[GPS_LON_REF] || 'E').toUpperCase();
    const out = {
      lat: latRef === 'S' ? -lat : lat,
      lng: lonRef === 'W' ? -lng : lng,
    };
    // 0,0 is in the Atlantic and is what a camera writes when it has no fix.
    if (!Number.isFinite(out.lat) || !Number.isFinite(out.lng)) return null;
    if (Math.abs(out.lat) < 0.0001 && Math.abs(out.lng) < 0.0001) return null;
    if (Math.abs(out.lat) > 90 || Math.abs(out.lng) > 180) return null;
    return out;
  } catch (e) {
    return null;
  }
}

module.exports = { gpsFrom };
