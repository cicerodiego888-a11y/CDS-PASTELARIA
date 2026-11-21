/**
 * PDV-MOBILE-09 — identidade, presença e caixa exclusivo do Mobile.
 * Usa somente banco temporário; não abre o banco oficial nem processa vendas.
 *
 * Executar: node --test --test-concurrency=1 tests/mobile-pdv/pdv-mobile-09.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { before, after, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-mobpdv09-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const db = require('../../backend/database');
const configService = require('../../backend/services/configuracaoService');
const recursosOriginais = configService.getRecursos.bind(configService);
const modoOriginal = configService.obterModoOperacionalGlobal;
configService.getRecursos = (...args) => {
  const recursos = recursosOriginais(...args);
  return {
    ...recursos,
    recursos: { ...recursos.recursos, multiCaixa: true }
  };
};
configService.obterModoOperacionalGlobal = () => 'MULTIEMPRESA';

const { getJwtSecret } = require('../../backend/config/secrets');
const { verificarToken } = require('../../backend/middleware/auth');
const validarTerminalMobile = require('../../backend/middleware/validarTerminalMobile');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaUsuarioEmpresasAsync } = require('../../backend/services/empresas/usuarioEmpresasSchema');
const terminaisRouter = require('../../backend/rotas/terminais');
const caixaRouter = require('../../backend/rotas/caixa');

const INSTALLATION_ID = '123e4567-e89b-42d3-a456-426614174000';
const INSTALLATION_ID_OUTRA = '123e4567-e89b-42d3-a456-426614174001';
const CNPJ_EMPRESA = '11222333000181';
const CNPJ_OUTRA_EMPRESA = '11222333000262';

let server;
let appIntegrado;
let porta;
let empresa;
let outraEmpresa;
let usuarioId;
let outroUsuarioId;
let token;
let outroToken;
let desktopCaixaId;
let desktopTerminalId;
let terminalMobile;

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

async function esperarTabela(nome) {
  const limite = Date.now() + 20000;
  while (Date.now() < limite) {
    const row = await get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, [nome]);
    if (row) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('tabela ausente: ' + nome);
}

async function esperarColuna(tabela, coluna) {
  const limite = Date.now() + 20000;
  while (Date.now() < limite) {
    const colunas = await all(`PRAGMA table_info(${tabela})`);
    if (colunas.some((item) => item.name === coluna)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`coluna ausente: ${tabela}.${coluna}`);
}

function pedir(method, caminho, tokenJwt, empresaId, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const dados = body == null ? null : Buffer.from(JSON.stringify(body));
    const headers = { ...extraHeaders };
    if (tokenJwt) headers.Authorization = 'Bearer ' + tokenJwt;
    if (empresaId) headers['X-Empresa-Id'] = String(empresaId);
    if (dados) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(dados.length);
    }
    const req = http.request({
      hostname: '127.0.0.1',
      port: porta,
      path: caminho,
      method,
      headers
    }, (res) => {
      const partes = [];
      res.on('data', (parte) => partes.push(parte));
      res.on('end', () => {
        const raw = Buffer.concat(partes).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch (_err) { json = null; }
        resolve({ status: res.statusCode, body: raw, json });
      });
    });
    req.on('error', reject);
    if (dados) req.write(dados);
    req.end();
  });
}

function headersTerminal(installationId, terminalId) {
  return {
    'X-Mobile-Installation-Id': installationId,
    'X-Terminal-Id': String(terminalId)
  };
}

describe('identidade, heartbeat e caixa independente do PDV Mobile', () => {
  before(async () => {
    await db.whenReady;
    for (const nome of [
      'empresas', 'usuarios', 'terminais', 'caixas', 'caixa_sessoes',
      'caixa_movimentacoes', 'caixa_fechamentos'
    ]) await esperarTabela(nome);
    await esperarColuna('terminais', 'usuario_id');
    await esperarColuna('terminais', 'usuario_nome');
    await garantirSchemaUsuarioEmpresasAsync(db);

    empresa = await EmpresaService.criarEmpresa({
      cnpj: CNPJ_EMPRESA,
      razao_social: 'Empresa Mobile teste'
    }, { db });
    outraEmpresa = await EmpresaService.criarEmpresa({
      cnpj: CNPJ_OUTRA_EMPRESA,
      razao_social: 'Outra empresa Mobile teste'
    }, { db });

    const usuario = await run(
      `INSERT INTO usuarios (username, password_hash, role, nome, perfil, ativo)
       VALUES ('mobile-teste', 'x', 'operador', 'Operador Mobile', 'CAIXA', 1)`
    );
    usuarioId = usuario.lastID;
    const outroUsuario = await run(
      `INSERT INTO usuarios (username, password_hash, role, nome, perfil, ativo)
       VALUES ('mobile-outro', 'x', 'operador', 'Outro Operador', 'CAIXA', 1)`
    );
    outroUsuarioId = outroUsuario.lastID;
    await run(
      'INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)',
      [usuarioId, empresa.id]
    );
    await run(
      'INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)',
      [outroUsuarioId, empresa.id]
    );
    for (const permissao of ['abrir_caixa', 'fechar_caixa']) {
      await run(
        'INSERT INTO usuario_permissoes (usuario_id, permissao, permitido) VALUES (?, ?, 1)',
        [usuarioId, permissao]
      );
    }

    const segredo = getJwtSecret();
    token = jwt.sign({ id: usuarioId, username: 'mobile-teste', role: 'operador', perfil: 'CAIXA' }, segredo, { expiresIn: '1h' });
    outroToken = jwt.sign({ id: outroUsuarioId, username: 'mobile-outro', role: 'operador', perfil: 'CAIXA' }, segredo, { expiresIn: '1h' });

    const caixa = await run('INSERT INTO caixas (nome, descricao, ativo) VALUES (?, ?, 1)', [
      'Caixa Desktop teste', 'Vínculo preexistente para validar isolamento'
    ]);
    desktopCaixaId = caixa.lastID;
    const terminalDesktop = await run(
      `INSERT INTO terminais (nome, hostname, caixa_id, ativo, created_at, updated_at)
       VALUES ('Desktop teste', 'desktop-mobile09', ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [desktopCaixaId]
    );
    desktopTerminalId = terminalDesktop.lastID;

    appIntegrado = express();
    appIntegrado.use(express.json());
    appIntegrado.use('/api/terminais', verificarToken, terminaisRouter);
    appIntegrado.use('/api/caixa', verificarToken, validarTerminalMobile, caixaRouter);
    appIntegrado.post('/api/mobile-protected', verificarToken, validarTerminalMobile, (req, res) => {
      res.json({ terminal_id: req.terminalId || null });
    });
    server = http.createServer(appIntegrado);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    porta = server.address().port;
    assert.equal(/ProgramData[\\/]MercantilFiscal/i.test(String(db.dbPath)), false);
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    configService.getRecursos = recursosOriginais;
    configService.obterModoOperacionalGlobal = modoOriginal;
    await new Promise((resolve, reject) => db.close((err) => (err ? reject(err) : resolve())));
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  it('exige sessão válida e autorização da empresa para registrar', async () => {
    const semSessao = await pedir('POST', '/api/terminais/mobile/registro', null, empresa.id, {
      installation_id: INSTALLATION_ID
    });
    assert.equal(semSessao.status, 401);

    const jwtInvalido = await pedir('POST', '/api/terminais/mobile/registro', 'jwt-invalido', empresa.id, {
      installation_id: INSTALLATION_ID
    });
    assert.equal(jwtInvalido.status, 403);
    assert.equal(jwtInvalido.json.code, 'SESSAO_INVALIDA');

    const empresaNaoAutorizada = await pedir(
      'POST',
      '/api/terminais/mobile/registro',
      token,
      outraEmpresa.id,
      { installation_id: INSTALLATION_ID }
    );
    assert.equal(empresaNaoAutorizada.status, 403);
    assert.equal(empresaNaoAutorizada.json.code, 'EMPRESA_NAO_AUTORIZADA');

    const identidadeInvalida = await pedir(
      'POST',
      '/api/terminais/mobile/registro',
      token,
      empresa.id,
      { installation_id: 'web-browser' }
    );
    assert.equal(identidadeInvalida.status, 400);
    assert.equal(identidadeInvalida.json.code, 'IDENTIDADE_MOBILE_INVALIDA');
    assert.equal(await get('SELECT id FROM terminais WHERE hostname LIKE ?', ['cds-mobile-v1:%']), null);
  });

  it('registra uma instalação uma vez e retorna o mesmo terminal nas repetições', async () => {
    const caixasAntes = await get('SELECT COUNT(*) AS total FROM caixas');
    const primeira = await pedir('POST', '/api/terminais/mobile/registro', token, empresa.id, {
      installation_id: INSTALLATION_ID
    });
    assert.equal(primeira.status, 201);
    assert.equal(primeira.json.tipo, 'mobile');
    assert.equal(primeira.json.caixa_id, null);
    assert.equal(primeira.json.hostname, 'cds-mobile-v1:' + INSTALLATION_ID);
    terminalMobile = primeira.json;

    const repetida = await pedir('POST', '/api/terminais/mobile/registro', token, empresa.id, {
      installation_id: INSTALLATION_ID
    });
    assert.equal(repetida.status, 200);
    assert.equal(repetida.json.id, terminalMobile.id);
    assert.equal((await get('SELECT COUNT(*) AS total FROM caixas')).total, caixasAntes.total);

    const donoDiferente = await pedir(
      'POST',
      '/api/terminais/mobile/registro',
      outroToken,
      empresa.id,
      { installation_id: INSTALLATION_ID }
    );
    assert.equal(donoDiferente.status, 403);
    assert.equal(donoDiferente.json.code, 'TERMINAL_MOBILE_NAO_AUTORIZADO');
  });

  it('mantém registro e configuração de caixa idempotentes em chamadas concorrentes', async () => {
    const registros = await Promise.all([
      pedir('POST', '/api/terminais/mobile/registro', token, empresa.id, {
        installation_id: INSTALLATION_ID_OUTRA
      }),
      pedir('POST', '/api/terminais/mobile/registro', token, empresa.id, {
        installation_id: INSTALLATION_ID_OUTRA
      })
    ]);
    assert.deepEqual(registros.map((resposta) => resposta.status).sort(), [200, 201]);
    assert.equal(registros[0].json.id, registros[1].json.id);

    const caixasAntes = (await get('SELECT COUNT(*) AS total FROM caixas')).total;
    const configuracoes = await Promise.all([
      pedir('POST', '/api/terminais/mobile/caixa-config', token, empresa.id, {
        installation_id: INSTALLATION_ID_OUTRA,
        terminal_id: registros[0].json.id
      }),
      pedir('POST', '/api/terminais/mobile/caixa-config', token, empresa.id, {
        installation_id: INSTALLATION_ID_OUTRA,
        terminal_id: registros[0].json.id
      })
    ]);
    assert.deepEqual(
      configuracoes.map((resposta) => resposta.status).sort(),
      [200, 201],
      configuracoes.map((resposta) => resposta.body).join(' | ')
    );
    assert.equal(configuracoes[0].json.id, configuracoes[1].json.id);
    assert.equal((await get('SELECT COUNT(*) AS total FROM caixas')).total, caixasAntes + 1);
  });

  it('heartbeat autenticado atualiza somente presença, sem abrir nem trocar caixa', async () => {
    const antes = await get('SELECT caixa_id, ultima_conexao FROM terminais WHERE id = ?', [terminalMobile.id]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const resposta = await pedir('POST', '/api/terminais/mobile/heartbeat', token, empresa.id, {
      installation_id: INSTALLATION_ID,
      terminal_id: terminalMobile.id
    });
    assert.equal(resposta.status, 200);
    assert.equal(resposta.json.online, true);
    assert.ok(new Date(resposta.json.ultima_conexao).getTime() >= new Date(antes.ultima_conexao).getTime());
    const depois = await get('SELECT caixa_id FROM terminais WHERE id = ?', [terminalMobile.id]);
    assert.equal(depois.caixa_id, null);
    assert.equal(
      (await get(
        `SELECT COUNT(*) AS total FROM caixa_sessoes
         WHERE terminal_id = ? AND status = 'aberto'`,
        [terminalMobile.id]
      )).total,
      0
    );

    const lista = await pedir('GET', '/api/terminais', token, empresa.id, null);
    assert.equal(lista.status, 200);
    const listado = lista.json.find((terminal) => Number(terminal.id) === terminalMobile.id);
    assert.ok(listado);
    assert.equal(listado.online, true);

    const heartbeatDeOutroUsuario = await pedir(
      'POST',
      '/api/terminais/mobile/heartbeat',
      outroToken,
      empresa.id,
      { installation_id: INSTALLATION_ID, terminal_id: terminalMobile.id }
    );
    assert.equal(heartbeatDeOutroUsuario.status, 403);
  });

  it('cria caixa apenas na ação explícita e não reassocia o caixa desktop', async () => {
    const caixasAntes = (await get('SELECT COUNT(*) AS total FROM caixas')).total;
    await run('UPDATE terminais SET caixa_id = ? WHERE id = ?', [desktopCaixaId, terminalMobile.id]);
    const tentativaDeAssumirCaixaDesktop = await pedir(
      'POST',
      '/api/terminais/mobile/caixa-config',
      token,
      empresa.id,
      { installation_id: INSTALLATION_ID, terminal_id: terminalMobile.id }
    );
    assert.equal(tentativaDeAssumirCaixaDesktop.status, 409);
    assert.equal(tentativaDeAssumirCaixaDesktop.json.code, 'CAIXA_VINCULADO_A_OUTRO_TERMINAL');
    assert.equal(
      (await get('SELECT caixa_id FROM terminais WHERE id = ?', [desktopTerminalId])).caixa_id,
      desktopCaixaId
    );
    assert.equal((await get('SELECT COUNT(*) AS total FROM caixas')).total, caixasAntes);
    await run('UPDATE terminais SET caixa_id = NULL WHERE id = ?', [terminalMobile.id]);

    const criado = await pedir(
      'POST',
      '/api/terminais/mobile/caixa-config',
      token,
      empresa.id,
      { installation_id: INSTALLATION_ID, terminal_id: terminalMobile.id, caixa_id: desktopCaixaId }
    );
    assert.equal(criado.status, 201);
    assert.notEqual(criado.json.id, desktopCaixaId);
    assert.equal(criado.json.criado, true);

    assert.equal((await get('SELECT COUNT(*) AS total FROM caixas')).total, caixasAntes + 1);
    const desktop = await get('SELECT caixa_id FROM terminais WHERE id = ?', [desktopTerminalId]);
    const mobile = await get('SELECT caixa_id FROM terminais WHERE id = ?', [terminalMobile.id]);
    assert.equal(desktop.caixa_id, desktopCaixaId);
    assert.equal(mobile.caixa_id, criado.json.id);

    const repetido = await pedir(
      'POST',
      '/api/terminais/mobile/caixa-config',
      token,
      empresa.id,
      { installation_id: INSTALLATION_ID, terminal_id: terminalMobile.id }
    );
    assert.equal(repetido.status, 200);
    assert.equal(repetido.json.id, criado.json.id);
    assert.equal((await get('SELECT COUNT(*) AS total FROM caixas')).total, caixasAntes + 1);
  });

  it('abre, consulta e fecha somente o caixa Mobile usando o fluxo operacional existente', async () => {
    const cabecalhosDesktop = { 'X-Terminal-Id': String(desktopTerminalId) };
    const abriuDesktop = await pedir(
      'POST',
      '/api/caixa/abrir',
      token,
      empresa.id,
      { terminal_id: desktopTerminalId, valor_inicial: 0 },
      cabecalhosDesktop
    );
    assert.equal(abriuDesktop.status, 200, abriuDesktop.body);
    const sessaoDesktop = await get(
      `SELECT id, caixa_id, caixa_turno_id, terminal_id, empresa_id, status
       FROM caixa_sessoes WHERE terminal_id = ? AND status = 'aberto'`,
      [desktopTerminalId]
    );
    assert.ok(sessaoDesktop);
    assert.equal(sessaoDesktop.caixa_id, desktopCaixaId);

    const cabecalhos = headersTerminal(INSTALLATION_ID, terminalMobile.id);
    const abriu = await pedir(
      'POST',
      '/api/caixa/abrir',
      token,
      empresa.id,
      { terminal_id: terminalMobile.id, valor_inicial: 0 },
      cabecalhos
    );
    assert.equal(abriu.status, 200, abriu.body);

    const sessaoMobile = await get(
      `SELECT id, caixa_id, caixa_turno_id, terminal_id, empresa_id, status
       FROM caixa_sessoes WHERE terminal_id = ? AND status = 'aberto'`,
      [terminalMobile.id]
    );
    assert.ok(sessaoMobile);
    assert.equal(sessaoMobile.empresa_id, empresa.id);
    assert.equal(sessaoMobile.terminal_id, terminalMobile.id);
    assert.notEqual(sessaoMobile.caixa_id, desktopCaixaId);

    const aberto = await pedir('GET', '/api/caixa/aberto', token, empresa.id, null, cabecalhos);
    assert.equal(aberto.status, 200);
    assert.equal(Number(aberto.json.sessao.id), sessaoMobile.id);
    const recuperadoAposReconsulta = await pedir('GET', '/api/caixa/aberto', token, empresa.id, null, cabecalhos);
    assert.equal(recuperadoAposReconsulta.status, 200);
    assert.equal(Number(recuperadoAposReconsulta.json.sessao.id), sessaoMobile.id);

    const desktop = await get('SELECT caixa_id FROM terminais WHERE id = ?', [desktopTerminalId]);
    assert.equal(desktop.caixa_id, desktopCaixaId);
    assert.equal((await get('SELECT status FROM caixa_sessoes WHERE id = ?', [sessaoDesktop.id])).status, 'aberto');

    const sessaoAntesHeartbeat = await get(
      `SELECT caixa_id, caixa_turno_id, terminal_id, empresa_id, valor_abertura, status
       FROM caixa_sessoes WHERE id = ?`,
      [sessaoMobile.id]
    );
    const caixaMobileAntesHeartbeat = await get(
      'SELECT caixa_id FROM terminais WHERE id = ?',
      [terminalMobile.id]
    );
    const heartbeat = await pedir('POST', '/api/terminais/mobile/heartbeat', token, empresa.id, {
      installation_id: INSTALLATION_ID,
      terminal_id: terminalMobile.id
    });
    assert.equal(heartbeat.status, 200);
    const sessaoDepoisHeartbeat = await get(
      `SELECT caixa_id, caixa_turno_id, terminal_id, empresa_id, valor_abertura, status
       FROM caixa_sessoes WHERE id = ?`,
      [sessaoMobile.id]
    );
    const caixaMobileDepoisHeartbeat = await get(
      'SELECT caixa_id FROM terminais WHERE id = ?',
      [terminalMobile.id]
    );
    assert.deepEqual(sessaoDepoisHeartbeat, sessaoAntesHeartbeat);
    assert.deepEqual(caixaMobileDepoisHeartbeat, caixaMobileAntesHeartbeat);

    const fechou = await pedir(
      'POST',
      '/api/caixa/fechar',
      token,
      empresa.id,
      { terminal_id: terminalMobile.id, valor_informado: 0 },
      cabecalhos
    );
    assert.equal(fechou.status, 200, fechou.body);
    assert.equal((await get('SELECT status FROM caixa_sessoes WHERE id = ?', [sessaoMobile.id])).status, 'fechado');
    assert.equal((await get('SELECT status FROM caixa_sessoes WHERE id = ?', [sessaoDesktop.id])).status, 'aberto');
    const desktopRecuperado = await pedir('GET', '/api/caixa/aberto', token, empresa.id, null, cabecalhosDesktop);
    assert.equal(desktopRecuperado.status, 200);
    assert.equal(Number(desktopRecuperado.json.sessao.id), sessaoDesktop.id);
  });

  it('vincula operações protegidas à identidade Mobile e preserva terminais desktop', async () => {
    const identidadeCorreta = await pedir(
      'POST',
      '/api/mobile-protected',
      token,
      empresa.id,
      { terminal_id: terminalMobile.id },
      headersTerminal(INSTALLATION_ID, terminalMobile.id)
    );
    assert.equal(identidadeCorreta.status, 200);

    const identidadeDivergente = await pedir(
      'POST',
      '/api/mobile-protected',
      token,
      empresa.id,
      { terminal_id: terminalMobile.id },
      headersTerminal(INSTALLATION_ID_OUTRA, terminalMobile.id)
    );
    assert.equal(identidadeDivergente.status, 403);
    assert.equal(identidadeDivergente.json.code, 'TERMINAL_MOBILE_DIVERGENTE');

    const identidadeAusente = await pedir(
      'POST',
      '/api/mobile-protected',
      token,
      empresa.id,
      { terminal_id: terminalMobile.id },
      { 'X-Terminal-Id': String(terminalMobile.id) }
    );
    assert.equal(identidadeAusente.status, 403);
    assert.equal(identidadeAusente.json.code, 'IDENTIDADE_MOBILE_OBRIGATORIA');

    const desktop = await pedir(
      'POST',
      '/api/mobile-protected',
      token,
      empresa.id,
      { terminal_id: desktopTerminalId },
      { 'X-Terminal-Id': String(desktopTerminalId) }
    );
    assert.equal(desktop.status, 200);
    assert.equal(desktop.json.terminal_id, null);
    assert.equal((await get('SELECT caixa_id FROM terminais WHERE id = ?', [desktopTerminalId])).caixa_id, desktopCaixaId);
  });

  it('impede rotas genéricas de alterar vínculos entre Mobile e desktop', async () => {
    const caixasMobile = await get('SELECT caixa_id FROM terminais WHERE id = ?', [terminalMobile.id]);
    const alterarDesktopComIdentidadeMobile = await pedir(
      'PUT',
      '/api/terminais/' + desktopTerminalId,
      token,
      empresa.id,
      { nome: 'Desktop alterado', caixa_id: caixasMobile.caixa_id },
      headersTerminal(INSTALLATION_ID, terminalMobile.id)
    );
    assert.equal(alterarDesktopComIdentidadeMobile.status, 403);
    assert.equal(alterarDesktopComIdentidadeMobile.json.code, 'TERMINAL_MOBILE_OPERACAO_NAO_PERMITIDA');

    const alterarMobilePeloCadastroGenerico = await pedir(
      'PUT',
      '/api/terminais/' + terminalMobile.id,
      token,
      empresa.id,
      { nome: 'Mobile alterado', caixa_id: desktopCaixaId }
    );
    assert.equal(alterarMobilePeloCadastroGenerico.status, 403);
    assert.equal(alterarMobilePeloCadastroGenerico.json.code, 'TERMINAL_MOBILE_GERENCIADO_PELO_FLUXO_PROPRIO');

    const desktopAssumirCaixaMobile = await pedir(
      'PUT',
      '/api/terminais/' + desktopTerminalId,
      token,
      empresa.id,
      { nome: 'Desktop teste', caixa_id: caixasMobile.caixa_id }
    );
    assert.equal(desktopAssumirCaixaMobile.status, 409);
    assert.equal(desktopAssumirCaixaMobile.json.code, 'CAIXA_VINCULADO_A_OUTRO_TERMINAL');

    const desktop = await get('SELECT caixa_id FROM terminais WHERE id = ?', [desktopTerminalId]);
    const mobile = await get('SELECT caixa_id FROM terminais WHERE id = ?', [terminalMobile.id]);
    assert.equal(desktop.caixa_id, desktopCaixaId);
    assert.equal(mobile.caixa_id, caixasMobile.caixa_id);
  });

  it('recupera o heartbeat quando a conectividade do servidor retorna', async () => {
    const terminalHeaders = headersTerminal(INSTALLATION_ID, terminalMobile.id);
    await new Promise((resolve) => server.close(resolve));
    server = null;
    await assert.rejects(
      pedir('POST', '/api/terminais/mobile/heartbeat', token, empresa.id, {
        installation_id: INSTALLATION_ID,
        terminal_id: terminalMobile.id
      }),
      (err) => ['ECONNREFUSED', 'ECONNRESET'].includes(err.code)
    );

    server = http.createServer(appIntegrado);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    porta = server.address().port;

    const recuperado = await pedir(
      'POST',
      '/api/terminais/mobile/heartbeat',
      token,
      empresa.id,
      { installation_id: INSTALLATION_ID, terminal_id: terminalMobile.id },
      terminalHeaders
    );
    assert.equal(recuperado.status, 200);
    assert.equal(recuperado.json.online, true);
  });
});
