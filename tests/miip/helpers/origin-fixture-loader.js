'use strict';

/*
 * Carregador estrito de fixtures JSON sintéticas para o harness isolado MIIP.
 *
 * - Só lê arquivos declarados explicitamente pelo teste, dentro de FIXTURE_DIR.
 * - Valida estrutura, tipos e marcadores de dado sintético ANTES de qualquer INSERT.
 * - Nunca executa SQL vindo do JSON: o SQL é fixo neste módulo e o JSON só fornece parâmetros.
 * - Nunca faz require/import de caminhos vindos do JSON.
 *
 * Os nomes de campos reproduzem os contratos reais (colunas de `produtos`, `miip_associacoes`,
 * `central_entradas_documentos` e o resultado MIIP consumido por CentralProcessamentoService).
 */

const fs = require('node:fs');
const path = require('node:path');

const FIXTURE_DIR = path.resolve(__dirname, '..', 'fixtures', 'origin-diagnostics');
const MAX_BYTES = 64 * 1024;
const SCHEMA = 'cds.miip.origin-fixture.v1';

const RE = {
  arquivoFixture: /^[a-z0-9]+(?:-[a-z0-9]+)*\.json$/,
  arquivoBanco: /\.(db|sqlite3?|db-wal|db-shm)\b/i,
  sql: /\b(select\s.+\sfrom|insert\s+into|update\s+\w+\s+set|delete\s+from|drop\s+table|attach\s+database|pragma\s)/i,
  gtin: /^7890000\d{6}$/,
  codigo: /^SINT-[A-Z0-9-]+$/,
  codigoFornecedor: /^CPROD-SINT-[A-Z0-9-]+$/,
  cnpj: /^9999\d{10}$/,
  chave: /^9999\d{40}$/,
  operacao: /^op-fixture-[a-z0-9-]+$/,
  ncm: /^\d{8}$/,
  marcaNome: /sintetic|ficticio/i
};

const PERSISTENCIAS = ['persistencia_simulada', 'persistencia_sql_memoria'];
const NOMES_PROIBIDOS = /(cpf|razao|email|telefone|endereco|xml|senha|token|caminho|arquivo|path|sql|require)/i;

const COLUNAS_PRODUTO = {
  id: 'int', codigo: 'codigo', codigo_barras: 'gtin', nome: 'nome', unidade: 'string',
  ncm: 'ncm', cest: 'string', ativo: 'bool01'
};
const COLUNAS_ATUALIZAVEIS = ['codigo', 'codigo_barras', 'nome', 'ncm'];
const COLUNAS_ASSOCIACAO = {
  id: 'int', produto_id: 'int', origem: 'string', fornecedor_cnpj: 'cnpj',
  fornecedor_nome: 'nome', codigo_fornecedor: 'codigoFornecedor', nome_item: 'nome', status: 'string'
};
const CAMPOS_ITEM = {
  produtoNome: 'nome', codigoBarras: 'gtin', codigoFornecedor: 'codigoFornecedor',
  fornecedorCnpj: 'cnpj', ncm: 'ncm', unidade: 'string'
};
const CAMPOS_DOCUMENTO = {
  id: 'int', chave: 'chave', status: 'status', empresaId: 'int', miipSessaoId: 'operacao'
};
const CAMPOS_ESPERADO = {
  origemResultado: 'string', fontes: 'stringArray', produtoId: 'int',
  gtinDivergente: 'bool', cacheHitEsperado: 'bool', estadoSnapshot: 'string'
};
const TOPO = [
  'schema', 'id', 'cenario', 'descricao', 'sintetico', 'persistencia', 'catalogo',
  'associacoes', 'item', 'documento', 'resultadoPersistido', 'catalogoAtualizado', 'esperado'
];

class FixtureInvalidaError extends Error {
  constructor(arquivo, mensagem) {
    super(`Fixture inválida (${arquivo}): ${mensagem}`);
    this.name = 'FixtureInvalidaError';
  }
}

function exigir(condicao, arquivo, mensagem) {
  if (!condicao) throw new FixtureInvalidaError(arquivo, mensagem);
}

function objetoPlano(valor) {
  return valor !== null && typeof valor === 'object' && !Array.isArray(valor);
}

function validarValor(arquivo, rotulo, tipo, valor) {
  const ok = (cond, msg) => exigir(cond, arquivo, `${rotulo}: ${msg}`);
  switch (tipo) {
    case 'int': return ok(Number.isInteger(valor) && valor > 0 && valor < 1000000, 'inteiro positivo esperado');
    case 'bool': return ok(typeof valor === 'boolean', 'booleano esperado');
    case 'bool01': return ok(valor === 0 || valor === 1, '0 ou 1 esperado');
    case 'string': return ok(typeof valor === 'string' && valor.length > 0 && valor.length <= 120, 'texto curto esperado');
    case 'stringArray': return ok(Array.isArray(valor) && valor.every((v) => typeof v === 'string'), 'lista de textos esperada');
    case 'gtin': return ok(typeof valor === 'string' && RE.gtin.test(valor), 'GTIN sintético (7890000xxxxxx) esperado');
    case 'codigo': return ok(typeof valor === 'string' && RE.codigo.test(valor), 'código interno SINT-* esperado');
    case 'codigoFornecedor': return ok(typeof valor === 'string' && RE.codigoFornecedor.test(valor), 'código de fornecedor CPROD-SINT-* esperado');
    case 'cnpj': return ok(typeof valor === 'string' && RE.cnpj.test(valor), 'CNPJ sintético (9999xxxxxxxxxx) esperado');
    case 'chave': return ok(typeof valor === 'string' && RE.chave.test(valor), 'chave sintética (9999 + 40 dígitos) esperada');
    case 'operacao': return ok(typeof valor === 'string' && RE.operacao.test(valor), 'operacaoId op-fixture-* esperado');
    case 'ncm': return ok(typeof valor === 'string' && RE.ncm.test(valor), 'NCM de 8 dígitos esperado');
    case 'status': return ok(typeof valor === 'string' && /^[A-Z_]+$/.test(valor), 'status canônico esperado');
    case 'nome': return ok(typeof valor === 'string' && RE.marcaNome.test(valor) && valor.length <= 120,
      'nome deve conter "Sintetic" ou "Ficticio"');
    default: throw new FixtureInvalidaError(arquivo, `${rotulo}: tipo interno desconhecido ${tipo}`);
  }
}

function validarObjeto(arquivo, rotulo, objeto, mapa, { obrigatorios = [] } = {}) {
  exigir(objetoPlano(objeto), arquivo, `${rotulo}: objeto esperado`);
  Object.keys(objeto).forEach((chave) => {
    exigir(Object.prototype.hasOwnProperty.call(mapa, chave), arquivo, `${rotulo}: campo não permitido "${chave}"`);
    validarValor(arquivo, `${rotulo}.${chave}`, mapa[chave], objeto[chave]);
  });
  obrigatorios.forEach((chave) => {
    exigir(objeto[chave] !== undefined, arquivo, `${rotulo}: campo obrigatório ausente "${chave}"`);
  });
}

function percorrerTextos(valor, visitar, rota = '$') {
  if (typeof valor === 'string') return visitar(valor, rota, false);
  if (Array.isArray(valor)) return valor.forEach((v, i) => percorrerTextos(v, visitar, `${rota}[${i}]`));
  if (objetoPlano(valor)) {
    return Object.entries(valor).forEach(([k, v]) => {
      visitar(k, `${rota}.${k}`, true);
      percorrerTextos(v, visitar, `${rota}.${k}`);
    });
  }
  return undefined;
}

// O resultado persistido segue o contrato real do resultado MIIP; só tipos e conteúdo textual são restringidos.
function validarResultadoPersistido(arquivo, resultado) {
  exigir(objetoPlano(resultado), arquivo, 'resultadoPersistido: objeto esperado');
  validarValor(arquivo, 'resultadoPersistido.operacaoId', 'operacao', resultado.operacaoId);
  exigir(Array.isArray(resultado.resultados) && resultado.resultados.length > 0, arquivo,
    'resultadoPersistido.resultados: lista não vazia esperada');
  resultado.resultados.forEach((item, i) => {
    exigir(objetoPlano(item), arquivo, `resultados[${i}]: objeto esperado`);
    if (item.operacaoId !== undefined) validarValor(arquivo, `resultados[${i}].operacaoId`, 'operacao', item.operacaoId);
    if (item.score !== undefined) {
      exigir(typeof item.score === 'number' && item.score >= 0 && item.score <= 100, arquivo,
        `resultados[${i}].score: número entre 0 e 100 esperado`);
    }
    const produtos = [item.produtoEncontrado, item.candidatoSelecionado?.produto].filter(Boolean);
    produtos.forEach((produto) => {
      exigir(Number.isInteger(produto.id) && produto.id > 0, arquivo, `resultados[${i}]: produto.id inteiro esperado`);
      if (produto.codigo !== undefined) validarValor(arquivo, `resultados[${i}].produto.codigo`, 'codigo', produto.codigo);
      if (produto.codigoBarras !== undefined && produto.codigoBarras !== null) {
        validarValor(arquivo, `resultados[${i}].produto.codigoBarras`, 'gtin', produto.codigoBarras);
      }
      if (produto.nome !== undefined) validarValor(arquivo, `resultados[${i}].produto.nome`, 'nome', produto.nome);
    });
  });
}

function validarFixture(arquivo, fixture) {
  exigir(objetoPlano(fixture), arquivo, 'raiz deve ser um objeto');
  Object.keys(fixture).forEach((chave) => {
    exigir(TOPO.includes(chave), arquivo, `campo de topo não permitido "${chave}"`);
  });
  exigir(fixture.schema === SCHEMA, arquivo, `schema deve ser "${SCHEMA}"`);
  exigir(fixture.sintetico === true, arquivo, 'sintetico deve ser true');
  exigir(typeof fixture.id === 'string' && /^[a-z0-9-]+$/.test(fixture.id), arquivo, 'id inválido');
  exigir(typeof fixture.cenario === 'string' && /^[A-F]$/.test(fixture.cenario), arquivo, 'cenario deve ser A..F');
  exigir(typeof fixture.descricao === 'string' && fixture.descricao.length <= 240, arquivo, 'descricao inválida');
  exigir(fixture.persistencia === undefined || PERSISTENCIAS.includes(fixture.persistencia), arquivo,
    `persistencia deve ser uma de ${PERSISTENCIAS.join(', ')}`);

  percorrerTextos(fixture, (texto, rota, ehChave) => {
    exigir(!RE.arquivoBanco.test(texto), arquivo, `${rota}: referência a arquivo SQLite rejeitada`);
    exigir(!/[\\/]|\.\./.test(texto), arquivo, `${rota}: caminho rejeitado`);
    exigir(!RE.sql.test(texto), arquivo, `${rota}: comando SQL rejeitado`);
    exigir(!/[<>]/.test(texto), arquivo, `${rota}: marcação/XML rejeitado`);
    exigir(!ehChave || !NOMES_PROIBIDOS.test(texto), arquivo, `${rota}: nome de campo fiscal/pessoal rejeitado`);
  });

  if (fixture.catalogo !== undefined) {
    exigir(Array.isArray(fixture.catalogo) && fixture.catalogo.length > 0, arquivo, 'catalogo: lista não vazia esperada');
    fixture.catalogo.forEach((p, i) => validarObjeto(arquivo, `catalogo[${i}]`, p, COLUNAS_PRODUTO,
      { obrigatorios: ['id', 'codigo', 'codigo_barras', 'nome', 'ncm'] }));
  }
  if (fixture.associacoes !== undefined) {
    exigir(Array.isArray(fixture.associacoes), arquivo, 'associacoes: lista esperada');
    fixture.associacoes.forEach((a, i) => validarObjeto(arquivo, `associacoes[${i}]`, a, COLUNAS_ASSOCIACAO,
      { obrigatorios: ['id', 'produto_id', 'fornecedor_cnpj', 'codigo_fornecedor', 'status'] }));
  }
  if (fixture.item !== undefined) validarObjeto(arquivo, 'item', fixture.item, CAMPOS_ITEM);
  if (fixture.documento !== undefined) {
    validarObjeto(arquivo, 'documento', fixture.documento, CAMPOS_DOCUMENTO,
      { obrigatorios: ['id', 'chave', 'status', 'empresaId'] });
  }
  if (fixture.resultadoPersistido !== undefined) validarResultadoPersistido(arquivo, fixture.resultadoPersistido);
  if (fixture.catalogoAtualizado !== undefined) {
    exigir(Array.isArray(fixture.catalogoAtualizado), arquivo, 'catalogoAtualizado: lista esperada');
    fixture.catalogoAtualizado.forEach((p, i) => {
      validarObjeto(arquivo, `catalogoAtualizado[${i}]`, p, COLUNAS_PRODUTO, { obrigatorios: ['id'] });
      Object.keys(p).filter((c) => c !== 'id').forEach((c) => {
        exigir(COLUNAS_ATUALIZAVEIS.includes(c), arquivo, `catalogoAtualizado[${i}]: coluna não atualizável "${c}"`);
      });
    });
  }
  if (fixture.esperado !== undefined) validarObjeto(arquivo, 'esperado', fixture.esperado, CAMPOS_ESPERADO);
  if (fixture.persistencia !== undefined) {
    exigir(fixture.documento && fixture.resultadoPersistido, arquivo,
      'persistencia exige documento e resultadoPersistido');
  }
  return fixture;
}

function criarCarregador({ declaradas, dir = FIXTURE_DIR } = {}) {
  exigir(Array.isArray(declaradas) && declaradas.length > 0, '(carregador)', 'lista de fixtures declaradas obrigatória');
  declaradas.forEach((nome) => {
    exigir(RE.arquivoFixture.test(nome) && path.basename(nome) === nome, nome, 'nome de arquivo inválido');
  });
  const permitidas = new Set(declaradas);

  return {
    declaradas: [...declaradas],
    carregar(nome) {
      exigir(permitidas.has(nome), String(nome), 'fixture não declarada no teste');
      const arquivo = path.join(dir, nome);
      exigir(path.dirname(arquivo) === dir, nome, 'caminho fora da pasta exclusiva');
      const stat = fs.statSync(arquivo);
      exigir(stat.isFile() && stat.size <= MAX_BYTES, nome, 'arquivo inválido ou grande demais');
      let bruto;
      try {
        bruto = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
      } catch (error) {
        throw new FixtureInvalidaError(nome, `JSON inválido: ${error.message}`);
      }
      return Object.freeze(validarFixture(nome, bruto));
    },
    naoDeclaradasNoDiretorio() {
      return fs.readdirSync(dir).filter((nome) => !permitidas.has(nome));
    }
  };
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(error) {
      if (error) return reject(error);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

// Schemas mínimos: colunas lidas pelos componentes exercitados (ver relatório). Não são migrações reais.
const DDL = {
  produtos: `CREATE TABLE produtos (
    id INTEGER PRIMARY KEY, codigo TEXT, codigo_barras TEXT, nome TEXT, unidade TEXT,
    ncm TEXT, cest TEXT, categoria_id INTEGER, subcategoria_id INTEGER, fornecedor TEXT,
    preco_venda REAL, ativo INTEGER, marca_id INTEGER
  )`,
  marcas: 'CREATE TABLE marcas (id INTEGER PRIMARY KEY, nome TEXT)',
  miip_associacoes: `CREATE TABLE miip_associacoes (
    id INTEGER PRIMARY KEY, produto_id INTEGER, origem TEXT, fornecedor_cnpj TEXT,
    fornecedor_nome TEXT, codigo_fornecedor TEXT, codigo_barras TEXT, nome_item TEXT,
    nome_normalizado TEXT, ncm TEXT, unidade TEXT, score INTEGER, confianca TEXT,
    status TEXT, fonte TEXT, decisao_operacao_id TEXT, confirmado_por_usuario_id INTEGER,
    metadados TEXT, last_used_at TEXT, created_at TEXT, updated_at TEXT
  )`,
  compras: `CREATE TABLE compras (
    id INTEGER PRIMARY KEY, tipo_entrada TEXT, tipo_entrada_sugerido TEXT,
    tipo_entrada_confianca REAL, tipo_entrada_motivo TEXT, tipo_entrada_alterado INTEGER
  )`,
  central_entradas_documentos: `CREATE TABLE central_entradas_documentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT, chave TEXT NOT NULL, numero TEXT, serie TEXT,
    modelo TEXT DEFAULT '55', fornecedor TEXT, cnpj_fornecedor TEXT, data_emissao TEXT,
    data_entrada TEXT, valor_total REAL, xml TEXT NOT NULL, nsu TEXT,
    origem TEXT NOT NULL DEFAULT 'dfe', status TEXT NOT NULL DEFAULT 'RECEBIDA',
    status_detalhe TEXT, tipo_documento TEXT, parse_json TEXT, miip_sessao_id TEXT,
    miip_resumo_json TEXT, compra_id INTEGER, usuario_id INTEGER, processado_em DATETIME,
    empresa_id INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(chave, empresa_id)
  )`
};

async function criarSchema(db, tabelas) {
  for (const tabela of tabelas) {
    exigir(Object.prototype.hasOwnProperty.call(DDL, tabela), '(schema)', `tabela desconhecida ${tabela}`);
    await run(db, DDL[tabela]);
  }
}

async function inserirCatalogo(db, fixture) {
  for (const p of fixture.catalogo || []) {
    await run(db,
      'INSERT INTO produtos (id,codigo,codigo_barras,nome,unidade,ncm,cest,ativo) VALUES (?,?,?,?,?,?,?,?)',
      [p.id, p.codigo, p.codigo_barras, p.nome, p.unidade ?? 'UN', p.ncm, p.cest ?? null, p.ativo ?? 1]);
  }
}

async function inserirAssociacoes(db, fixture) {
  for (const a of fixture.associacoes || []) {
    await run(db,
      `INSERT INTO miip_associacoes
        (id,produto_id,origem,fornecedor_cnpj,fornecedor_nome,codigo_fornecedor,nome_item,status)
       VALUES (?,?,?,?,?,?,?,?)`,
      [a.id, a.produto_id, a.origem ?? 'manual', a.fornecedor_cnpj, a.fornecedor_nome ?? null,
        a.codigo_fornecedor, a.nome_item ?? null, a.status]);
  }
}

async function aplicarAtualizacaoCatalogo(db, fixture) {
  for (const p of fixture.catalogoAtualizado || []) {
    const colunas = COLUNAS_ATUALIZAVEIS.filter((c) => p[c] !== undefined);
    if (colunas.length === 0) continue;
    await run(db,
      `UPDATE produtos SET ${colunas.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
      [...colunas.map((c) => p[c]), p.id]);
  }
}

async function inserirDocumentoPersistido(db, fixture) {
  const d = fixture.documento;
  await run(db,
    `INSERT INTO central_entradas_documentos
      (id,chave,xml,origem,status,parse_json,miip_sessao_id,miip_resumo_json,empresa_id)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [d.id, d.chave, 'XML_SINTETICO_OMITIDO', 'fixture', d.status,
      JSON.stringify({ miip_importacao: fixture.resultadoPersistido }),
      d.miipSessaoId ?? fixture.resultadoPersistido.operacaoId,
      JSON.stringify(fixture.resultadoPersistido), d.empresaId]);
}

module.exports = {
  FIXTURE_DIR,
  SCHEMA,
  FixtureInvalidaError,
  criarCarregador,
  validarFixture,
  criarSchema,
  inserirCatalogo,
  inserirAssociacoes,
  aplicarAtualizacaoCatalogo,
  inserirDocumentoPersistido
};
