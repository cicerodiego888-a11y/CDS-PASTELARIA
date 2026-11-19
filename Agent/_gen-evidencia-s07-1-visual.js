'use strict';
const fs = require('fs');
const path = require('path');
const kds = require('../frontend/erp/js/cozinha-kds.js');

const AGORA = new Date('2026-11-17T21:10:00-03:00');
const rodadas = [
  {
    id: 11,
    mesa_numero: '1',
    numero_rodada: 2,
    sequencia_global: 1,
    enviada_em: '2026-11-17 20:55:00',
    itens: [{
      id: 201,
      numero_comanda: 12,
      tipo_item: 'PASTEL',
      estado_preparacao: 'AGUARDANDO',
      sequencia_global: 1,
      qty_solicitada: '3',
      produto_nome_snapshot: 'Pastel de queijo',
      observacoes_snapshot: 'Bem passado'
    }]
  },
  {
    id: 10,
    mesa_numero: '5',
    numero_rodada: 1,
    sequencia_global: 2,
    enviada_em: '2026-11-17 20:58:00',
    itens: [
      {
        id: 101,
        numero_comanda: 44,
        tipo_item: 'PASTEL',
        estado_preparacao: 'AGUARDANDO',
        sequencia_global: 2,
        qty_solicitada: '2',
        produto_nome_snapshot: 'Pastel de carne',
        observacoes_snapshot: 'Sem cebola'
      },
      {
        id: 102,
        numero_comanda: 44,
        tipo_item: 'BEBIDA',
        estado_preparacao: 'EM_PREPARACAO',
        sequencia_global: 3,
        qty_solicitada: '1',
        produto_nome_snapshot: 'Refrigerante 200ml',
        observacoes_snapshot: null
      }
    ]
  },
  {
    id: 12,
    mesa_numero: '07',
    numero_rodada: 3,
    sequencia_global: 3,
    enviada_em: '2026-11-17 20:50:00',
    itens: [{
      id: 301,
      numero_comanda: 99,
      tipo_item: 'OUTRO',
      estado_preparacao: 'PRONTO',
      sequencia_global: 4,
      qty_solicitada: '1.5',
      produto_nome_snapshot: 'Porção batata',
      observacoes_snapshot: ''
    }]
  }
];

const dist = kds.distribuirPorEstado(rodadas);
const htmlPainel = kds.htmlPainel({
  empresaId: 1,
  empresaRotulo: 'Pastelaria Centro',
  unidadeId: 3,
  rodadas,
  distribuicao: dist,
  carregando: false,
  erro: '',
  ultimaAtualizacao: AGORA
}, AGORA);
const css = fs.readFileSync(path.join(__dirname, '../frontend/css/cozinha-kds.css'), 'utf8');
const doc = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>S07-1 KDS Evidência Visual</title>
<style>
${css}
body{margin:0;background:#0d1117;min-width:1400px}
.kds-colunas{grid-template-columns:repeat(3,minmax(0,1fr)) !important}
.visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}
</style>
</head>
<body>${htmlPainel}</body>
</html>`;
const out = path.join(__dirname, 'EVIDENCIA-S07-1-KDS-VISUAL.html');
fs.writeFileSync(out, doc, 'utf8');
console.log('wrote', out);
