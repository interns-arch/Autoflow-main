'use strict';
// Stage 3 of the pipeline, first cut: a message that carries a voice note, a
// PDF, a spreadsheet or a photo.
//
// Phase 2 of the pipeline review (13 Sep) lifted this out of
// customerBot.handleMessage WITHOUT changing a line of what it does: each
// branch still ends the way it did (an order, a person asked, a reply). In
// Phase 4 these become pure extraction - text and candidate lines - and the
// deciding moves to one place. Until then, moved is all this is.
//
// 13 Sep, founder: every change for everyone. A customer in a group now gets
// the same answers here as in a DM (transcripts read, fallbacks said).
//
// Returns NOT_MEDIA for a message that is none of these, so the caller carries
// on with it as text; anything else is the handler's own return value.
const fs = require('fs');
const store = require('../store');
const ai = require('../core/ai');
const sheet = require('../core/sheet');
const availability = require('../core/availability');
const escalation = require('../core/escalation');
const lists = require('../core/lists');
const documents = require('../core/documents');
const speech = require('../integrations/speech');
const lang = require('../core/lang');
const voiceNote = require('../core/voiceNote');

const NOT_MEDIA = Symbol('not media');

// READ, DO NOT ANSWER — for the agent.
//
// handleMedia below reads an attachment AND replies to it with fixed text,
// which is right for the staff tooling it still serves. A customer's message
// is answered by the agent, which writes every word itself; so for customers
// the attachment is only READ here, with the same readers, and its contents
// go to the agent as facts (agent/incoming.describeAttachment).
//
// -> { text, attachment }. `text` is what the customer said in words — a
// caption, or what a voice note says. Nothing here sends a message.
async function readForAgent(bot, m) {
  const incoming = require('../agent/incoming');
  const caption = (m.body || '').trim() || null;

  if (['ptt', 'audio'].includes(m.mediaType)) {
    if (!m.mediaBase64) return { text: caption, attachment: { kind: 'voice', transcript: null } };
    const transcript = await speech.transcribe(m.mediaBase64, m.mediaMime).catch(() => null);
    // Held, so that if the agent asks a person about it, the recording goes too.
    voiceNote.hold(m.chatId, { base64: m.mediaBase64, mime: m.mediaMime || 'audio/ogg', transcript: transcript || undefined });
    if (transcript) lang.note(m.chatId, transcript);
    store.log(bot.key, transcript ? `voice note read for the agent: "${transcript.slice(0, 60)}"` : 'voice note could not be transcribed');
    return { text: transcript || null, attachment: { kind: 'voice', transcript: transcript || null } };
  }

  if (!m.mediaBase64) return { text: caption, attachment: null };

  if (/pdf/i.test(m.mediaMime || '')) {
    const doc = await documents.readPdf(m.mediaBase64).catch(() => null);
    let lines = [];
    if (doc && doc.how === 'text') lines = documents.orderLinesFrom(doc) || [];
    else if (doc && doc.how === 'render' && doc.images.length) {
      for (const img of doc.images) {
        const page = await ai.parseOrderImage(fs.readFileSync(img).toString('base64'), 'image/png');
        if (page && page.length) lines = lines.concat(page);
      }
      documents.cleanupRendered(doc.images);
    }
    return { text: caption, attachment: { kind: 'document', fileName: m.fileName || null, lines, note: doc ? null : 'the PDF could not be opened' } };
  }

  if (sheet.isSheet(m.mediaMime, m.fileName)) {
    const lines = sheet.parseOrderSheet(Buffer.from(m.mediaBase64, 'base64')) || [];
    return { text: caption, attachment: { kind: 'document', fileName: m.fileName || null, lines, note: lines.length ? null : 'no part numbers in the sheet' } };
  }

  if (/^image\//.test(m.mediaMime || '')) {
    incoming.holdPhoto(m.chatId, { base64: m.mediaBase64, mime: m.mediaMime });
    // A photo sent while an account form is open is the shop photograph the
    // form asked for, not an order: it goes to the form, unread.
    if (require('../core/customerCreate').pending(m.chatId)) return { text: caption, attachment: { kind: 'photo', forForm: true } };
    const lines = (await ai.parseOrderImage(m.mediaBase64, m.mediaMime)) || [];
    return { text: caption, attachment: { kind: 'photo', lines, note: lines.length ? null : ai.imageNote() } };
  }

  if (m.mediaType === 'document') {
    return { text: caption, attachment: { kind: 'document', fileName: m.fileName || null, lines: [], note: 'a kind of file we cannot read' } };
  }
  return { text: caption, attachment: null };
}

async function handleMedia(bot, m, reply, t) {
  // A voice note is transcribed and then treated as what it is: a message
  // the customer spoke instead of typing. Only a note we could NOT read goes
  // straight to a person, with the recording attached.
  if (['ptt', 'audio'].includes(m.mediaType)) {
    // If they recorded it ON one of our numbered lists, send the list with
    // the recording. "Leave the ninth one, third one three pieces" is
    // unanswerable on its own and perfectly clear next to the list. Only a
    // real quote counts — guessing which list a loose voice note belongs to
    // is how the wrong part gets removed.
    const quoted = m.contextId ? lists.forReply(m.chatId, m.contextId) : null;
    const about =
      quoted && quoted.wamid === m.contextId
        ? quoted.lines.map((l, i) => `${i + 1}. ${l.item}${l.qty ? ` x${l.qty}` : ''}`).join('\n')
        : null;
    if (about) store.log(bot.key, 'voice note replies to a numbered list; list sent with it');
    // Read the recording. Returns null on any failure — no key, Google down,
    // out of quota, mostly [unclear] — and the voice note then reaches a
    // person exactly as it did before any of this existed.
    const transcript = m.mediaBase64 ? await speech.transcribe(m.mediaBase64, m.mediaMime) : null;

    if (transcript) {
      // 1. "nauwa hata do" against a list they actually quoted. Safe to do
      //    outright: a line number only NAMES a line — it cannot invent a
      //    part — and the quantity path re-checks the portal anyway.
      if (about && lists.looksLikeListEdit(transcript)) {
        const done = await bot.editListByNumber(m, transcript, reply, t);
        if (done) {
          store.log(bot.key, `voice list edit applied: "${transcript.slice(0, 50)}"`);
          return true;
        }
      }

      // 2. A part number they spoke. Read it BACK and wait for a yes.
      //    Nothing is added to the cart here.
      const heard = await bot.heardOrder(m, transcript, reply, t);
      if (heard) return true;

      // 3. ANYTHING ELSE THEY SAID. 21 Sep, live: "Maruti Suzuki Swift Dzire
      //    ka bumper price" was transcribed perfectly and still went to a
      //    person, because the only two things a transcript could do here
      //    were edit a numbered list or carry a part number. Typed, that
      //    same sentence gets a car, a part and a rate without anyone being
      //    asked — so hand the words to the text path and let it answer.
      //    A voice note is a message the customer spoke instead of typing.
      //
      //    Nothing downstream reads m.mediaBase64 on the customer path, so
      //    the words are all that changes. The recording waits in
      //    core/voiceNote, and goes with the question if the text path does
      //    end up asking a person after all.
      m.body = transcript;
      lang.note(m.chatId, transcript);
      voiceNote.hold(m.chatId, {
        base64: m.mediaBase64,
        mime: m.mediaMime || 'audio/ogg',
        transcript,
      });
      store.log(bot.key, `voice note read as text: "${transcript.slice(0, 60)}"`);
      return NOT_MEDIA;
    }
    const asked = m.mediaBase64
      ? await escalation.create(bot, {
          chatId: m.chatId,
          customerPhone: m.from,
          item: 'voice note',
          qty: 1,
          kind: 'order',
          reason: 'VOICE',
          audio: { base64: m.mediaBase64, mime: m.mediaMime || 'audio/ogg' },
          about,
          transcript,
        })
      : null;
    if (asked) {
      store.log(bot.key, 'voice note passed to the helper');
      return reply(
        t(
          'Got your voice note. Someone is listening to it now and will reply shortly.',
          'Aapka voice message mil gaya. Abhi sun kar jawab deta hoon.',
        ),
      );
    }
    return reply(
      t(
        "Sorry, voice notes don't play for me - could you type it or send a photo? Like: Brake Pad 5",
        'Sorry, voice note sun nahi paa raha - type karke ya photo bhej denge? Jaise: Brake Pad 5',
      ),
    );
  }

  // PDF. Two very different files arrive under the same extension: a typed
  // order list exported from the customer's software, where the text is
  // really in the file, and a scan of a paper order, which is a picture in a
  // PDF wrapper. pdfplumber handles the first exactly — including the table
  // grid, so a part number keeps its quantity — and the second is rendered
  // to pages and read by the same vision path a photo takes.
  if (m.mediaBase64 && /pdf/i.test(m.mediaMime || '') ) {
    const doc = await documents.readPdf(m.mediaBase64);
    let lines = [];
    if (doc && doc.how === 'text') {
      lines = documents.orderLinesFrom(doc);
    } else if (doc && doc.how === 'render' && doc.images.length) {
      for (const img of doc.images) {
        const page = await ai.parseOrderImage(fs.readFileSync(img).toString('base64'), 'image/png');
        if (page && page.length) lines = lines.concat(page);
      }
      documents.cleanupRendered(doc.images);
    }
    if (lines.length) {
      store.log(bot.key, `pdf "${m.fileName || 'file'}": ${lines.length} line(s) via ${doc.how}`);
      if (await require('../core/salesOrder').analyseLines(bot, m, lines, (m.body || '').trim(), reply, t)) return true;
      return bot.processOrderLines(
        m,
        lines,
        reply,
        t(`📄 Your order from ${m.fileName || 'the PDF'}:`, `📄 ${m.fileName || 'PDF'} se aapka order:`),
        { fromPhoto: true },
      );
    }
    // Nothing orderable in it — almost always our own invoice or sales order
    // coming back at us. A person decides what that means.
    store.log(bot.key, `pdf "${m.fileName || 'file'}": nothing orderable`);
    const asked = await escalation.create(bot, {
      chatId: m.chatId,
      customerPhone: m.from,
      item: m.fileName || 'a PDF',
      qty: 1,
      kind: 'inquiry',
      reason: 'DOCUMENT',
      docName: 'a PDF',
    });
    return reply(
      asked
        ? t(
            'Received. Passing this to our team — they will get back to you on it.',
            'Mil gaya. Team ko bhej diya hai, wo iska jawab denge.',
          )
        : t(
            'I could not read an order out of this PDF. Please type the part numbers and quantities.',
            'Is PDF se order nahi padh paya. Part number aur quantity type kar dijiye.',
          ),
    );
  }

  // Excel / CSV order list. Customers forward their own pending-list export
  // ("FORD PENDING LIST 1-09.xlsx") and expect an answer on it like any other
  // order. Read as a grid, not against a template — there is no agreed format.
  if (m.mediaBase64 && sheet.isSheet(m.mediaMime, m.fileName)) {
    const lines = sheet.parseOrderSheet(Buffer.from(m.mediaBase64, 'base64'));
    if (lines && lines.length) {
      if (await require('../core/salesOrder').analyseLines(bot, m, lines, (m.body || '').trim(), reply, t)) return true;
      const noQty = lines.filter((l) => l.qtyMissing).length;
      store.log(
        bot.key,
        `sheet "${m.fileName || 'file'}": ${lines.length} line(s) read${noQty ? `, ${noQty} without qty` : ''}`,
      );
      // Nothing is added up or dropped, so the only thing worth saying is
      // what we could not read: a missing quantity column. Everything else
      // comes back exactly as they sent it.
      const refs = [...new Set(lines.map((l) => l.ref).filter(Boolean))];
      const head =
        t(`📄 Your order from ${m.fileName || 'the file'}`, `📄 ${m.fileName || 'File'} se aapka order`) +
        (refs.length > 1 ? ` (${refs.length} order)` : '') +
        ':' +
        (noQty
          ? t(
              `\n(${noQty} item had no quantity in the file — taken as 1)`,
              `\n(${noQty} item ki qty file mein nahi thi — 1 maan li hai)`,
            )
          : '');
      return bot.processOrderLines(m, lines, reply, head, {
        fromSheet: true,
        fromPhoto: true, // a re-sent file means "read it again", not "double it"
      });
    }
    store.log(bot.key, `sheet "${m.fileName || 'file'}": nothing readable`);
    return reply(
      lines === null
        ? t(
            'I could not open this file. Please send an Excel/CSV, or type the part number:\n16141M68K00 10',
            'Ye file khul nahi payi. Excel/CSV bhejein, ya part number type kar dijiye:\n16141M68K00 10',
          )
        : t(
            'No part number found in the file. Please type the part number and quantity:\n16141M68K00 10',
            'File mein koi part number nahi mila. Part number aur qty type kar dijiye:\n16141M68K00 10',
          ),
    );
  }

  // photo order — the PICTURE and its CAPTION are read together
  if (m.mediaBase64 && /^image\//.test(m.mediaMime || '')) {
    const caption = (m.body || '').trim();
    const capQty = ai.captionQty(caption); // "2pc" / "3pise" / "2pise ye hi ji"
    let lines = await ai.parseOrderImage(m.mediaBase64, m.mediaMime);

    // The customer wrote the part number themselves, under the picture:
    //   "Rear shoker Swift 2025 model 2pise no 41800m75t00"
    // The box in that photo carried a different number (EM865001, its
    // supplier code), vision read that, and the question went to a person -
    // while the team answered straight off the caption. A number a person
    // typed beats a number read off a box.
    const capPart = caption ? ai.partNumberIn(caption) : null;
    if (capPart && lines && lines.length === 1) {
      const same = String(lines[0].item || '').toUpperCase().replace(/[^A-Z0-9]/g, '') ===
        String(capPart).toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!same) {
        store.log(bot.key, 'photo said "' + lines[0].item + '", the caption says ' + capPart + ' - going with the caption');
        lines = [{ ...lines[0], item: capPart, requested: caption }];
      }
    }

    if (lines && lines.length) {
      // The picture shows the part, the caption carries the quantity —
      // exactly how the Kalra Motor chat runs. Only apply it when the
      // image itself gave no quantity, so a real qty in the photo always
      // wins over the caption.
      // ONE part in the picture: the caption is the order quantity and it
      // wins outright. The "QTY 1" printed on a Maruti box is the pack size,
      // not what the customer wants — letting it beat a caption saying
      // "6pise" recorded an order for one.
      //
      // SEVERAL parts: the photo is a list with its own quantities, so the
      // caption only fills the lines that have none.
      if (capQty) {
        lines =
          lines.length === 1
            ? lines.map((l) => ({ ...l, qty: capQty, qtyMissing: false }))
            : // "quantity 1" and "no quantity at all" are not the same thing.
              // Reading qty===1 as missing meant a photo that really said
              // "x1" was overwritten by a caption meant for the OTHER lines.
              // parseOrderImage already marks the ones it could not read.
              lines.map((l) => (l.qtyMissing ? { ...l, qty: capQty, qtyMissing: false } : l));
        store.log(
          bot.key,
          `photo caption "${caption}" -> qty ${capQty} applied to ${lines.length} line(s)`,
        );
      }
      // The desk asking for an analysis of the list in the picture: "analyze
      // this order for kalra motors. I need all details." (13 Sep, live - it
      // came back as a stock check on the founder's own account instead).
      if (await require('../core/salesOrder').analyseLines(bot, m, lines, caption, reply, t)) return true;
      return bot.processOrderLines(
        m,
        lines,
        reply,
        t('📷 Your order from the photo:', '📷 Photo se aapka order:'),
        { fromPhoto: true },
      );
    }

    // NO PART IN IT, BUT A NUMBER PLATE IS. The customer photographed their
    // car: "this is mine, find me the part for it". 21 Sep, live: those went
    // to the helper as "could not read the part number" — a person was sent
    // a picture of a car and asked to find a part nobody had named yet.
    // Look the plate up and ask which part, the way the counter would.
    const seenPlate = lines && lines.plate;
    if (seenPlate) {
      const vahan = require('../integrations/vahan');
      const vehicle = require('../core/vehicle');
      const car = await vahan.lookup(seenPlate);
      if (car) {
        vehicle.remember(m.chatId, car);
        store.log(bot.key, `photo plate ${seenPlate} -> ${vahan.describe(car)}`);
        return reply(
          t(
            `${vahan.describe(car)}. Which part do you need?`,
            `${vahan.describe(car)}. Kaunsa part chahiye?`,
          ),
        );
      }
      // The plate was legible, the registry was not reachable (or does not
      // know it). Still not a question for a person — say what we read and
      // ask for the part.
      store.log(bot.key, `photo plate ${seenPlate} not resolved`);
      return reply(
        t(
          `I can see ${seenPlate}. Which part do you need for it?`,
          `${seenPlate} dikh raha hai. Iske liye kaunsa part chahiye?`,
        ),
      );
    }

    // Photo unreadable — but the caption itself may carry the whole order
    // ("<image> 10pcs timing seal 16141M68K00").
    if (caption) {
      const fromCaption = await ai.parseCustomerMessage(caption, availability.catalogNames());
      if (fromCaption.intent === 'order' && (fromCaption.lines || []).length) {
        return bot.processOrderLines(
          m,
          fromCaption.lines,
          reply,
          t('From your message:', 'Aapke message se:'),
        );
      }
    }

    // Nothing readable in the picture — a photo of the part itself, a blurry
    // label, a screenshot of something else. Telling the customer to type a
    // part number they do not have is not an answer; it is how a live sale
    // ends. A PERSON can look at this in two seconds, so send them the photo
    // and let the customer wait for a real reply.
    // Vision now says what the photo IS, not only what it could read off it.
    // Customers photograph our own paperwork constantly — bills, gate passes,
    // cheques. Four of those in the Kalra replay reached the helper labelled
    // "could not read the part number", which reads as a bot failure about a
    // document the reader can see perfectly well. Name it instead.
    const DOCS = { invoice: 'a bill', gatepass: 'a gate pass', challan: 'a challan', payment: 'a payment' };
    const docType = (lines && lines.docType) || null;
    const docName = DOCS[docType] || null;

    // The console shows this under the photo, so the founder sees the
    // picture AND why it gave nothing, without opening the logs.
    require('../core/chatLog').note(
      bot.key,
      m.chatId,
      m.from,
      docName
        ? "photo read as " + docName + ", not an order"
        : "photo not read: " + (ai.imageNote() || "no part number found in it"),
    );

    // The sales desk is never sent to the helper (founder, 13 Sep). They are
    // told the photo could not be read, and what to send instead.
    if (require('../core/salesOrder').isSalesPerson(m.from)) {
      store.log(bot.key, 'desk photo not read - told them, nobody asked');
      return reply(
        docName
          ? t(`That looks like ${docName}, not a parts list.`, `Ye ${docName} lag raha hai, parts ki list nahi.`)
          : t(
              "Couldn't read part numbers in this photo - send a clearer photo or type the list (part number and quantity, one per line).",
              'Is photo se part number nahi padh paya - saaf photo bhejiye ya list type kar dijiye (har line mein part number aur quantity).',
            ),
      );
    }
    const askedHuman = await escalation.create(bot, {
      chatId: m.chatId,
      customerPhone: m.from,
      // "3pise" is the quantity, not the name of the part. Using it as the
      // item made the helper's pending list read "#1 3pise".
      item: docName ? docName : caption && !ai.bareQty(caption) ? caption : 'photo',
      qty: capQty || 1,
      kind: 'order',
      reason: docName ? 'DOCUMENT' : 'UNREADABLE',
      docName,
      photo: { base64: m.mediaBase64, mime: m.mediaMime || 'image/jpeg' },
    });
    if (askedHuman) {
      store.log(
        bot.key,
        `${docName ? 'document (' + docType + ')' : 'unreadable photo'} sent to the helper`,
      );
      return reply(
        docName
          ? t(
              'Received. Passing this to our team — they will get back to you on it.',
              'Mil gaya. Team ko bhej diya hai, wo iska jawab denge.',
            )
          : t(
              'Let me check this photo and get back to you shortly',
              'Ye photo check karke abhi bata raha hoon',
            ),
      );
    }

    // Only when there is no one to ask — no connected line, or the send
    // failed. Then the customer typing it out really is the fastest way.
    return reply(
      t(
        "Couldn't read the part number in the photo - could you type it? Like 16141M68K00 10",
        'Photo mein part number clear nahi aa raha - type kar denge? Jaise 16141M68K00 10',
      ),
    );
  }

  return NOT_MEDIA;
}

module.exports = { handleMedia, readForAgent, NOT_MEDIA };
