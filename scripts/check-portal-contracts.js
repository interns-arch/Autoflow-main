#!/usr/bin/env node
'use strict';
// Does the live Dealer Portal spec still say what src/integrations/portalContracts
// says? Every path and method must exist, and every request / response field
// the contract names must be in the spec's schema for it. Reads only.
//
//   node scripts/check-portal-contracts.js
const config = require('../src/config');
const { CONTRACTS } = require('../src/integrations/portalContracts');

(async () => {
  const base = String(config.dealerPortal.baseUrl || 'https://vagmine.vagminetech.com/api/v1').replace(/\/api\/v1\/?$/, '');
  const res = await fetch(base + '/openapi.json');
  if (!res.ok) throw new Error('openapi.json: HTTP ' + res.status);
  const spec = await res.json();
  const schemas = (spec.components && spec.components.schemas) || {};
  const props = (name) => Object.keys((schemas[name] && schemas[name].properties) || {});
  let bad = 0;
  const fail = (name, why) => {
    bad++;
    console.log('  FAIL  ' + name + ': ' + why);
  };
  for (const [name, c] of Object.entries(CONTRACTS)) {
    const before = bad;
    const op = spec.paths[c.path] && spec.paths[c.path][c.method.toLowerCase()];
    if (!op) {
      fail(name, `${c.method} ${c.path} is not in the spec`);
      continue;
    }
    const params = (op.parameters || []).map((p) => p.name);
    for (const q of Object.keys(c.query || {})) if (!params.includes(q)) fail(name, `query "${q}" is not a parameter`);
    for (const p of Object.keys(c.params || {})) if (!params.includes(p)) fail(name, `path parameter "${p}" is not in the spec`);
    if (c.requestSchema) {
      const have = props(c.requestSchema);
      if (!have.length) fail(name, `request schema ${c.requestSchema} is not in the spec`);
      for (const f of c.body || []) if (have.length && !have.includes(f)) fail(name, `request field "${f}" is not in ${c.requestSchema}`);
    }
    if (c.responseSchema) {
      const have = props(c.responseSchema);
      if (!have.length) fail(name, `response schema ${c.responseSchema} is not in the spec`);
      for (const f of c.fields || []) if (have.length && !have.includes(f)) fail(name, `response field "${f}" is not in ${c.responseSchema}`);
    }
    if (bad === before) console.log('  ok    ' + name + ' — ' + c.method + ' ' + c.path);
  }
  console.log(bad ? `\n${bad} mismatch(es) with the live spec` : '\nEvery contract matches the live spec.');
  process.exit(bad ? 1 : 0);
})().catch((e) => {
  console.log('ERR', e.message);
  process.exit(1);
});
