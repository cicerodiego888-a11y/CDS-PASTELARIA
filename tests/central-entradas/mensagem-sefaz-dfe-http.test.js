'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  enriquecerMensagemSefazDfeHttp,
  codigoErroSincronizacaoDfe
} = require('../../backend/motores/central-entradas/utils/mensagemSefazDfeHttp');

const MSG_403_HOM = 'HTTP 403 em https://hom1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx'
  + ' — resposta HTML da SEFAZ/proxy (endpoint ou rota inválida).';

test('403 homologação: não troca URL e orienta Produção na própria empresa', () => {
  const out = enriquecerMensagemSefazDfeHttp(MSG_403_HOM, { ambiente: 2 });
  assert.match(out, /HTTP 403/);
  assert.match(out, /hom1\.nfe\.fazenda\.gov\.br/);
  assert.match(out, /tpAmb=2/);
  assert.match(out, /Produção \(1\)/);
  assert.doesNotMatch(out, /www1\.nfe\.fazenda\.gov\.br/);
  assert.doesNotMatch(out, /empresa 1/);
});

test('403 produção: não sugere homolog e não inventa outro db', () => {
  const out = enriquecerMensagemSefazDfeHttp(
    'HTTP 403 em https://www1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx',
    { ambiente: 1 }
  );
  assert.match(out, /certificado/);
  assert.doesNotMatch(out, /hom1/);
});

test('código SEFAZ permanece para transporte HTTP', () => {
  assert.equal(codigoErroSincronizacaoDfe(MSG_403_HOM), 'SEFAZ');
  assert.equal(codigoErroSincronizacaoDfe('Certificado não configurado'), 'CERTIFICADO');
});

test('UI fetch da Central lê mensagemAmigavel além de error', () => {
  const js = fs.readFileSync(
    path.join(__dirname, '../../frontend/erp/js/central-entradas.js'),
    'utf8'
  );
  assert.match(js, /function mensagemErroHttpCentral/);
  assert.match(js, /data\.mensagemAmigavel/);
});

test('rota sync inclui error no JSON', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../../backend/rotas/central-entradas.js'),
    'utf8'
  );
  assert.match(src, /function jsonSyncCentral/);
  assert.match(src, /json\(jsonSyncCentral\(resultado\)\)/);
});
