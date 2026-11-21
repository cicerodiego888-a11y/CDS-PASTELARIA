'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { carregarIdentidade, criarDiscoveryKds } = require('../../backend/services/cdsNetworkDiscovery');

test('identidade é estável e arquivo inválido causa erro', (t) => {
  const diretorio = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-discovery-'));
  t.after(() => fs.rmSync(diretorio, { recursive: true, force: true }));
  const primeira = carregarIdentidade(diretorio);
  assert.deepEqual(carregarIdentidade(diretorio), primeira);
  fs.writeFileSync(primeira.arquivo, '{}');
  assert.throws(() => carregarIdentidade(diretorio), /inválida/);
});

test('anuncia somente KDS disponível e autorizado, acompanha rede, conflito e encerramento', async (t) => {
  const diretorio = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-discovery-'));
  t.after(() => fs.rmSync(diretorio, { recursive: true, force: true }));
  const servicos = [];
  let encerramentos = 0;
  const responder = {
    createService(opcoes) {
      const servico = new EventEmitter();
      servico.opcoes = opcoes;
      servico.getHostname = () => `${servico.opcoes.hostname}.local.`;
      servico.advertise = async () => { servico.anunciado = true; };
      servico.destroy = async () => { servico.removido = true; };
      servicos.push(servico);
      return servico;
    },
    shutdown: async () => { encerramentos += 1; }
  };
  let redes = [{ endereco: '192.168.10.2' }];
  let permitido = false;
  let erro = false;
  const servidor = { listening: true, address: () => ({ port: 3002 }) };
  const discovery = criarDiscoveryKds({
    servidor, diretorio, obterInterfaces: () => redes,
    autorizado: async () => { if (erro) throw new Error('consulta'); return permitido; },
    criarResponder: () => responder, log: { log() {}, error() {} }, intervaloMs: 60000
  });
  t.after(() => discovery.parar());
  await discovery.iniciar();
  assert.equal(servicos.length, 0);
  permitido = true;
  await discovery.atualizar();
  assert.equal(servicos.length, 1);
  const primeiro = servicos[0];
  assert.equal(primeiro.opcoes.type, 'cds-kds');
  assert.equal(primeiro.opcoes.port, 3002);
  assert.deepEqual(primeiro.opcoes.restrictedAddresses, ['192.168.10.2']);
  assert.deepEqual(Object.keys(primeiro.opcoes.txt).sort(), ['caminho', 'id', 'protocolo', 'versao']);
  assert.equal(discovery.hostname(), `${primeiro.opcoes.hostname}.local`);
  await discovery.atualizar();
  assert.equal(servicos.length, 1);
  primeiro.opcoes.hostname = 'cds-renomeado';
  primeiro.emit('name-change', 'CDS KDS (2)');
  primeiro.emit('hostname-change', 'cds-renomeado');
  const identidade = carregarIdentidade(diretorio);
  assert.equal(identidade.id, primeiro.opcoes.txt.id);
  assert.equal(identidade.nome, 'CDS KDS (2)');
  assert.equal(identidade.hostname, 'cds-renomeado');
  assert.equal(discovery.hostname(), 'cds-renomeado.local');
  redes = [{ endereco: '192.168.10.3' }];
  await discovery.atualizar();
  assert.equal(primeiro.removido, true);
  assert.equal(servicos[1].opcoes.hostname, 'cds-renomeado');
  assert.deepEqual(servicos[1].opcoes.restrictedAddresses, ['192.168.10.3']);
  erro = true;
  await assert.rejects(discovery.atualizar(), /consulta/);
  assert.equal(servicos[1].removido, true);
  assert.equal(discovery.hostname(), null);
  erro = false;
  await discovery.atualizar();
  servidor.listening = false;
  await discovery.atualizar();
  assert.equal(servicos[2].removido, true);
  servidor.listening = true;
  await discovery.atualizar();
  permitido = false;
  await discovery.atualizar();
  assert.equal(servicos[3].removido, true);
  permitido = true;
  await discovery.atualizar();
  redes = [];
  await discovery.atualizar();
  assert.equal(servicos[4].removido, true);
  redes = [{ endereco: '192.168.10.3' }];
  await discovery.atualizar();
  await discovery.parar();
  assert.equal(servicos[5].removido, true);
  assert.equal(encerramentos, 1);
});

test('falha no anúncio é relatada e permite nova tentativa', async (t) => {
  const diretorio = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-discovery-'));
  t.after(() => fs.rmSync(diretorio, { recursive: true, force: true }));
  let numero = 0;
  let removidos = 0;
  const logs = [];
  const discovery = criarDiscoveryKds({
    servidor: { listening: true, address: () => ({ port: 3002 }) },
    diretorio, obterInterfaces: () => [{ endereco: '10.0.0.2' }],
    autorizado: async () => true,
    log: { log() {}, error(...args) { logs.push(args); } },
    criarResponder: () => ({
      createService() {
        const servico = new EventEmitter();
        numero += 1;
        const falhar = numero === 1;
        servico.advertise = async () => { if (falhar) throw new Error('rede'); };
        servico.destroy = async () => { removidos += 1; };
        servico.getHostname = () => 'cds.local.';
        return servico;
      },
      shutdown: async () => {}
    })
  });
  t.after(() => discovery.parar());
  await assert.rejects(discovery.iniciar(), /rede/);
  assert.equal(logs.length, 1);
  assert.equal(removidos, 1);
  assert.equal(discovery.hostname(), null);
  await discovery.atualizar();
  assert.equal(discovery.hostname(), 'cds.local');
});
