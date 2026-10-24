'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const jwt = require('jsonwebtoken');

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-volume-http-'));
process.env.DB_DIR = dbDir;
process.env.JWT_SECRET = 'test-only-volume-http-secret';

const db = require('../../backend/database');
const router = require('../../backend/rotas/produtos');
const { verificarToken } = require('../../backend/middleware/auth');
const MibService = require('../../backend/motores/mib/MibService');

const sincronizarNomeBuscaOriginal = MibService.prototype.sincronizarNomeBusca;
const notificarProdutoCriadoOriginal = MibService.prototype.notificarProdutoCriado;
MibService.prototype.sincronizarNomeBusca = (_id, _nome, callback) => {
  if (typeof callback === 'function') callback(null);
};
MibService.prototype.notificarProdutoCriado = () => {};

function whenReady(database) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Banco isolado não ficou pronto a tempo.')), 30000);
    database.whenReady((err) => {
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    });
  });
}

function closeDb(database) {
  return new Promise((resolve, reject) => {
    database.close((err) => (err ? reject(err) : resolve()));
  });
}

async function main() {
  let server;
  try {
    await whenReady(db);
    const app = express();
    app.use(express.json());
    app.use('/api/produtos', verificarToken, router);
    server = await new Promise((resolve, reject) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
      instance.once('error', reject);
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}/api/produtos/unidades-volume`;
    const adminToken = jwt.sign({ id: 1, role: 'admin', perfil: 'SUPER_ADMIN' }, process.env.JWT_SECRET);
    const operadorToken = jwt.sign({ id: 999999, role: 'operador', perfil: 'USUARIO' }, process.env.JWT_SECRET);
    const headersFor = (token) => ({
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    });

    const semToken = await fetch(baseUrl);
    assert.equal(semToken.status, 401, 'GET sem autenticação deve ser bloqueado');
    const postSemToken = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nome: 'Sem autenticação', sigla: 'SA' })
    });
    assert.equal(postSemToken.status, 401, 'POST sem autenticação deve ser bloqueado');
    const operadorPost = await fetch(baseUrl, {
      method: 'POST',
      headers: headersFor(operadorToken),
      body: JSON.stringify({ nome: 'Sem permissão', sigla: 'SP' })
    });
    assert.equal(operadorPost.status, 403, 'usuário autenticado sem permissão de produtos não cadastra unidade');
    const operadorGet = await fetch(baseUrl, { headers: headersFor(operadorToken) });
    assert.equal(operadorGet.status, 403, 'usuário autenticado sem permissão de produtos não lista unidades');

    const listaResponse = await fetch(baseUrl, { headers: headersFor(adminToken) });
    assert.equal(listaResponse.status, 200);
    const lista = await listaResponse.json();
    assert.ok(lista.some((item) => item.sigla === 'ML'));
    assert.ok(lista.some((item) => item.sigla === 'L'));
    assert.ok(lista.every((item) => item.ativo === 1));

    const ausente = await fetch(baseUrl, {
      method: 'POST',
      headers: headersFor(adminToken),
      body: JSON.stringify({ nome: '', sigla: 'AB' })
    });
    assert.equal(ausente.status, 400);
    assert.equal((await ausente.json()).code, 'NOME_UNIDADE_OBRIGATORIO');
    const siglaAusente = await fetch(baseUrl, {
      method: 'POST',
      headers: headersFor(adminToken),
      body: JSON.stringify({ nome: 'Sem sigla', sigla: '' })
    });
    assert.equal(siglaAusente.status, 400);
    assert.equal((await siglaAusente.json()).code, 'SIGLA_UNIDADE_OBRIGATORIA');

    const duplicidadeConcorrente = await Promise.all([
      fetch(baseUrl, {
        method: 'POST',
        headers: headersFor(adminToken),
        body: JSON.stringify({ nome: 'Garrafa HTTP', sigla: 'GH' })
      }),
      fetch(baseUrl, {
        method: 'POST',
        headers: headersFor(adminToken),
        body: JSON.stringify({ nome: 'Garrafa repetida HTTP', sigla: ' g h ' })
      })
    ]);
    assert.deepEqual(duplicidadeConcorrente.map((response) => response.status).sort(), [201, 409]);
    const unidadeCriada = duplicidadeConcorrente.find((response) => response.status === 201);
    const unidade = await unidadeCriada.json();
    assert.equal(unidade.sigla, 'GH');

    const produtoResponse = await fetch(`${baseUrl.replace('/unidades-volume', '')}`, {
      method: 'POST',
      headers: headersFor(adminToken),
      body: JSON.stringify({
        codigo: `TEST-VOL-${Date.now()}`,
        nome: 'Produto teste volume HTTP',
        unidade: 'UN',
        preco_compra: 0,
        lucro_percentual: 0,
        preco_venda: 1,
        tipo_operacional: 'COMERCIAL',
        utiliza_volume: 1,
        volume_valor: 350,
        volume_unidade: unidade.sigla,
        volume_unidade_id: unidade.id
      })
    });
    assert.equal(produtoResponse.status, 200, await produtoResponse.clone().text());
    const produtoCriado = await produtoResponse.json();
    assert.equal(produtoCriado.volume_unidade, unidade.sigla);
    assert.equal(produtoCriado.volume_unidade_id, unidade.id);
    assert.equal(produtoCriado.volume_unidade_nome, unidade.nome);

    const produtoBase = `${baseUrl.replace('/unidades-volume', '')}/${produtoCriado.id}`;
    const leituraResponse = await fetch(produtoBase, { headers: headersFor(adminToken) });
    assert.equal(leituraResponse.status, 200);
    const produtoLido = await leituraResponse.json();
    assert.equal(produtoLido.volume_unidade, unidade.sigla);
    assert.equal(produtoLido.volume_unidade_id, unidade.id);
    assert.equal(produtoLido.volume_unidade_nome, unidade.nome);

    await new Promise((resolve, reject) => {
      db.run('UPDATE unidades_volume_comercial SET ativo = 0 WHERE id = ?', [unidade.id], (err) => (
        err ? reject(err) : resolve()
      ));
    });
    const edicaoParcialResponse = await fetch(produtoBase, {
      method: 'PUT',
      headers: headersFor(adminToken),
      body: JSON.stringify({ nome: 'Produto teste volume HTTP editado' })
    });
    assert.equal(edicaoParcialResponse.status, 200, await edicaoParcialResponse.clone().text());
    const edicaoParcial = await edicaoParcialResponse.json();
    assert.equal(edicaoParcial.volume_unidade, unidade.sigla);
    assert.equal(edicaoParcial.volume_unidade_id, unidade.id);

    const unidadeAlternativaResponse = await fetch(baseUrl, {
      method: 'POST',
      headers: headersFor(adminToken),
      body: JSON.stringify({ nome: 'Copo HTTP', sigla: 'CPH' })
    });
    assert.equal(unidadeAlternativaResponse.status, 201);
    const unidadeAlternativa = await unidadeAlternativaResponse.json();
    const trocaUnidadeResponse = await fetch(produtoBase, {
      method: 'PUT',
      headers: headersFor(adminToken),
      body: JSON.stringify({
        utiliza_volume: 1,
        volume_valor: 1,
        volume_unidade: unidadeAlternativa.sigla,
        volume_unidade_id: unidadeAlternativa.id
      })
    });
    assert.equal(trocaUnidadeResponse.status, 200, await trocaUnidadeResponse.clone().text());
    const produtoComUnidadeAlternativa = await trocaUnidadeResponse.json();
    assert.equal(produtoComUnidadeAlternativa.volume_unidade, unidadeAlternativa.sigla);
    assert.equal(produtoComUnidadeAlternativa.volume_unidade_id, unidadeAlternativa.id);

    const novaAssociacaoInativa = await fetch(produtoBase, {
      method: 'PUT',
      headers: headersFor(adminToken),
      body: JSON.stringify({
        utiliza_volume: 1,
        volume_valor: 1,
        volume_unidade: unidade.sigla,
        volume_unidade_id: unidade.id
      })
    });
    assert.equal(novaAssociacaoInativa.status, 400);
    assert.equal((await novaAssociacaoInativa.json()).code, 'UNIDADE_VOLUME_INATIVA');

    await new Promise((resolve, reject) => {
      db.run('UPDATE unidades_volume_comercial SET ativo = 0 WHERE id = ?', [unidadeAlternativa.id], (err) => (
        err ? reject(err) : resolve()
      ));
    });
    const edicaoHistoricaResponse = await fetch(produtoBase, {
      method: 'PUT',
      headers: headersFor(adminToken),
      body: JSON.stringify({ nome: 'Produto teste após inativar unidade atual' })
    });
    assert.equal(edicaoHistoricaResponse.status, 200);
    const edicaoHistorica = await edicaoHistoricaResponse.json();
    assert.equal(edicaoHistorica.volume_unidade, unidadeAlternativa.sigla);
    assert.equal(edicaoHistorica.volume_unidade_id, unidadeAlternativa.id);

    const desativarVolumeResponse = await fetch(produtoBase, {
      method: 'PUT',
      headers: headersFor(adminToken),
      body: JSON.stringify({ utiliza_volume: 0 })
    });
    assert.equal(desativarVolumeResponse.status, 200);
    const produtoVolumeDesativado = await desativarVolumeResponse.json();
    assert.equal(produtoVolumeDesativado.utiliza_volume, 0);
    assert.equal(produtoVolumeDesativado.volume_unidade_id, null);

    const listaAtualizadaResponse = await fetch(baseUrl, { headers: headersFor(adminToken) });
    const listaAtualizada = await listaAtualizadaResponse.json();
    assert.equal(listaAtualizada.some((item) => item.id === unidade.id), false);
    assert.equal(listaAtualizada.some((item) => item.id === unidadeAlternativa.id), false);
    console.log('unidades-volume-comercial-http: auth, permissão, concorrência e contrato de produto passaram');
  } finally {
    if (server) {
      await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
    MibService.prototype.sincronizarNomeBusca = sincronizarNomeBuscaOriginal;
    MibService.prototype.notificarProdutoCriado = notificarProdutoCriadoOriginal;
    await closeDb(db);
    for (const entry of fs.readdirSync(dbDir)) {
      const target = path.join(dbDir, entry);
      fs.rmSync(target, { recursive: true, force: true });
    }
    fs.rmdirSync(dbDir);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
