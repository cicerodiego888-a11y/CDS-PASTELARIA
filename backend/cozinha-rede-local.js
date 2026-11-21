'use strict';

const http = require('http');
const os = require('os');

const arquivos = new Set([
  '/cozinha', '/cozinha/',
  '/cozinha-tv/cozinha-tv.js', '/cozinha-tv/cozinha-tv.css',
  '/erp/js/cozinha-kds.js', '/css/cozinha-kds.css',
  '/shared/js/cds-empresa-contexto.js'
]);

function rotaPermitida(method, pathname) {
  if (method === 'GET' && arquivos.has(pathname)) return true;
  if (method === 'GET' && [
    '/api/empresas/contexto/disponiveis',
    '/api/cozinha/unidades-disponiveis',
    '/api/cozinha/preparacao/painel'
  ].includes(pathname)) return true;
  if (method === 'POST' && [
    '/api/auth/login',
    '/api/empresas/contexto',
    '/api/cozinha/sessao/unidade'
  ].includes(pathname)) return true;
  return method === 'POST'
    && /^\/api\/cozinha\/(?:itens\/[1-9]\d*\/(?:iniciar|aguardando|pronto|cancelar)|rodadas\/[1-9]\d*\/(?:retirada|cancelar))$/.test(pathname);
}

function ipv4Inteiro(endereco) {
  const partes = String(endereco || '').split('.');
  if (partes.length !== 4 || partes.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return null;
  return partes.reduce((valor, parte) => ((valor << 8) | Number(parte)) >>> 0, 0);
}

function privado(ip) {
  return (ip >>> 24) === 10 || (ip >>> 20) === 0xac1 || (ip >>> 16) === 0xc0a8;
}

function interfacesIpv4() {
  return Object.entries(os.networkInterfaces()).flatMap(([nome, entradas]) =>
    (entradas || []).filter((item) => item.family === 'IPv4' && !item.internal
      && ipv4Inteiro(item.address) != null && privado(ipv4Inteiro(item.address)))
      .map((item) => ({ nome, endereco: item.address, mascara: item.netmask })));
}

function clientePermitido(remote, local, interfaces = interfacesIpv4()) {
  const origem = String(remote || '').replace(/^::ffff:/, '');
  const destino = String(local || '').replace(/^::ffff:/, '');
  if (origem === '127.0.0.1' && destino === '127.0.0.1') return true;
  const ipOrigem = ipv4Inteiro(origem);
  const ipDestino = ipv4Inteiro(destino);
  if (ipOrigem == null || ipDestino == null || !privado(ipOrigem)) return false;
  return interfaces.some((rede) => {
    const ip = ipv4Inteiro(rede.endereco);
    const mascara = ipv4Inteiro(rede.mascara);
    return ip === ipDestino && mascara != null
      && ((ipOrigem & mascara) >>> 0) === ((ip & mascara) >>> 0);
  });
}

function validarNomeDnsLocal(nome) {
  if (nome == null || nome === '') return null;
  const normalizado = String(nome).trim().toLowerCase();
  const partes = normalizado.split('.');
  if (normalizado.length > 253 || ipv4Inteiro(normalizado) != null
    || partes.some((parte) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(parte))) {
    throw new Error('Nome DNS local do KDS inválido.');
  }
  return normalizado;
}

function criarServidorKds(app, obterInterfaces = interfacesIpv4, nomeDnsLocal = null, obterNomeDiscovery = () => null) {
  const nomeDns = validarNomeDnsLocal(nomeDnsLocal);
  return http.createServer((req, res) => {
    const rejeitar = (status) => {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(status === 403 ? 'Acesso permitido somente na rede local.' : 'Não encontrado.');
    };
    if (!clientePermitido(req.socket.remoteAddress, req.socket.localAddress, obterInterfaces())) {
      rejeitar(403);
      return;
    }
    const local = String(req.socket.localAddress || '').replace(/^::ffff:/, '');
    const host = String(req.headers.host || '');
    const hostDns = nomeDns && (host.toLowerCase() === nomeDns
      || host.toLowerCase() === `${nomeDns}:${req.socket.localPort}`);
    const nomeDiscovery = obterNomeDiscovery();
    const hostDiscovery = nomeDiscovery && (host.toLowerCase() === nomeDiscovery
      || host.toLowerCase() === `${nomeDiscovery}:${req.socket.localPort}`);
    const hostPermitido = hostDns || hostDiscovery || (local === '127.0.0.1'
      ? /^(?:127\.0\.0\.1|localhost)(?::\d+)?$/i.test(host)
      : host === `${local}:${req.socket.localPort}` || host === local);
    if (!hostPermitido || (req.headers.origin && req.headers.origin !== `http://${host}`)) {
      rejeitar(403);
      return;
    }
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch (err) {
      rejeitar(404);
      return;
    }
    if (req.url.split('?')[0] !== url.pathname || !rotaPermitida(req.method, url.pathname)) {
      rejeitar(404);
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    app(req, res);
  });
}

module.exports = { criarServidorKds, interfacesIpv4, clientePermitido, rotaPermitida, validarNomeDnsLocal };
