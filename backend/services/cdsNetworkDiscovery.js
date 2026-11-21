'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getResponder } = require('@homebridge/ciao');

function carregarIdentidade(diretorio) {
  const arquivo = path.join(diretorio, 'cds-network-discovery.json');
  fs.mkdirSync(diretorio, { recursive: true });
  let conteudo;
  try {
    conteudo = fs.readFileSync(arquivo, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    const id = crypto.randomBytes(16).toString('hex');
    const nova = { id, nome: `CDS KDS ${id}`, hostname: `cds-${id}` };
    try {
      fs.writeFileSync(arquivo, JSON.stringify(nova), { flag: 'wx' });
      return { arquivo, ...nova };
    } catch (criacaoErr) {
      if (criacaoErr.code !== 'EEXIST') throw criacaoErr;
      conteudo = fs.readFileSync(arquivo, 'utf8');
    }
  }
  const identidade = JSON.parse(conteudo);
  if (!identidade || !/^[0-9a-f]{32}$/.test(identidade.id)
    || typeof identidade.nome !== 'string' || !identidade.nome
    || typeof identidade.hostname !== 'string' || !identidade.hostname) {
    throw new Error('Identidade de descoberta inválida.');
  }
  return { arquivo, id: identidade.id, nome: identidade.nome, hostname: identidade.hostname };
}

function salvarIdentidade(identidade) {
  const temporario = `${identidade.arquivo}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporario, JSON.stringify({
      id: identidade.id, nome: identidade.nome, hostname: identidade.hostname
    }), { flag: 'wx' });
    fs.renameSync(temporario, identidade.arquivo);
  } finally {
    if (fs.existsSync(temporario)) fs.unlinkSync(temporario);
  }
}

function criarDiscoveryKds({ servidor, diretorio, obterInterfaces, autorizado, log = console,
  criarResponder = getResponder, intervaloMs = 10000 }) {
  const identidade = carregarIdentidade(diretorio);
  let responder = null;
  let servico = null;
  let assinatura = null;
  let encerrado = false;
  let timer = null;
  let fila = Promise.resolve();

  function enfileirar(trabalho) {
    const atual = fila.then(trabalho);
    fila = atual.catch((err) => {
      log.error('[CDS DISCOVERY] Falha:', err.message);
    });
    return atual;
  }

  async function removerAnuncio() {
    if (!servico) return;
    const anterior = servico;
    servico = null;
    assinatura = null;
    await anterior.destroy();
  }

  async function atualizar() {
    return enfileirar(async () => {
      if (encerrado) return;
      let redes;
      let porta;
      let disponivel;
      try {
        const endereco = servidor.address();
        redes = obterInterfaces().map((rede) => rede.endereco).sort();
        porta = endereco && typeof endereco === 'object' ? endereco.port : null;
        disponivel = servidor.listening && porta && redes.length > 0 && await autorizado();
      } catch (err) {
        await removerAnuncio();
        throw err;
      }
      if (encerrado) return;
      if (!disponivel) {
        await removerAnuncio();
        return;
      }
      const novaAssinatura = JSON.stringify({ porta, redes });
      if (assinatura === novaAssinatura) return;
      await removerAnuncio();
      if (encerrado) return;
      if (!responder) responder = criarResponder({ disableIpv6: true });
      const novo = responder.createService({
        name: identidade.nome,
        hostname: identidade.hostname,
        type: 'cds-kds',
        port: porta,
        restrictedAddresses: redes,
        disabledIpv6: true,
        txt: { id: identidade.id, versao: '1', caminho: '/cozinha', protocolo: 'http' }
      });
      servico = novo;
      novo.on('name-change', (nome) => {
        identidade.nome = nome;
        try { salvarIdentidade(identidade); } catch (err) {
          log.error('[CDS DISCOVERY] Falha ao salvar nome após conflito:', err.message);
        }
      });
      novo.on('hostname-change', (hostname) => {
        identidade.hostname = hostname;
        try { salvarIdentidade(identidade); } catch (err) {
          log.error('[CDS DISCOVERY] Falha ao salvar hostname após conflito:', err.message);
        }
      });
      try {
        await novo.advertise();
        assinatura = novaAssinatura;
        log.log(`[CDS DISCOVERY] KDS anunciado: ${identidade.id}`);
      } catch (err) {
        await removerAnuncio();
        throw err;
      }
    });
  }

  function iniciar() {
    if (timer || encerrado) throw new Error('Descoberta já iniciada ou encerrada.');
    timer = setInterval(() => { void atualizar().catch(() => {}); }, intervaloMs);
    timer.unref();
    return atualizar();
  }

  function parar() {
    if (encerrado) return fila;
    encerrado = true;
    if (timer) clearInterval(timer);
    timer = null;
    return enfileirar(async () => {
      try {
        await removerAnuncio();
      } finally {
        if (responder) {
          const anterior = responder;
          responder = null;
          await anterior.shutdown();
        }
      }
    });
  }

  function hostname() {
    return servico && assinatura ? servico.getHostname().replace(/\.$/, '').toLowerCase() : null;
  }

  return { iniciar, atualizar, parar, hostname };
}

module.exports = { carregarIdentidade, criarDiscoveryKds };
