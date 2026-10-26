const express = require('express');
const router = express.Router();
const db = require('../database');
const moment = require('moment');
const { gravarAuditoria } = require('../services/auditoria');
const { validarCaixaAberto } = require('../middleware/validarCaixaAberto');
const { FILTRO_VENDA_VALIDA, isModoFiscalRelatorio } = require('../services/reportFiscalHelpers');
const {
  sqlExcluirContaVendaCancelada,
  sqlExcluirFinanceiroVendaCancelada,
  sqlExcluirFinanceiroReceberComContaCanonica
} = require('../services/vendas/VendaFinanceiroService');
const {
  middlewareResolverEmpresaFinanceiro,
  exigirRegistroDaEmpresa,
  exigirLancamentoDaEmpresa,
  resolverEmpresaDaOrigemFinanceira,
  obterMetaEmpresaPorId,
  statusDeErroEmpresa
} = require('../services/financeiro/FinanceiroEmpresaContextoService');
const ContasPagarService = require('../motores/mcf/services/ContasPagarService');
const UsuarioEmpresaService = require('../services/empresas/UsuarioEmpresaService');
const {
  ehProjecaoMcfRow,
  buscarVinculoPorFinanceiroId,
  erroProjecaoImutavel,
  sqlExcluirProjecaoMcf
} = require('../motores/mcf/services/ContasPagarFinanceiroCompatGuard');

const anexarEmpresaFinanceiro = middlewareResolverEmpresaFinanceiro({ db });

async function obterEmpresasAutorizadasFinanceiro(req, res) {
  if (!req.user || !req.user.id) {
    res.status(401).json({
      success: false,
      error: 'Autenticação obrigatória para consultar o Financeiro.',
      code: 'USUARIO_OBRIGATORIO'
    });
    return null;
  }

  const empresas = await UsuarioEmpresaService.listarEmpresasPermitidas(req.user, { db });
  const ids = empresas.map((empresa) => Number(empresa.id));
  if (ids.length === 0) {
    res.status(403).json({
      success: false,
      error: 'Usuário não possui empresas autorizadas para consultar o Financeiro.',
      code: 'EMPRESA_NAO_AUTORIZADA'
    });
    return null;
  }
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0) || new Set(ids).size !== ids.length) {
    throw new Error('A lista de empresas autorizadas possui identificadores inválidos ou duplicados.');
  }
  return empresas;
}

function metadadosEmpresaFinanceiro(empresa) {
  const empresaId = Number(empresa.id);
  return {
    empresa_id: empresaId,
    empresa_nome: empresa.nome_fantasia || empresa.razao_social || `Empresa #${empresaId}`,
    empresa_cnpj: empresa.cnpj || null
  };
}

router.get('/dashboard/multiempresa', async (req, res) => {
  if (!req.user || !req.user.id) {
    return res.status(401).json({
      success: false,
      error: 'Autenticação obrigatória para consultar o dashboard financeiro.',
      code: 'USUARIO_OBRIGATORIO'
    });
  }

  try {
    const empresasAutorizadas = await UsuarioEmpresaService.listarEmpresasPermitidas(req.user, { db });
    if (empresasAutorizadas.length === 0) {
      return res.status(403).json({
        success: false,
        error: 'Usuário não possui empresas autorizadas para consultar o dashboard.',
        code: 'EMPRESA_NAO_AUTORIZADA'
      });
    }

    let empresasConsultadas = empresasAutorizadas;
    const empresaSolicitada = req.query.empresaId;
    if (empresaSolicitada != null && String(empresaSolicitada) !== 'todas') {
      const empresaId = Number(empresaSolicitada);
      if (!Number.isSafeInteger(empresaId) || empresaId <= 0) {
        return res.status(400).json({
          success: false,
          error: 'empresaId inválido.',
          code: 'EMPRESA_ID_INVALIDO'
        });
      }
      empresasConsultadas = empresasAutorizadas.filter((empresa) => Number(empresa.id) === empresaId);
      if (empresasConsultadas.length === 0) {
        return res.status(403).json({
          success: false,
          error: 'Usuário não está autorizado a consultar esta empresa.',
          code: 'EMPRESA_NAO_AUTORIZADA',
          empresa_id: empresaId
        });
      }
    }

    const inicioInformado = req.query.dataInicio;
    const fimInformado = req.query.dataFim;
    if ((inicioInformado == null) !== (fimInformado == null)) {
      return res.status(400).json({
        success: false,
        error: 'Informe dataInicio e dataFim juntos.',
        code: 'PERIODO_INVALIDO'
      });
    }

    const dataFim = fimInformado == null ? moment().format('YYYY-MM-DD') : String(fimInformado);
    const dataInicio = inicioInformado == null
      ? moment().startOf('month').format('YYYY-MM-DD')
      : String(inicioInformado);
    const dataValida = (valor) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(valor)) return false;
      return moment(valor, 'YYYY-MM-DD', true).isValid();
    };
    if (!dataValida(dataInicio) || !dataValida(dataFim) || dataInicio > dataFim) {
      return res.status(400).json({
        success: false,
        error: 'Período inválido.',
        code: 'PERIODO_INVALIDO'
      });
    }

    const empresaIds = empresasConsultadas.map((empresa) => Number(empresa.id));
    const placeholders = empresaIds.map(() => '?').join(', ');
    const exclusoesFinanceiro = `
      AND ${sqlExcluirFinanceiroVendaCancelada('f')}
      AND ${sqlExcluirFinanceiroReceberComContaCanonica('f')}
      ${sqlExcluirProjecaoMcf('f')}
    `;

    const movimentosPorDia = await dbAllAsync(`
      SELECT empresa_id, data,
        SUM(recebido) AS recebido,
        SUM(pago) AS pago
      FROM (
        SELECT
          f.empresa_id,
          date(COALESCE(f.vencimento, f.data_movimento)) AS data,
          SUM(CASE WHEN f.tipo = 'receita' THEN f.valor ELSE 0 END) AS recebido,
          SUM(CASE WHEN f.tipo = 'despesa' THEN f.valor ELSE 0 END) AS pago
        FROM financeiro f
        WHERE f.empresa_id IN (${placeholders})
          AND (
            (f.tipo = 'receita' AND f.status IN ('recebido', 'pago'))
            OR (f.tipo = 'despesa' AND f.status IN ('pago', 'recebido'))
          )
          AND date(COALESCE(f.vencimento, f.data_movimento)) BETWEEN date(?) AND date(?)
          ${exclusoesFinanceiro}
        GROUP BY f.empresa_id, date(COALESCE(f.vencimento, f.data_movimento))

        UNION ALL

        SELECT
          cr.empresa_id,
          date(crp.data_pagamento) AS data,
          SUM(crp.valor_pago) AS recebido,
          0 AS pago
        FROM contas_receber_pagamentos crp
        INNER JOIN contas_receber cr ON cr.id = crp.conta_receber_id
        WHERE cr.empresa_id IN (${placeholders})
          AND date(crp.data_pagamento) BETWEEN date(?) AND date(?)
        GROUP BY cr.empresa_id, date(crp.data_pagamento)

        UNION ALL

        SELECT
          p.empresa_id,
          date(p.data_pagamento) AS data,
          0 AS recebido,
          SUM(p.valor_pago) AS pago
        FROM contas_pagar_pagamentos p
        WHERE p.empresa_id IN (${placeholders})
          AND date(p.data_pagamento) BETWEEN date(?) AND date(?)
        GROUP BY p.empresa_id, date(p.data_pagamento)
      ) movimentos
      GROUP BY empresa_id, data
      ORDER BY data, empresa_id
    `, [
      ...empresaIds, dataInicio, dataFim,
      ...empresaIds, dataInicio, dataFim,
      ...empresaIds, dataInicio, dataFim
    ]);

    const contasLegadasAbertas = await dbAllAsync(`
      SELECT
        f.empresa_id,
        SUM(CASE WHEN f.tipo = 'receita' THEN f.valor ELSE 0 END) AS receber,
        SUM(CASE WHEN f.tipo = 'despesa' THEN f.valor ELSE 0 END) AS pagar
      FROM financeiro f
      WHERE f.empresa_id IN (${placeholders})
        AND f.status NOT IN ('recebido', 'pago', 'cancelado')
        AND f.tipo IN ('receita', 'despesa')
        ${exclusoesFinanceiro}
      GROUP BY f.empresa_id
    `, empresaIds);

    const contasReceberAbertas = await dbAllAsync(`
      SELECT cr.empresa_id, SUM(cr.valor_restante) AS total
      FROM contas_receber cr
      LEFT JOIN vendas v
        ON v.id = cr.venda_id
       AND v.empresa_id = cr.empresa_id
      WHERE cr.empresa_id IN (${placeholders})
        AND cr.status IN ('aberto', 'parcial')
        AND ${sqlExcluirContaVendaCanceladaDaEmpresa('cr', 'v')}
      GROUP BY cr.empresa_id
    `, empresaIds);

    const contasPagarAbertas = await dbAllAsync(`
      SELECT cp.empresa_id, SUM(cp.valor_restante) AS total
      FROM contas_pagar cp
      WHERE cp.empresa_id IN (${placeholders})
        AND cp.status IN ('aberto', 'parcial')
      GROUP BY cp.empresa_id
    `, empresaIds);

    const porEmpresa = new Map();
    for (const empresa of empresasConsultadas) {
      const id = Number(empresa.id);
      porEmpresa.set(id, {
        id,
        nome: empresa.nome_fantasia || empresa.razao_social || `Empresa #${id}`,
        cnpj: empresa.cnpj || null,
        resumo: {
          totalRecebido: 0,
          totalPago: 0,
          totalReceber: 0,
          totalPagar: 0
        }
      });
    }

    const arredondar = (valor) => Math.round((valor + Number.EPSILON) * 100) / 100;
    const seriePorData = new Map();
    movimentosPorDia.forEach((movimento) => {
      const empresa = porEmpresa.get(Number(movimento.empresa_id));
      if (!empresa) return;
      const recebido = arredondar(parseNumber(movimento.recebido));
      const pago = arredondar(parseNumber(movimento.pago));
      empresa.resumo.totalRecebido += recebido;
      empresa.resumo.totalPago += pago;

      const chaveData = String(movimento.data);
      if (!seriePorData.has(chaveData)) {
        seriePorData.set(chaveData, { data: chaveData, recebido: 0, pago: 0 });
      }
      const serie = seriePorData.get(chaveData);
      serie.recebido += recebido;
      serie.pago += pago;
    });

    contasLegadasAbertas.forEach((conta) => {
      const empresa = porEmpresa.get(Number(conta.empresa_id));
      if (!empresa) return;
      empresa.resumo.totalReceber += parseNumber(conta.receber);
      empresa.resumo.totalPagar += parseNumber(conta.pagar);
    });
    contasReceberAbertas.forEach((conta) => {
      const empresa = porEmpresa.get(Number(conta.empresa_id));
      if (empresa) empresa.resumo.totalReceber += parseNumber(conta.total);
    });
    contasPagarAbertas.forEach((conta) => {
      const empresa = porEmpresa.get(Number(conta.empresa_id));
      if (empresa) empresa.resumo.totalPagar += parseNumber(conta.total);
    });

    const empresas = Array.from(porEmpresa.values())
      .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
    empresas.forEach((empresa) => {
      Object.keys(empresa.resumo).forEach((chave) => {
        empresa.resumo[chave] = arredondar(empresa.resumo[chave]);
      });
    });
    const resumo = empresas.reduce((total, empresa) => {
      total.totalRecebido += empresa.resumo.totalRecebido;
      total.totalPago += empresa.resumo.totalPago;
      total.totalReceber += empresa.resumo.totalReceber;
      total.totalPagar += empresa.resumo.totalPagar;
      return total;
    }, { totalRecebido: 0, totalPago: 0, totalReceber: 0, totalPagar: 0 });

    Object.keys(resumo).forEach((chave) => {
      resumo[chave] = arredondar(resumo[chave]);
    });

    return res.json({
      success: true,
      escopo: empresaSolicitada == null || String(empresaSolicitada) === 'todas' ? 'todas' : 'empresa',
      periodo: {
        dataInicio,
        dataFim,
        dataReferenciaAbertos: moment().format('YYYY-MM-DD')
      },
      resumo,
      empresas,
      serieTemporal: Array.from(seriePorData.values()).map((serie) => ({
        data: serie.data,
        recebido: arredondar(serie.recebido),
        pago: arredondar(serie.pago)
      }))
    });
  } catch (err) {
    console.error('Erro no dashboard financeiro multiempresa:', err);
    return res.status(Number(err.status) || 500).json({
      success: false,
      error: err.message || 'Não foi possível carregar o dashboard financeiro.',
      code: err.code || 'DASHBOARD_FINANCEIRO_ERRO'
    });
  }
});

router.get('/multiempresa/receber', async (req, res) => {
  try {
    const empresas = await obterEmpresasAutorizadasFinanceiro(req, res);
    if (!empresas) return;
    const hoje = moment().format('YYYY-MM-DD');
    const contasPorEmpresa = await Promise.all(empresas.map(async (empresa) => {
      const empresaId = Number(empresa.id);
      const legado = buildReceberQueryFilters(req.query, empresaId, {
        excluirComContaCanonica: true
      });
      const canonico = buildReceberCanonicoQueryFilters(req.query, empresaId);
      const [rowsLegado, rowsCanonico] = await Promise.all([
        dbAllAsync(legado.sql, legado.params),
        canonico.sql ? dbAllAsync(canonico.sql, canonico.params) : Promise.resolve([])
      ]);
      const metadados = metadadosEmpresaFinanceiro(empresa);
      return [
        ...rowsLegado.map((row) => ({
          ...mapearLinhaReceberLegado(row, hoje),
          ...metadados,
          chave: `financeiro:${empresaId}:${row.id}`
        })),
        ...rowsCanonico.map((row) => ({
          ...mapearLinhaReceberCanonico(row, hoje),
          ...metadados,
          chave: `contas_receber:${empresaId}:${row.id}`
        }))
      ];
    }));
    const contas = contasPorEmpresa.flat().sort((a, b) => {
      const da = String(a.dataVencimento || '');
      const dbv = String(b.dataVencimento || '');
      if (da !== dbv) return dbv.localeCompare(da);
      return String(a.chave).localeCompare(String(b.chave));
    });
    return res.json({
      success: true,
      uniao: true,
      escopo: 'todas',
      empresas: empresas.map(metadadosEmpresaFinanceiro),
      contas
    });
  } catch (err) {
    console.error('Erro na consulta multiempresa de contas a receber:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Não foi possível carregar contas a receber.',
      code: 'FINANCEIRO_MULTIEMPRESA_ERRO'
    });
  }
});

router.get('/multiempresa/dividas-cliente', async (req, res) => {
  try {
    const empresas = await obterEmpresasAutorizadasFinanceiro(req, res);
    if (!empresas) return;
    const empresaIds = empresas.map((empresa) => Number(empresa.id));
    const placeholders = empresaIds.map(() => '?').join(', ');
    const { cliente, status, dataInicio, dataFim } = req.query;
    let sql = `
      SELECT
        cr.empresa_id,
        c.id as cliente_id,
        c.nome as nome_cliente,
        COALESCE(c.cpf_cnpj, '') as cpf,
        COALESCE(c.telefone, '') as telefone,
        COUNT(DISTINCT v.id) as quantidade_vendas,
        COUNT(cr.id) as quantidade_titulos,
        COALESCE(SUM(CASE WHEN cr.status IN ('aberto','parcial') THEN cr.valor_restante ELSE 0 END), 0) as total_divida,
        COALESCE(SUM(CASE WHEN cr.status = 'recebido' THEN cr.valor_parcela ELSE 0 END), 0) as total_pago,
        COALESCE(SUM(CASE WHEN cr.status IN ('aberto','parcial') AND date(cr.data_vencimento) < date('now') THEN 1 ELSE 0 END), 0) as vencidas,
        COALESCE(SUM(CASE WHEN cr.status IN ('aberto','parcial') AND date(cr.data_vencimento) >= date('now') THEN 1 ELSE 0 END), 0) as a_vencer
      FROM contas_receber cr
      JOIN clientes c ON c.id = cr.cliente_id
      LEFT JOIN vendas v
        ON v.id = cr.venda_id
       AND v.empresa_id = cr.empresa_id
      WHERE cr.status IN ('aberto','parcial')
        AND cr.empresa_id IN (${placeholders})
        AND ${sqlExcluirContaVendaCanceladaDaEmpresa('cr', 'v')}
    `;
    const params = empresaIds.slice();

    if (cliente) {
      sql += ' AND (c.nome LIKE ? OR c.cpf_cnpj LIKE ? OR c.telefone LIKE ?)';
      params.push(`%${cliente}%`, `%${cliente}%`, `%${cliente}%`);
    }
    if (dataInicio && dataFim) {
      sql += ' AND date(cr.data_vencimento) BETWEEN ? AND ?';
      params.push(dataInicio, dataFim);
    }
    if (status && status !== 'todas') {
      if (status === 'vencidas') {
        sql += " AND date(cr.data_vencimento) < date('now')";
      } else if (status === 'a_vencer') {
        sql += " AND date(cr.data_vencimento) >= date('now')";
      }
    }
    sql += ' GROUP BY cr.empresa_id, c.id, c.nome, c.cpf_cnpj, c.telefone';
    sql += ' ORDER BY c.nome ASC, cr.empresa_id ASC';

    const rows = await dbAllAsync(sql, params);
    const empresasPorId = new Map(empresas.map((empresa) => [
      Number(empresa.id),
      metadadosEmpresaFinanceiro(empresa)
    ]));
    const clientes = rows.map((row) => ({
      ...row,
      ...(empresasPorId.get(Number(row.empresa_id)) || {}),
      quantidade_vendas: parseNumber(row.quantidade_vendas),
      quantidade_titulos: parseNumber(row.quantidade_titulos),
      total_divida: parseNumber(row.total_divida),
      total_pago: parseNumber(row.total_pago),
      saldo_atual: parseNumber(row.total_divida),
      vencidas: parseNumber(row.vencidas),
      a_vencer: parseNumber(row.a_vencer)
    }));
    return res.json({ success: true, escopo: 'todas', empresas: Array.from(empresasPorId.values()), clientes });
  } catch (err) {
    console.error('Erro na consulta multiempresa de dívidas por cliente:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Não foi possível carregar dívidas por cliente.',
      code: 'FINANCEIRO_MULTIEMPRESA_ERRO'
    });
  }
});

router.get('/multiempresa/historico', async (req, res) => {
  try {
    const empresas = await obterEmpresasAutorizadasFinanceiro(req, res);
    if (!empresas) return;
    const empresaIds = empresas.map((empresa) => Number(empresa.id));
    const placeholders = empresaIds.map(() => '?').join(', ');
    const { dataInicio, dataFim, tipo, status, busca } = req.query;
    let sql = `SELECT f.* FROM financeiro f
      WHERE f.empresa_id IN (${placeholders})
        AND ${sqlExcluirFinanceiroVendaCancelada('f')}
        ${sqlExcluirProjecaoMcf('f')}`;
    const params = empresaIds.slice();

    if (dataInicio && dataFim) {
      sql += ' AND date(f.data_movimento) BETWEEN ? AND ?';
      params.push(dataInicio, dataFim);
    }
    if (tipo) {
      sql += ' AND f.tipo = ?';
      params.push(tipo);
    }
    if (status) {
      sql += ' AND f.status = ?';
      params.push(status);
    }
    if (busca) {
      sql += ' AND (f.descricao LIKE ? OR f.documento LIKE ?)';
      params.push(`%${busca}%`, `%${busca}%`);
    }
    sql += ' ORDER BY date(f.data_movimento) DESC, f.id DESC, f.empresa_id ASC';

    const rows = await dbAllAsync(sql, params);
    const empresasPorId = new Map(empresas.map((empresa) => [
      Number(empresa.id),
      metadadosEmpresaFinanceiro(empresa)
    ]));
    return res.json(rows.map((row) => ({
      ...row,
      ...(empresasPorId.get(Number(row.empresa_id)) || {})
    })));
  } catch (err) {
    console.error('Erro na consulta multiempresa do histórico financeiro:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Não foi possível carregar o histórico financeiro.',
      code: 'FINANCEIRO_MULTIEMPRESA_ERRO'
    });
  }
});

router.get('/multiempresa/relatorios/resumo', async (req, res) => {
  const { dataInicio, dataFim, modo_fiscal } = req.query;
  try {
    const empresas = await obterEmpresasAutorizadasFinanceiro(req, res);
    if (!empresas) return;
    const empresaIds = empresas.map((empresa) => Number(empresa.id));
    const placeholders = empresaIds.map(() => '?').join(', ');
    let sql = `
      SELECT tipo, status, SUM(valor) AS total, COUNT(*) AS quantidade
      FROM financeiro f
      WHERE f.empresa_id IN (${placeholders})
        AND ${sqlExcluirFinanceiroVendaCancelada('f')}
        ${sqlExcluirProjecaoMcf('f')}
        AND COALESCE(f.status, '') != 'cancelado'
    `;
    const params = empresaIds.slice();
    if (dataInicio && dataFim) {
      sql += ' AND f.data_movimento BETWEEN ? AND ?';
      params.push(dataInicio, dataFim);
    }
    sql += ' GROUP BY tipo, status ORDER BY tipo, status';

    const [rows, recebimentosPorEmpresa] = await Promise.all([
      dbAllAsync(sql, params),
      Promise.all(empresaIds.map((empresaId) => consultarRecebimentosVendaSplit(
        dataInicio,
        dataFim,
        modo_fiscal,
        empresaId
      )))
    ]);
    const resumo = {
      receitas: { total: 0, recebidas: 0, pendentes: 0, quantidade: 0 },
      despesas: { total: 0, pagas: 0, pendentes: 0, quantidade: 0 }
    };
    rows.forEach((row) => {
      const valor = parseNumber(row.total);
      const quantidade = parseNumber(row.quantidade);
      if (row.tipo === 'receita') {
        resumo.receitas.total += valor;
        resumo.receitas.quantidade += quantidade;
        if (row.status === 'recebido') resumo.receitas.recebidas += valor;
        else resumo.receitas.pendentes += valor;
      } else if (row.tipo === 'despesa') {
        resumo.despesas.total += valor;
        resumo.despesas.quantidade += quantidade;
        if (row.status === 'pago') resumo.despesas.pagas += valor;
        else resumo.despesas.pendentes += valor;
      }
    });
    const somaSplit = (chave, campo) => recebimentosPorEmpresa.reduce(
      (total, item) => total + parseNumber(item[chave][campo]),
      0
    );
    const fiscal = {
      total: somaSplit('fiscal', 'total'),
      quantidade: somaSplit('fiscal', 'quantidade')
    };
    const naoFiscal = {
      total: somaSplit('nao_fiscal', 'total'),
      quantidade: somaSplit('nao_fiscal', 'quantidade')
    };
    const total = {
      total: somaSplit('total', 'total'),
      quantidade: somaSplit('total', 'quantidade')
    };
    return res.json({
      success: true,
      escopo: 'todas',
      empresas: empresas.map(metadadosEmpresaFinanceiro),
      modo_fiscal_ativo: recebimentosPorEmpresa.some((item) => item.modo_fiscal_ativo),
      resumo,
      recebimentos_venda: { fiscal, nao_fiscal: naoFiscal, total },
      periodo: { dataInicio, dataFim }
    });
  } catch (err) {
    console.error('Erro no relatório multiempresa de resumo:', err);
    return res.status(500).json({ success: false, error: err.message, code: 'FINANCEIRO_MULTIEMPRESA_ERRO' });
  }
});

router.get('/multiempresa/relatorios/receber', async (req, res) => {
  const { dataInicio, dataFim, status, cliente, modo_fiscal } = req.query;
  const modoFiscalAtivo = isModoFiscalRelatorio(modo_fiscal);
  const sqlDataLegado = 'date(COALESCE(f.vencimento, f.data_movimento))';
  const sqlDataCanonica = 'date(cr.data_vencimento)';
  try {
    const empresas = await obterEmpresasAutorizadasFinanceiro(req, res);
    if (!empresas) return;
    const empresaIds = empresas.map((empresa) => Number(empresa.id));
    const placeholders = empresaIds.map(() => '?').join(', ');
    const paramsLegado = empresaIds.slice();
    const paramsCanonicos = empresaIds.slice();
    let filtrosLegado = `
      f.tipo = 'receita'
      AND f.empresa_id IN (${placeholders})
      AND ${sqlExcluirFinanceiroVendaCancelada('f')}
      AND ${sqlExcluirFinanceiroReceberComContaCanonica('f')}
    `;
    let filtrosCanonicos = `
      cr.empresa_id IN (${placeholders})
      AND (
        cr.venda_id IS NULL
        OR v.id IS NULL
        OR (
          COALESCE(v.cancelada, 0) != 1
          AND LOWER(COALESCE(v.status, '')) != 'cancelada'
        )
      )
    `;
    if (dataInicio && dataFim) {
      filtrosLegado += ` AND ${sqlDataLegado} BETWEEN date(?) AND date(?)`;
      filtrosCanonicos += ` AND ${sqlDataCanonica} BETWEEN date(?) AND date(?)`;
      paramsLegado.push(dataInicio, dataFim);
      paramsCanonicos.push(dataInicio, dataFim);
    }
    if (status && status !== 'todas') {
      if (status === 'vencido') {
        filtrosLegado += ` AND f.status NOT IN ('recebido','pago','cancelado','cancelada')
          AND ${sqlDataLegado} < date('now')`;
        filtrosCanonicos += ` AND cr.status NOT IN ('recebido','pago','cancelado','cancelada')
          AND ${sqlDataCanonica} < date('now')`;
      } else if (status === 'pendente') {
        filtrosLegado += " AND f.status = 'pendente'";
        filtrosCanonicos += " AND cr.status = 'aberto'";
      } else {
        filtrosLegado += ' AND f.status = ?';
        filtrosCanonicos += ' AND cr.status = ?';
        paramsLegado.push(status);
        paramsCanonicos.push(status);
      }
    }
    if (cliente && String(cliente).trim() !== '') {
      const termoCliente = `%${String(cliente).trim()}%`;
      filtrosLegado += ' AND COALESCE(f.pessoa_nome, "") LIKE ?';
      filtrosCanonicos += " AND COALESCE(c.nome, '') LIKE ?";
      paramsLegado.push(termoCliente);
      paramsCanonicos.push(termoCliente);
    }
    if (modoFiscalAtivo) {
      filtrosLegado += ' AND (f.venda_id IS NULL OR COALESCE(v.valor_fiscal, 0) > 0)';
      filtrosCanonicos += ' AND (cr.venda_id IS NULL OR COALESCE(v.valor_fiscal, 0) > 0)';
    }

    const [rowsLegado, rowsCanonicos] = await Promise.all([
      dbAllAsync(`
        SELECT
          f.id,
          f.empresa_id,
          f.descricao,
          f.documento,
          f.valor,
          f.data_movimento,
          f.vencimento,
          f.status,
          f.origem,
          f.pessoa_nome,
          f.venda_id,
          f.referencia_id,
          f.referencia_tipo,
          v.total AS venda_total,
          v.valor_fiscal AS venda_valor_fiscal,
          v.valor_nao_fiscal AS venda_valor_nao_fiscal
        FROM financeiro f
        LEFT JOIN vendas v
          ON v.id = f.venda_id
         AND v.empresa_id = f.empresa_id
        WHERE ${filtrosLegado}
        ORDER BY ${sqlDataLegado} DESC, f.id DESC
      `, paramsLegado),
      dbAllAsync(`
        SELECT
          cr.id,
          cr.empresa_id,
          cr.venda_id,
          cr.numero_parcela,
          cr.total_parcelas,
          cr.componente,
          cr.valor_parcela,
          cr.valor_restante,
          cr.data_vencimento,
          cr.status,
          c.nome AS cliente,
          c.cpf_cnpj AS documento,
          v.codigo AS venda_codigo,
          v.total AS venda_total,
          v.valor_fiscal AS venda_valor_fiscal,
          v.valor_nao_fiscal AS venda_valor_nao_fiscal
        FROM contas_receber cr
        LEFT JOIN clientes c ON c.id = cr.cliente_id
        LEFT JOIN vendas v
          ON v.id = cr.venda_id
         AND v.empresa_id = cr.empresa_id
        WHERE ${filtrosCanonicos}
        ORDER BY ${sqlDataCanonica} DESC, cr.id DESC
      `, paramsCanonicos)
    ]);
    const hoje = moment().format('YYYY-MM-DD');
    const empresasPorId = new Map(empresas.map((empresa) => [
      Number(empresa.id),
      metadadosEmpresaFinanceiro(empresa)
    ]));
    const contasLegadas = rowsLegado.map((row) => {
      let statusFinal = row.status || 'pendente';
      if (
        !['recebido', 'pago', 'cancelado', 'cancelada'].includes(statusFinal)
        && row.vencimento
        && row.vencimento < hoje
      ) statusFinal = 'vencido';

      const metadados = empresasPorId.get(Number(row.empresa_id)) || {};
      const { valorFiscal, valorNaoFiscal } = valoresMotorDaVenda(row);
      const valorOriginal = parseNumber(row.valor);
      const liquidado = ['recebido', 'pago'].includes(row.status);
      const saldoConhecido = [
        'recebido', 'pago', 'cancelado', 'cancelada', 'pendente', 'aberto'
      ].includes(row.status);
      const valorExibido = modoFiscalAtivo
        ? (parseNumber(row.venda_valor_nao_fiscal) <= 0 ? valorOriginal : valorFiscal)
        : valorOriginal;

      return {
        id: row.id,
        ...metadados,
        fonte: 'financeiro',
        chave: `financeiro:${row.empresa_id}:${row.id}`,
        cliente: row.pessoa_nome || '',
        descricao: row.descricao || '',
        documento: row.documento || '',
        valor: valorExibido,
        valor_fiscal: valorFiscal,
        valor_nao_fiscal: valorNaoFiscal,
        valor_total: valorOriginal,
        valor_original: valorOriginal,
        valor_recebido: saldoConhecido ? (liquidado ? valorOriginal : 0) : null,
        valor_restante: saldoConhecido
          ? (liquidado || ['cancelado', 'cancelada'].includes(row.status) ? 0 : valorOriginal)
          : null,
        dataEmissao: row.data_movimento || null,
        dataVencimento: row.vencimento || null,
        status: statusFinal,
        status_persistido: row.status || 'pendente',
        origem: row.origem || '',
        venda_id: row.venda_id || null
      };
    });
    const contasCanonicas = rowsCanonicos.map((row) => {
      let statusFinal = row.status || 'aberto';
      if (
        !['recebido', 'pago', 'cancelado', 'cancelada'].includes(statusFinal)
        && row.data_vencimento
        && row.data_vencimento < hoje
      ) statusFinal = 'vencido';

      const metadados = empresasPorId.get(Number(row.empresa_id)) || {};
      const valorOriginal = parseNumber(row.valor_parcela);
      const valorRestante = parseNumber(row.valor_restante);
      const { valorFiscal, valorNaoFiscal } = valoresMotorDaVenda({
        venda_id: row.venda_id,
        valor: valorOriginal,
        venda_valor_fiscal: row.venda_valor_fiscal,
        venda_valor_nao_fiscal: row.venda_valor_nao_fiscal
      });
      const valorExibido = modoFiscalAtivo
        ? (parseNumber(row.venda_valor_nao_fiscal) <= 0 ? valorOriginal : valorFiscal)
        : valorOriginal;

      return {
        id: row.id,
        ...metadados,
        fonte: 'contas_receber',
        chave: `contas_receber:${row.empresa_id}:${row.id}`,
        cliente: row.cliente || '',
        descricao: `Parcela ${row.numero_parcela || '-'}/${row.total_parcelas || '-'} · ${row.componente === 'outros' ? 'Outros' : 'Produtos'} · Venda ${row.venda_codigo || row.venda_id || '-'}`,
        documento: row.documento || '',
        valor: valorExibido,
        valor_fiscal: valorFiscal,
        valor_nao_fiscal: valorNaoFiscal,
        valor_total: valorOriginal,
        valor_original: valorOriginal,
        valor_recebido: valorOriginal - valorRestante,
        valor_restante: valorRestante,
        dataEmissao: null,
        dataVencimento: row.data_vencimento || null,
        status: statusFinal,
        status_persistido: row.status || 'aberto',
        origem: 'contas_receber',
        venda_id: row.venda_id || null
      };
    });
    const contas = [...contasLegadas, ...contasCanonicas]
      .sort((a, b) => {
        const dataA = String(a.dataVencimento || a.dataEmissao || '');
        const dataB = String(b.dataVencimento || b.dataEmissao || '');
        if (dataA !== dataB) return dataB.localeCompare(dataA);
        return String(a.chave).localeCompare(String(b.chave));
      })
      .filter((conta) => !modoFiscalAtivo || parseNumber(conta.valor_fiscal) > 0);
    return res.json({
      success: true,
      escopo: 'todas',
      empresas: Array.from(empresasPorId.values()),
      modo_fiscal_ativo: modoFiscalAtivo,
      contas,
      totais: totaisMotorSemDuplicarVenda(contas, modoFiscalAtivo),
      periodo: { dataInicio, dataFim }
    });
  } catch (err) {
    console.error('Erro no relatório multiempresa de contas a receber:', err);
    return res.status(500).json({ success: false, error: err.message, code: 'FINANCEIRO_MULTIEMPRESA_ERRO' });
  }
});

router.get('/multiempresa/relatorios/fluxo', async (req, res) => {
  const { dataInicio, dataFim, modo_fiscal } = req.query;
  try {
    const empresas = await obterEmpresasAutorizadasFinanceiro(req, res);
    if (!empresas) return;
    const empresaIds = empresas.map((empresa) => Number(empresa.id));
    const placeholders = empresaIds.map(() => '?').join(', ');
    let sql = `
      SELECT DATE(f.data_movimento) AS data, f.tipo, SUM(f.valor) AS valor
      FROM financeiro f
      WHERE f.empresa_id IN (${placeholders})
        AND ${sqlExcluirFinanceiroVendaCancelada('f')}
        ${sqlExcluirProjecaoMcf('f')}
        AND COALESCE(f.status, '') != 'cancelado'
    `;
    const params = empresaIds.slice();
    if (dataInicio && dataFim) {
      sql += ' AND f.data_movimento BETWEEN ? AND ?';
      params.push(dataInicio, dataFim);
    }
    sql += ' GROUP BY DATE(f.data_movimento), tipo ORDER BY data';

    const [rows, recebimentosPorEmpresa] = await Promise.all([
      dbAllAsync(sql, params),
      Promise.all(empresaIds.map((empresaId) => consultarRecebimentosVendaSplit(
        dataInicio,
        dataFim,
        modo_fiscal,
        empresaId
      )))
    ]);
    const entradasFinanceiro = rows
      .filter((row) => row.tipo === 'receita')
      .reduce((total, row) => total + parseNumber(row.valor), 0);
    const saidas = rows
      .filter((row) => row.tipo === 'despesa')
      .reduce((total, row) => total + parseNumber(row.valor), 0);
    const somaSplit = (chave) => recebimentosPorEmpresa.reduce(
      (total, item) => total + parseNumber(item[chave].total),
      0
    );
    const entradasFiscal = somaSplit('fiscal');
    const entradasNaoFiscal = somaSplit('nao_fiscal');
    const entradasTotal = somaSplit('total');
    const modoFiscalAtivo = recebimentosPorEmpresa.some((item) => item.modo_fiscal_ativo);
    return res.json({
      success: true,
      escopo: 'todas',
      empresas: empresas.map(metadadosEmpresaFinanceiro),
      modo_fiscal_ativo: modoFiscalAtivo,
      entradas: modoFiscalAtivo ? entradasFiscal : entradasTotal,
      entradas_financeiro: entradasFinanceiro,
      entradas_venda: {
        fiscal: entradasFiscal,
        nao_fiscal: entradasNaoFiscal,
        total: entradasTotal
      },
      saidas,
      periodo: { dataInicio, dataFim }
    });
  } catch (err) {
    console.error('Erro no relatório multiempresa de fluxo:', err);
    return res.status(500).json({ success: false, error: err.message, code: 'FINANCEIRO_MULTIEMPRESA_ERRO' });
  }
});

router.get('/multiempresa/relatorios/inadimplencia', async (req, res) => {
  const { dataInicio, dataFim } = req.query;
  try {
    const empresas = await obterEmpresasAutorizadasFinanceiro(req, res);
    if (!empresas) return;
    const empresaIds = empresas.map((empresa) => Number(empresa.id));
    const placeholders = empresaIds.map(() => '?').join(', ');
    const filtroPeriodoMovimento = dataInicio && dataFim
      ? ' AND f.data_movimento BETWEEN ? AND ?'
      : '';
    const filtroPeriodoRecebivel = dataInicio && dataFim
      ? ' AND date(cr.data_vencimento) BETWEEN date(?) AND date(?)'
      : '';
    const filtroPeriodoPagar = dataInicio && dataFim
      ? ' AND date(cp.data_vencimento) BETWEEN date(?) AND date(?)'
      : '';
    const parametrosFinanceiro = empresaIds.slice();
    const parametrosReceber = empresaIds.slice();
    const parametrosPagar = empresaIds.slice();
    if (dataInicio && dataFim) {
      parametrosFinanceiro.push(dataInicio, dataFim);
      parametrosReceber.push(dataInicio, dataFim);
      parametrosPagar.push(dataInicio, dataFim);
    }

    const [rowsFinanceiro, rowsReceber, rowsPagar] = await Promise.all([
      dbAllAsync(`
        SELECT
          f.*,
          CASE WHEN f.tipo = 'receita' THEN 'cliente'
            WHEN f.tipo = 'despesa' THEN 'fornecedor' ELSE 'outros' END AS tipo_pessoa,
          julianday('now') - julianday(f.vencimento) AS dias_atraso
        FROM financeiro f
        WHERE f.status NOT IN ('recebido', 'pago', 'cancelado')
          AND f.vencimento < date('now')
          AND f.empresa_id IN (${placeholders})
          AND ${sqlExcluirFinanceiroVendaCancelada('f')}
          AND ${sqlExcluirFinanceiroReceberComContaCanonica('f')}
          ${sqlExcluirProjecaoMcf('f')}
          ${filtroPeriodoMovimento}
        ORDER BY f.vencimento ASC
      `, parametrosFinanceiro),
      dbAllAsync(`
        SELECT
          cr.id,
          cr.empresa_id,
          'cliente' AS tipo_pessoa,
          'receita' AS tipo,
          'Parcela da venda #' || cr.venda_id || ' - parcela ' || COALESCE(cr.numero_parcela, '-') AS descricao,
          NULL AS documento,
          NULL AS data_movimento,
          cr.data_vencimento AS vencimento,
          cr.valor_restante AS valor,
          cr.status,
          julianday('now') - julianday(cr.data_vencimento) AS dias_atraso
        FROM contas_receber cr
        WHERE cr.empresa_id IN (${placeholders})
          AND cr.status IN ('aberto', 'parcial')
          AND ${sqlExcluirContaVendaCancelada('cr')}
          AND date(cr.data_vencimento) < date('now')
          ${filtroPeriodoRecebivel}
        ORDER BY cr.data_vencimento ASC
      `, parametrosReceber),
      dbAllAsync(`
        SELECT
          cp.id,
          cp.empresa_id,
          'fornecedor' AS tipo_pessoa,
          'despesa' AS tipo,
          cp.descricao,
          cp.documento,
          cp.data_emissao AS data_movimento,
          cp.data_vencimento AS vencimento,
          cp.valor_restante AS valor,
          cp.status,
          COALESCE(cp.pessoa_nome, f.nome) AS pessoa_nome,
          julianday('now') - julianday(cp.data_vencimento) AS dias_atraso
        FROM contas_pagar cp
        LEFT JOIN fornecedores f ON f.id = cp.fornecedor_id
        WHERE cp.empresa_id IN (${placeholders})
          AND cp.status IN ('aberto', 'parcial')
          AND date(cp.data_vencimento) < date('now')
          ${filtroPeriodoPagar}
        ORDER BY cp.data_vencimento ASC
      `, parametrosPagar)
    ]);
    const empresasPorId = new Map(empresas.map((empresa) => [
      Number(empresa.id),
      metadadosEmpresaFinanceiro(empresa)
    ]));
    const enriquecer = (row, fonte) => ({
      id: row.id,
      ... (empresasPorId.get(Number(row.empresa_id)) || {}),
      pessoa: row.pessoa_nome || null,
      tipo_pessoa: row.tipo_pessoa,
      descricao: row.descricao,
      documento: row.documento,
      valor: parseNumber(row.valor),
      dataEmissao: row.data_movimento || null,
      dataVencimento: row.vencimento,
      status: row.status,
      dias_atraso: Math.floor(parseNumber(row.dias_atraso)),
      tipo: row.tipo,
      fonte,
      chave: `${fonte}:${row.empresa_id}:${row.id}`
    });
    const inadimplentes = [
      ...rowsFinanceiro.map((row) => enriquecer(row, 'financeiro')),
      ...rowsReceber.map((row) => enriquecer(row, 'contas_receber')),
      ...rowsPagar.map((row) => enriquecer(row, 'contas_pagar'))
    ].sort((a, b) => String(a.dataVencimento).localeCompare(String(b.dataVencimento)));
    return res.json({
      success: true,
      escopo: 'todas',
      empresas: Array.from(empresasPorId.values()),
      vencidas: inadimplentes.filter((item) => item.dias_atraso > 0).length,
      vencer7dias: inadimplentes.filter((item) => item.dias_atraso <= 7 && item.dias_atraso > 0).length,
      valorAtraso: inadimplentes.reduce((total, item) => total + item.valor, 0),
      contasAtraso: inadimplentes,
      periodo: { dataInicio, dataFim }
    });
  } catch (err) {
    console.error('Erro no relatório multiempresa de inadimplência:', err);
    return res.status(500).json({ success: false, error: err.message, code: 'FINANCEIRO_MULTIEMPRESA_ERRO' });
  }
});

router.use(anexarEmpresaFinanceiro);

function parseNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function arredondarCentavos(value) {
  return Math.round(parseNumber(value) * 100) / 100;
}

async function consultarRecebimentosVendaSplit(dataInicio, dataFim, modoFiscal, empresaId) {
  const modoFiscalAtivo = isModoFiscalRelatorio(modoFiscal);
  const params = [];
  let dateFilter = '';

  if (dataInicio && dataFim) {
    dateFilter = ' AND date(v.data_venda) BETWEEN date(?) AND date(?)';
    params.push(dataInicio, dataFim);
  }

  const rows = await dbAllAsync(`
    SELECT
      vr.tipo_recebimento,
      COALESCE(SUM(vr.valor), 0) AS total,
      COUNT(*) AS quantidade
    FROM venda_recebimentos vr
    INNER JOIN vendas v ON v.id = vr.venda_id
    WHERE ${FILTRO_VENDA_VALIDA}
      AND COALESCE(vr.status, 'aprovado') != 'cancelado'
      ${modoFiscalAtivo ? "AND vr.tipo_recebimento = 'fiscal'" : ''}
      AND v.empresa_id = ?
      ${dateFilter}
    GROUP BY vr.tipo_recebimento
  `, [Number(empresaId), ...params]);

  const map = (rows || []).reduce((acc, row) => {
    acc[row.tipo_recebimento || 'fiscal'] = {
      total: parseNumber(row.total),
      quantidade: parseNumber(row.quantidade)
    };
    return acc;
  }, {});

  const fiscal = map.fiscal || { total: 0, quantidade: 0 };
  const naoFiscal = map.nao_fiscal || { total: 0, quantidade: 0 };

  return {
    modo_fiscal_ativo: modoFiscalAtivo,
    fiscal,
    nao_fiscal: naoFiscal,
    total: {
      total: fiscal.total + (modoFiscalAtivo ? 0 : naoFiscal.total),
      quantidade: fiscal.quantidade + (modoFiscalAtivo ? 0 : naoFiscal.quantidade)
    }
  };
}

/**
 * Hotfix: valores F/NF vêm exclusivamente do Motor persistido na venda.
 * Não rateia parcela × (valor_fiscal / total).
 */
function valoresMotorDaVenda(row) {
  if (!row.venda_id) {
    return {
      valorFiscal: parseNumber(row.valor),
      valorNaoFiscal: 0
    };
  }
  return {
    valorFiscal: parseNumber(row.venda_valor_fiscal),
    valorNaoFiscal: parseNumber(row.venda_valor_nao_fiscal)
  };
}

function totaisMotorSemDuplicarVenda(contas, modoFiscalAtivo) {
  const vendasVistas = new Set();
  let fiscal = 0;
  let naoFiscal = 0;
  let totalParcelas = 0;

  for (const c of contas) {
    totalParcelas += parseNumber(modoFiscalAtivo ? c.valor : c.valor_total);
    if (c.venda_id) {
      if (vendasVistas.has(c.venda_id)) continue;
      vendasVistas.add(c.venda_id);
      fiscal += parseNumber(c.valor_fiscal);
      naoFiscal += parseNumber(c.valor_nao_fiscal);
    } else {
      fiscal += parseNumber(c.valor_fiscal);
      naoFiscal += parseNumber(c.valor_nao_fiscal);
    }
  }

  return {
    fiscal,
    nao_fiscal: modoFiscalAtivo ? 0 : naoFiscal,
    total: modoFiscalAtivo ? fiscal : totalParcelas
  };
}

function dbGetAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function dbAllAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function requireAdminFinanceiro(req, res) {
  if (!req.user || req.user.role !== 'admin') {
    res.status(403).json({ error: 'Apenas o administrador pode editar ou excluir lançamentos financeiros.' });
    return false;
  }
  return true;
}

function formatoStatus(tipo, status) {
  if (status) return status;
  return tipo === 'receita' ? 'recebido' : 'pago';
}

/** Fragmento SQL + param para isolamento empresarial (05.38.D). */
function filtroEmpresaSql(empresaId, alias = '') {
  const col = alias ? `${alias}.empresa_id` : 'empresa_id';
  return { sql: ` AND ${col} = ? `, param: Number(empresaId) };
}

function sqlExcluirContaVendaCanceladaDaEmpresa(aliasConta = 'cr', aliasVenda = 'v') {
  return `(
    ${aliasConta}.venda_id IS NULL
    OR ${aliasVenda}.id IS NULL
    OR (
      COALESCE(${aliasVenda}.cancelada, 0) != 1
      AND LOWER(COALESCE(${aliasVenda}.status, '')) != 'cancelada'
    )
  )`;
}

function responderErroEmpresa(res, err) {
  return res.status(statusDeErroEmpresa(err)).json({
    error: err.message,
    code: err.code,
    empresa_id: err.empresa_id != null ? err.empresa_id : undefined
  });
}

function inserirMovimentacao(data) {
  return new Promise((resolve, reject) => {
    const {
      tipo,
      descricao,
      valor,
      data_movimento,
      categoria,
      forma_pagamento,
      referencia_id,
      referencia_tipo,
      status,
      origem,
      documento,
      vencimento,
      numero_parcela,
      total_parcelas,
      compra_id,
      venda_id,
      pessoa_nome,
      observacao,
      empresa_id
    } = data;

    const empresaId = Number(empresa_id);
    if (!Number.isInteger(empresaId) || empresaId <= 0) {
      return reject(Object.assign(new Error('empresa_id é obrigatório para lançamento financeiro.'), {
        code: 'FINANCEIRO_EMPRESA_OBRIGATORIA',
        statusCode: 400
      }));
    }

    db.run(`
      INSERT INTO financeiro (
        tipo, descricao, valor, data_movimento, categoria, forma_pagamento,
        referencia_id, referencia_tipo, status, origem, documento, vencimento,
        numero_parcela, total_parcelas, compra_id, venda_id, pessoa_nome, observacao,
        baixado_em, empresa_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      tipo,
      descricao,
      valor,
      data_movimento,
      categoria || null,
      forma_pagamento || null,
      referencia_id || null,
      referencia_tipo || null,
      formatoStatus(tipo, status),
      origem || 'manual',
      documento || null,
      vencimento || data_movimento,
      numero_parcela || null,
      total_parcelas || null,
      compra_id || null,
      venda_id || null,
      pessoa_nome || null,
      observacao || null,
      ['pago', 'recebido'].includes(formatoStatus(tipo, status)) ? (data.baixado_em || data_movimento) : null,
      empresaId
    ], function(err) {
      if (err) reject(err);
      else resolve(this.lastID);
    });
  });
}

router.get('/', (req, res) => {
  const { dataInicio, dataFim, tipo, status, busca } = req.query;
  const emp = filtroEmpresaSql(req.empresaId, 'f');

  // MCF-02.1 — não listar projeções MCF como obrigações independentes
  let sql = `SELECT f.* FROM financeiro f WHERE 1=1`
    + emp.sql
    + ` AND ${sqlExcluirFinanceiroVendaCancelada('f')}`
    + sqlExcluirProjecaoMcf('f');
  const params = [emp.param];

  if (dataInicio && dataFim) {
    sql += ` AND date(f.data_movimento) BETWEEN ? AND ?`;
    params.push(dataInicio, dataFim);
  }

  if (tipo) {
    sql += ` AND f.tipo = ?`;
    params.push(tipo);
  }

  if (status) {
    sql += ` AND f.status = ?`;
    params.push(status);
  }

  if (busca) {
    sql += ` AND (f.descricao LIKE ? OR f.documento LIKE ?)`;
    params.push(`%${busca}%`, `%${busca}%`);
  }

  sql += ` ORDER BY date(f.data_movimento) DESC, f.id DESC`;

  db.all(sql, params, (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }

    res.json(rows);
  });
});

router.get('/resumo', async (req, res) => {
  const { data_inicio, data_fim, tipo, categoria, forma_pagamento, status, origem } = req.query;
  const emp = filtroEmpresaSql(req.empresaId, 'f');

  let sql = `
    SELECT 
      SUM(CASE WHEN tipo = 'receita' THEN valor ELSE 0 END) AS total_receitas,
      SUM(CASE WHEN tipo = 'despesa' THEN valor ELSE 0 END) AS total_despesas,
      SUM(CASE WHEN tipo = 'receita' AND status IN ('recebido','pago')
        AND ${sqlExcluirFinanceiroReceberComContaCanonica('f')} THEN valor ELSE 0 END) AS total_recebido,
      SUM(CASE WHEN tipo = 'despesa' AND status IN ('pago','recebido') THEN valor ELSE 0 END) AS total_pago,
      SUM(CASE WHEN tipo = 'receita' AND status NOT IN ('recebido','pago','cancelado')
        AND ${sqlExcluirFinanceiroReceberComContaCanonica('f')} THEN valor ELSE 0 END) AS total_a_receber,
      SUM(CASE WHEN tipo = 'despesa' AND status NOT IN ('pago','recebido','cancelado') THEN valor ELSE 0 END) AS total_a_pagar
    FROM financeiro f
    WHERE 1=1
      ${emp.sql}
      AND ${sqlExcluirFinanceiroVendaCancelada('f')}
      ${sqlExcluirProjecaoMcf('f')}
  `;
  const params = [emp.param];

  if (data_inicio && data_fim) {
    sql += ' AND COALESCE(vencimento, data_movimento) BETWEEN ? AND ?';
    params.push(data_inicio, data_fim);
  }
  if (tipo) {
    sql += ' AND tipo = ?';
    params.push(tipo);
  }
  if (categoria) {
    sql += ' AND categoria = ?';
    params.push(categoria);
  }
  if (forma_pagamento) {
    sql += ' AND forma_pagamento = ?';
    params.push(forma_pagamento);
  }
  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  if (origem) {
    sql += ' AND origem = ?';
    params.push(origem);
  }

  try {
    const row = await dbGetAsync(sql, params);
    const resumo = row || {};
    resumo.total_receitas = parseNumber(resumo.total_receitas);
    resumo.total_despesas = parseNumber(resumo.total_despesas);
    resumo.total_recebido = parseNumber(resumo.total_recebido);
    resumo.total_pago = parseNumber(resumo.total_pago);
    resumo.total_a_receber = parseNumber(resumo.total_a_receber);
    resumo.total_a_pagar = parseNumber(resumo.total_a_pagar);

    if ((!tipo || tipo === 'receita') && !categoria && !origem && !forma_pagamento) {
      const filtrosReceber = [
        'cr.empresa_id = ?',
        "cr.status IN ('aberto', 'parcial')",
        sqlExcluirContaVendaCancelada('cr')
      ];
      const parametrosReceber = [Number(req.empresaId)];
      if (data_inicio && data_fim) {
        filtrosReceber.push('date(cr.data_vencimento) BETWEEN date(?) AND date(?)');
        parametrosReceber.push(data_inicio, data_fim);
      }
      if (status === 'pendente' || status === 'aberto') {
        filtrosReceber.push("cr.status = 'aberto'");
      } else if (status === 'parcial') {
        filtrosReceber.push("cr.status = 'parcial'");
      } else if (status) {
        filtrosReceber.push('1 = 0');
      }
      const contasReceber = await dbGetAsync(
        `SELECT COALESCE(SUM(cr.valor_restante), 0) AS total
         FROM contas_receber cr
         WHERE ${filtrosReceber.join(' AND ')}`,
        parametrosReceber
      );
      resumo.total_a_receber += parseNumber(contasReceber.total);

      const filtrosRecebimentos = ['cr.empresa_id = ?'];
      const parametrosRecebimentos = [Number(req.empresaId)];
      if (data_inicio && data_fim) {
        filtrosRecebimentos.push('date(crp.data_pagamento) BETWEEN date(?) AND date(?)');
        parametrosRecebimentos.push(data_inicio, data_fim);
      }
      if (status) {
        const statusConta = {
          parcial: ['parcial'],
          pago: ['pago'],
          recebido: ['pago'],
          cancelado: ['cancelado'],
          quitada: ['pago']
        }[status];
        if (statusConta) {
          filtrosRecebimentos.push(`cr.status IN (${statusConta.map(() => '?').join(', ')})`);
          parametrosRecebimentos.push(...statusConta);
        } else {
          filtrosRecebimentos.push('1 = 0');
        }
      }
      const recebimentos = await dbGetAsync(
        `SELECT COALESCE(SUM(crp.valor_pago), 0) AS total
         FROM contas_receber_pagamentos crp
         JOIN contas_receber cr ON cr.id = crp.conta_receber_id
         WHERE ${filtrosRecebimentos.join(' AND ')}`,
        parametrosRecebimentos
      );
      resumo.total_recebido += parseNumber(recebimentos.total);
    }

    if (!tipo || tipo === 'despesa') {
      const filtrosMcf = ['cp.empresa_id = ?'];
      const paramsMcf = [Number(req.empresaId)];
      if (data_inicio && data_fim) {
        filtrosMcf.push('date(cp.data_vencimento) BETWEEN date(?) AND date(?)');
        paramsMcf.push(data_inicio, data_fim);
      }
      if (categoria) {
        filtrosMcf.push('cp.categoria = ?');
        paramsMcf.push(categoria);
      }
      if (forma_pagamento) {
        filtrosMcf.push('cp.forma_pagamento = ?');
        paramsMcf.push(forma_pagamento);
      }
      if (origem) {
        filtrosMcf.push('cp.origem = ?');
        paramsMcf.push(origem);
      }

      const statusMcfAberto = !status || status === 'pendente' || status === 'aberto';
      const statusMcfParcial = !status || status === 'parcial';
      if (statusMcfAberto || statusMcfParcial) {
        const estados = [];
        if (statusMcfAberto) estados.push('aberto');
        if (statusMcfParcial) estados.push('parcial');
        const placeholders = estados.map(() => '?').join(', ');
        const pendentesMcf = await dbGetAsync(
          `SELECT COALESCE(SUM(cp.valor_restante), 0) AS total
           FROM contas_pagar cp
           WHERE ${filtrosMcf.join(' AND ')}
             AND cp.status IN (${placeholders})`,
          [...paramsMcf, ...estados]
        );
        resumo.total_a_pagar += parseNumber(pendentesMcf.total);
      }

      const filtrosPagamento = [
        'cp.empresa_id = ?',
        'date(p.data_pagamento) IS NOT NULL'
      ];
      const paramsPagamento = [Number(req.empresaId)];
      if (data_inicio && data_fim) {
        filtrosPagamento.push('date(p.data_pagamento) BETWEEN date(?) AND date(?)');
        paramsPagamento.push(data_inicio, data_fim);
      }
      if (categoria) {
        filtrosPagamento.push('cp.categoria = ?');
        paramsPagamento.push(categoria);
      }
      if (origem) {
        filtrosPagamento.push('cp.origem = ?');
        paramsPagamento.push(origem);
      }
      if (forma_pagamento) {
        filtrosPagamento.push('p.forma_pagamento = ?');
        paramsPagamento.push(forma_pagamento);
      }
      if (status) {
        const estadosStatus = {
          pendente: ['aberto'],
          aberto: ['aberto'],
          parcial: ['parcial'],
          pago: ['pago'],
          recebido: ['pago'],
          cancelado: ['cancelado'],
          quitada: ['pago']
        }[status];
        if (estadosStatus) {
          filtrosPagamento.push(`cp.status IN (${estadosStatus.map(() => '?').join(', ')})`);
          paramsPagamento.push(...estadosStatus);
        } else {
          filtrosPagamento.push('1 = 0');
        }
      }
      const pagamentosMcf = await dbGetAsync(
        `SELECT COALESCE(SUM(p.valor_pago), 0) AS total
         FROM contas_pagar_pagamentos p
         JOIN contas_pagar cp ON cp.id = p.conta_pagar_id
         WHERE ${filtrosPagamento.join(' AND ')}`,
        paramsPagamento
      );
      resumo.total_pago += parseNumber(pagamentosMcf.total);
    }

    resumo.saldo = resumo.total_recebido - resumo.total_pago;
    res.json(resumo);
  } catch (err) {
    console.error('Erro ao carregar resumo financeiro:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/', (req, res) => {
  const {
    tipo,
    descricao,
    valor,
    data_movimento,
    categoria,
    forma_pagamento,
    documento,
    vencimento,
    observacao,
    compra_id,
    pessoa_nome,
    status
  } = req.body;

  if (!tipo || !descricao || !valor || !data_movimento) {
    res.status(400).json({ error: 'Tipo, descrição, valor e data são obrigatórios.' });
    return;
  }

  if (!['receita', 'despesa'].includes(tipo)) {
    res.status(400).json({ error: 'Tipo de movimentação inválido.' });
    return;
  }

  // MCF-02.1 — despesa/AP canônica via Contas a Pagar (projeção compat automática).
  if (tipo === 'despesa') {
    ContasPagarService.criar({
      db,
      empresaId: req.empresaId,
      descricao,
      valor_original: valor,
      data_emissao: data_movimento,
      data_vencimento: vencimento || data_movimento,
      categoria: categoria || null,
      forma_pagamento: forma_pagamento || null,
      documento: documento || null,
      pessoa_nome: pessoa_nome || null,
      observacao: observacao || null,
      origem: 'manual',
      referencia_tipo: compra_id ? 'compra' : null,
      referencia_id: compra_id || null,
      criado_por: req.user?.id || null
    }).then(async (conta) => {
      gravarAuditoria({
        usuario_id: req.user?.id || null,
        usuario_nome: req.user?.nome || req.user?.username || null,
        modulo: 'financeiro',
        acao: 'criar_despesa_via_mcf',
        referencia_tipo: 'contas_pagar',
        referencia_id: conta.id,
        detalhes: { tipo, descricao, valor, data_movimento, categoria, conta_pagar_id: conta.id },
        ip_requisicao: req.ip || null
      }).catch((auditErr) => console.error('Erro ao gravar auditoria MCF despesa:', auditErr));

      // Compat UI legada: devolve financeiro_id da projeção quando existir.
      let financeiroId = null;
      try {
        const vinculo = await new Promise((resolve, reject) => {
          db.get(
            `SELECT financeiro_id FROM contas_pagar_financeiro_compat
             WHERE empresa_id = ? AND conta_pagar_id = ?`,
            [req.empresaId, conta.id],
            (e, row) => (e ? reject(e) : resolve(row || null))
          );
        });
        financeiroId = vinculo ? Number(vinculo.financeiro_id) : null;
      } catch { /* ignore */ }

      if (status && ['pago', 'recebido'].includes(String(status)) && Number(conta.valor_restante) > 0) {
        try {
          await ContasPagarService.baixar({
            db,
            empresaId: req.empresaId,
            id: conta.id,
            valor_pago: conta.valor_restante,
            data_pagamento: data_movimento,
            forma_pagamento: forma_pagamento || null,
            usuario_id: req.user?.id || null,
            origem_operacao: 'financeiro_post_despesa_pago'
          });
        } catch (baixaErr) {
          return res.status(baixaErr.statusCode || 409).json({
            error: baixaErr.message,
            code: baixaErr.code || null,
            conta_pagar_id: conta.id,
            id: financeiroId
          });
        }
      }

      return res.json({
        id: financeiroId != null ? financeiroId : conta.id,
        conta_pagar_id: conta.id,
        financeiro_id: financeiroId,
        message: 'Despesa registrada via Contas a Pagar (MCF).',
        code: 'MCF_DESPESA_CRIADA'
      });
    }).catch((err) => {
      res.status(err.statusCode || 500).json({
        error: err.message,
        code: err.code || null
      });
    });
    return;
  }

  inserirMovimentacao({
    tipo,
    descricao,
    valor,
    data_movimento,
    categoria,
    forma_pagamento,
    documento,
    vencimento,
    observacao,
    compra_id,
    pessoa_nome,
    origem: 'manual',
    referencia_tipo: 'manual',
    status: status || 'recebido',
    empresa_id: req.empresaId
  }).then((id) => {
    // gravar auditoria de criação de movimentação financeira
    gravarAuditoria({
      usuario_id: req.user?.id || null,
      usuario_nome: req.user?.nome || req.user?.username || null,
      modulo: 'financeiro',
      acao: 'criar_movimentacao',
      referencia_tipo: 'financeiro',
      referencia_id: id,
      detalhes: { tipo, descricao, valor, data_movimento, categoria },
      ip_requisicao: req.ip || null
    }).catch((auditErr) => console.error('Erro ao gravar auditoria de movimentação financeira:', auditErr));

    res.json({ id, message: 'Movimentação registrada com sucesso' });
  }).catch((err) => {
    res.status(500).json({ error: err.message });
  });
});

router.put('/:id', (req, res) => {
  if (!requireAdminFinanceiro(req, res)) return;

  const { id } = req.params;
  const {
    descricao,
    valor,
    data_movimento,
    categoria,
    forma_pagamento,
    documento,
    vencimento,
    observacao,
    pessoa_nome,
    status
  } = req.body;

  db.get('SELECT * FROM financeiro WHERE id = ? AND empresa_id = ?', [id, req.empresaId], async (findErr, row) => {
    if (findErr) {
      res.status(500).json({ error: findErr.message });
      return;
    }

    if (!row) {
      res.status(404).json({ error: 'Movimentação não encontrada.' });
      return;
    }

    try {
      exigirRegistroDaEmpresa(row, req.empresaId, { rotulo: 'Movimentação financeira' });
    } catch (empErr) {
      return responderErroEmpresa(res, empErr);
    }

    // MCF-02.1 — projeção não é obrigação mutável no legado
    if (ehProjecaoMcfRow(row) || await buscarVinculoPorFinanceiroId(db, req.empresaId, id)) {
      const e = erroProjecaoImutavel('alterar');
      return res.status(e.statusCode || 409).json({
        error: e.message,
        code: e.code,
        conta_pagar_id: (await buscarVinculoPorFinanceiroId(db, req.empresaId, id))?.conta_pagar_id || null
      });
    }

    const novoStatus = status || row.status || 'pendente';
    const novaDataMovimento = data_movimento || row.data_movimento;
    const novoVencimento = vencimento || novaDataMovimento;

    db.run(`
      UPDATE financeiro
      SET descricao = ?, valor = ?, data_movimento = ?, categoria = ?, forma_pagamento = ?,
          documento = ?, vencimento = ?, observacao = ?, pessoa_nome = ?, status = ?,
          baixado_em = CASE
            WHEN ? IN ('pago','recebido') THEN COALESCE(baixado_em, DATE('now'))
            ELSE NULL
          END
      WHERE id = ? AND empresa_id = ?
    `, [
      descricao ?? row.descricao,
      valor ?? row.valor,
      novaDataMovimento,
      categoria ?? row.categoria,
      forma_pagamento ?? row.forma_pagamento,
      documento ?? row.documento,
      novoVencimento,
      observacao ?? row.observacao,
      pessoa_nome ?? row.pessoa_nome,
      novoStatus,
      novoStatus,
      id,
      req.empresaId
    ], function(err) {
      if (err) {
        res.status(500).json({ error: err.message });
        return;
      }

      // gravar auditoria de atualização
      gravarAuditoria({
        usuario_id: req.user?.id || null,
        usuario_nome: req.user?.nome || req.user?.username || null,
        modulo: 'financeiro',
        acao: 'atualizar_movimentacao',
        referencia_tipo: 'financeiro',
        referencia_id: id,
        detalhes: { antes: row, depois: req.body },
        ip_requisicao: req.ip || null
      }).catch((auditErr) => console.error('Erro ao gravar auditoria de atualização financeiro:', auditErr));

      res.json({
        success: true,
        message: 'Movimentação atualizada com sucesso.'
      });
    });
  });
});

router.post('/receber/:id/baixar', validarCaixaAberto, (req, res) => {
  const { id } = req.params;
  const empresaId = req.empresaId;

  // Preferir empresa da sessão de caixa quando disponível (05.38.C → 05.38.D)
  const sessaoEmpresa = req.caixaSessao && req.caixaSessao.empresa_id != null
    ? Number(req.caixaSessao.empresa_id)
    : null;
  if (sessaoEmpresa != null && sessaoEmpresa !== Number(empresaId)) {
    return res.status(403).json({
      success: false,
      error: 'Sessão de caixa pertence a outra empresa. Operação financeira bloqueada.',
      code: 'FINANCEIRO_EMPRESA_DIVERGENTE'
    });
  }

  db.get(`
    SELECT id, tipo, status, empresa_id, valor, referencia_id, referencia_tipo, numero_parcela
    FROM financeiro
    WHERE id = ?
  `, [id], (err, row) => {
    if (err) {
      res.status(500).json({ success: false, error: err.message });
      return;
    }
    try {
      exigirLancamentoDaEmpresa(row, empresaId);
    } catch (empErr) {
      return res.status(statusDeErroEmpresa(empErr)).json({
        success: false,
        error: empErr.message,
        code: empErr.code
      });
    }
    if (['recebido', 'pago'].includes(row.status)) {
      res.status(400).json({ success: false, error: 'Esta movimentação já foi baixada.' });
      return;
    }
    const novoStatus = row.tipo === 'receita' ? 'recebido' : 'pago';
    db.serialize(() => {
      db.run('BEGIN IMMEDIATE');
      db.run(
        `UPDATE financeiro SET status = ?, baixado_em = DATE('now') WHERE id = ? AND empresa_id = ? AND status NOT IN ('recebido', 'pago')`,
        [novoStatus, id, empresaId],
        function onFinanceiroAtualizado(upErr) {
          if (upErr || this.changes !== 1) {
            db.run('ROLLBACK');
            res.status(upErr ? 500 : 409).json({
              success: false,
              error: upErr ? upErr.message : 'Esta movimentação já foi baixada.'
            });
            return;
          }

          const finalizarBaixa = () => {
            db.run('COMMIT', (commitErr) => {
              if (commitErr) {
                res.status(500).json({ success: false, error: commitErr.message });
                return;
              }
              gravarAuditoria({
                usuario_id: req.operadorId || req.user?.id || null,
                usuario_nome: req.user?.nome || req.user?.username || null,
                modulo: 'financeiro',
                acao: 'baixar_movimentacao',
                referencia_tipo: 'financeiro',
                referencia_id: id,
                detalhes: {
                  novo_status: novoStatus,
                  sessao_id: req.caixaSessaoId || null,
                  componentes_conta_receber: true
                },
                ip_requisicao: req.ip || null
              }).catch((auditErr) => console.error('Erro ao gravar auditoria de baixa financeiro:', auditErr));

              res.json({ success: true, message: 'Recebimento baixado com sucesso.', status: novoStatus });
            });
          };

          if (
            row.tipo !== 'receita'
            || row.referencia_tipo !== 'venda'
            || !row.referencia_id
            || !Number.isInteger(Number(row.numero_parcela))
          ) {
            finalizarBaixa();
            return;
          }

          db.all(`
            SELECT id, cliente_id, componente, numero_parcela, total_parcelas,
              valor_parcela, valor_restante, status
            FROM contas_receber
            WHERE venda_id = ? AND numero_parcela = ? AND empresa_id = ?
            ORDER BY id
          `, [row.referencia_id, row.numero_parcela, empresaId], (contasErr, contas) => {
            if (contasErr) {
              db.run('ROLLBACK');
              res.status(500).json({ success: false, error: contasErr.message });
              return;
            }
            if (!contas.length) {
              finalizarBaixa();
              return;
            }

            const totalContas = contas.reduce((soma, conta) => soma + Number(conta.valor_parcela || 0), 0);
            if (Math.abs(totalContas - Number(row.valor || 0)) > 0.01) {
              db.run('ROLLBACK');
              res.status(409).json({
                success: false,
                error: 'A parcela financeira não confere com a soma dos componentes em contas a receber.'
              });
              return;
            }

            let indice = 0;
            const liquidarProximoComponente = () => {
              if (indice >= contas.length) {
                db.run(`
                  UPDATE vendas
                  SET status_pagamento = 'quitada'
                  WHERE id = ? AND empresa_id = ? AND status_pagamento = 'pendente'
                    AND NOT EXISTS (
                      SELECT 1 FROM contas_receber
                      WHERE venda_id = ?
                        AND status NOT IN ('pago', 'recebido')
                    )
                `, [
                  row.referencia_id,
                  empresaId,
                  row.referencia_id
                ], (statusErr) => {
                  if (statusErr) {
                    db.run('ROLLBACK');
                    res.status(500).json({ success: false, error: statusErr.message });
                    return;
                  }
                  finalizarBaixa();
                });
                return;
              }

              const conta = contas[indice++];
              const restante = Number(conta.valor_restante || 0);
              if (restante <= 0 || ['pago', 'recebido'].includes(conta.status)) {
                liquidarProximoComponente();
                return;
              }
              if (!conta.cliente_id) {
                db.run('ROLLBACK');
                res.status(409).json({
                  success: false,
                  error: 'Conta a receber sem cliente; baixa sincronizada bloqueada.'
                });
                return;
              }

              db.run(`
                UPDATE contas_receber
                SET valor_restante = 0, status = 'pago', data_pagamento = DATE('now')
                WHERE id = ? AND empresa_id = ? AND status NOT IN ('pago', 'recebido')
              `, [conta.id, empresaId], function onContaAtualizada(contaErr) {
                if (contaErr || this.changes !== 1) {
                  db.run('ROLLBACK');
                  res.status(contaErr ? 500 : 409).json({
                    success: false,
                    error: contaErr ? contaErr.message : 'A parcela mudou durante a baixa.'
                  });
                  return;
                }

                db.run(`
                  INSERT INTO contas_receber_pagamentos (
                    conta_receber_id, cliente_id, valor_pago, data_pagamento,
                    forma_pagamento, observacao
                  ) VALUES (?, ?, ?, DATE('now'), ?, ?)
                `, [
                  conta.id,
                  conta.cliente_id,
                  restante,
                  req.body?.forma_pagamento || null,
                  `Baixa sincronizada do financeiro ${id}; componente ${conta.componente || 'produtos'}`
                ], (pagamentoErr) => {
                  if (pagamentoErr) {
                    db.run('ROLLBACK');
                    res.status(500).json({ success: false, error: pagamentoErr.message });
                    return;
                  }
                  liquidarProximoComponente();
                });
              });
            };

            liquidarProximoComponente();
          });
        }
      );
    });
  });
});

router.post('/pagar/:id/baixar', (req, res) => {
  const { id } = req.params;
  const { valor, forma_pagamento } = req.body;
  const empresaId = req.empresaId;

  db.get('SELECT id, tipo, status, valor AS valor_total, empresa_id, origem, referencia_tipo FROM financeiro WHERE id = ?', [id], async (err, row) => {
    if (err) {
      res.status(500).json({ success: false, error: err.message });
      return;
    }
    try {
      exigirLancamentoDaEmpresa(row, empresaId);
    } catch (empErr) {
      return res.status(statusDeErroEmpresa(empErr)).json({
        success: false,
        error: empErr.message,
        code: empErr.code
      });
    }

    // MCF-02.1 — baixa de AP deve ir pelo MCF
    const vinculoBaixa = ehProjecaoMcfRow(row)
      ? await buscarVinculoPorFinanceiroId(db, empresaId, id)
      : await buscarVinculoPorFinanceiroId(db, empresaId, id);
    if (ehProjecaoMcfRow(row) || vinculoBaixa) {
      const e = erroProjecaoImutavel('pagar');
      return res.status(e.statusCode || 409).json({
        success: false,
        error: e.message,
        code: e.code,
        conta_pagar_id: vinculoBaixa?.conta_pagar_id || null
      });
    }

    if (['recebido', 'pago'].includes(row.status)) {
      res.status(400).json({ success: false, error: 'Esta movimentação já foi baixada.' });
      return;
    }

    const valorPago = parseNumber(valor) || parseNumber(row.valor_total);
    const valorTotal = parseNumber(row.valor_total);

    let novoStatus;
    if (valorPago >= valorTotal) {
      novoStatus = row.tipo === 'receita' ? 'recebido' : 'pago';
    } else {
      novoStatus = 'parcial';
    }

    const updates = ['status = ?', 'baixado_em = DATE(\'now\')'];
    const params = [novoStatus];

    if (forma_pagamento) {
      updates.push('forma_pagamento = ?');
      params.push(forma_pagamento);
    }

    params.push(id, empresaId);

    db.run(`UPDATE financeiro SET ${updates.join(', ')} WHERE id = ? AND empresa_id = ?`, params, (upErr) => {
      if (upErr) {
        res.status(500).json({ success: false, error: upErr.message });
        return;
      }
      // auditoria de baixa de pagamento
      gravarAuditoria({
        usuario_id: req.user?.id || null,
        usuario_nome: req.user?.nome || req.user?.username || null,
        modulo: 'financeiro',
        acao: 'baixar_pagamento',
        referencia_tipo: 'financeiro',
        referencia_id: id,
        detalhes: { valor_pago: valorPago, forma_pagamento: forma_pagamento || null, status: novoStatus },
        ip_requisicao: req.ip || null
      }).catch((auditErr) => console.error('Erro ao gravar auditoria de baixa de pagamento financeiro:', auditErr));

      res.json({ success: true, message: 'Pagamento baixado com sucesso.', status: novoStatus });
    });
  });
});

router.get('/dashboard', async (req, res) => {
  const { dataInicio, dataFim } = req.query;
  const emp = filtroEmpresaSql(req.empresaId);
  const params = [emp.param];
  let periodoFiltro = emp.sql;

  if (dataInicio && dataFim) {
    periodoFiltro += ' AND COALESCE(vencimento, data_movimento) BETWEEN ? AND ?';
    params.push(dataInicio, dataFim);
  }

  const hoje = moment().format('YYYY-MM-DD');
  const daqui30 = moment().add(30, 'days').format('YYYY-MM-DD');

  // MCF-02.1 — excluir projeções para evitar dupla contagem com títulos MCF
  const exclProj = sqlExcluirProjecaoMcf('');

  // Receitas e despesas históricas (sem projeções MCF). AP canônica vem de contas_pagar.
  const resumoSql = `
    SELECT
      COALESCE(SUM(CASE WHEN tipo = 'receita' AND status IN ('recebido','pago') THEN valor END), 0) AS totalRecebido,
      COALESCE(SUM(CASE WHEN tipo = 'despesa' AND status IN ('pago','recebido') THEN valor END), 0) AS totalPagoHistorico
    FROM financeiro f
    WHERE 1 = 1
    ${periodoFiltro}
    AND ${sqlExcluirFinanceiroVendaCancelada('f')}
    AND ${sqlExcluirFinanceiroReceberComContaCanonica('f')}
    ${exclProj}
  `;

  const pendentesSql = `
    SELECT
      COALESCE(SUM(CASE WHEN tipo = 'receita' AND status NOT IN ('recebido','pago','cancelado') THEN valor END), 0) AS totalReceber,
      COALESCE(SUM(CASE WHEN tipo = 'despesa' AND status NOT IN ('pago','recebido','cancelado') THEN valor END), 0) AS totalPagarHistorico
    FROM financeiro f
    WHERE 1 = 1
    ${emp.sql}
    AND ${sqlExcluirFinanceiroVendaCancelada('f')}
    AND ${sqlExcluirFinanceiroReceberComContaCanonica('f')}
    ${exclProj}
  `;

  const crAReceberSql = `
    SELECT COALESCE(SUM(cr.valor_restante), 0) AS total
    FROM contas_receber cr
    WHERE cr.empresa_id = ?
      AND cr.status IN ('aberto', 'parcial')
      AND ${sqlExcluirContaVendaCancelada('cr')}
      ${dataInicio && dataFim ? 'AND date(cr.data_vencimento) BETWEEN date(?) AND date(?)' : ''}
  `;
  const crRecebidoSql = `
    SELECT COALESCE(SUM(crp.valor_pago), 0) AS total
    FROM contas_receber_pagamentos crp
    JOIN contas_receber cr ON cr.id = crp.conta_receber_id
    WHERE cr.empresa_id = ?
      ${dataInicio && dataFim ? 'AND date(crp.data_pagamento) BETWEEN date(?) AND date(?)' : ''}
  `;

  const proximosRecebimentosSql = `
    SELECT
      id,
      descricao,
      valor,
      vencimento,
      pessoa_nome AS cliente,
      tipo,
      status
    FROM financeiro f
    WHERE tipo = 'receita'
      ${emp.sql}
      AND COALESCE(f.status, '') != 'cancelado'
      AND ${sqlExcluirFinanceiroVendaCancelada('f')}
      AND ${sqlExcluirFinanceiroReceberComContaCanonica('f')}
      ${exclProj}
      AND status NOT IN ('recebido','pago','cancelado')
      AND vencimento IS NOT NULL
      AND vencimento BETWEEN date('now') AND date('now', '+30 days')
    ORDER BY vencimento ASC
    LIMIT 10
  `;

  // MCF-02.2 — próximos pagamentos / alertas AP a partir de contas_pagar (não somam projeção)
  const mcfPagoPeriodoSql = `
    SELECT COALESCE(SUM(p.valor_pago), 0) AS total
    FROM contas_pagar_pagamentos p
    WHERE p.empresa_id = ?
      ${dataInicio && dataFim ? 'AND date(p.data_pagamento) BETWEEN date(?) AND date(?)' : ''}
  `;
  const mcfAPagarSql = `
    SELECT COALESCE(SUM(valor_restante), 0) AS total
    FROM contas_pagar
    WHERE empresa_id = ?
      AND status IN ('aberto', 'parcial')
  `;
  const proximosPagamentosMcfSql = `
    SELECT
      cp.id,
      cp.descricao,
      cp.valor_restante AS valor,
      cp.data_vencimento AS vencimento,
      COALESCE(cp.pessoa_nome, f.nome) AS fornecedor,
      cp.status
    FROM contas_pagar cp
    LEFT JOIN fornecedores f ON f.id = cp.fornecedor_id
    WHERE cp.empresa_id = ?
      AND cp.status IN ('aberto', 'parcial')
      AND cp.data_vencimento IS NOT NULL
      AND date(cp.data_vencimento) BETWEEN date('now') AND date('now', '+30 days')
    ORDER BY cp.data_vencimento ASC
    LIMIT 10
  `;
  const alertasReceberSql = `
    SELECT
      id,
      descricao,
      valor,
      vencimento,
      pessoa_nome AS pessoa,
      tipo,
      status,
      'vencido' AS status_exibicao
    FROM financeiro f
    WHERE tipo = 'receita'
      AND status NOT IN ('recebido','pago','cancelado')
      ${emp.sql}
      AND ${sqlExcluirFinanceiroVendaCancelada('f')}
      AND ${sqlExcluirFinanceiroReceberComContaCanonica('f')}
      ${exclProj}
      AND vencimento IS NOT NULL
      AND vencimento < date('now')
    ORDER BY vencimento ASC
    LIMIT 5
  `;
  const alertasPagarMcfSql = `
    SELECT
      cp.id,
      cp.descricao,
      cp.valor_restante AS valor,
      cp.data_vencimento AS vencimento,
      COALESCE(cp.pessoa_nome, f.nome) AS pessoa,
      'despesa' AS tipo,
      cp.status,
      'vencido' AS status_exibicao
    FROM contas_pagar cp
    LEFT JOIN fornecedores f ON f.id = cp.fornecedor_id
    WHERE cp.empresa_id = ?
      AND cp.status IN ('aberto', 'parcial')
      AND cp.data_vencimento IS NOT NULL
      AND date(cp.data_vencimento) < date('now')
    ORDER BY cp.data_vencimento ASC
    LIMIT 5
  `;

  const graficoSql = `
    SELECT
      COALESCE(SUM(CASE WHEN tipo = 'receita' AND status IN ('recebido','pago') THEN valor END), 0) AS recebido,
      COALESCE(SUM(CASE WHEN tipo = 'receita' AND status NOT IN ('recebido','pago','cancelado') THEN valor END), 0) AS receber
    FROM financeiro f
    WHERE 1 = 1
    ${periodoFiltro}
    AND ${sqlExcluirFinanceiroVendaCancelada('f')}
    AND ${sqlExcluirFinanceiroReceberComContaCanonica('f')}
    ${exclProj}
  `;

  try {
    const empOnly = [emp.param];
    const resumo = await dbGetAsync(resumoSql, params);
    const pendentes = await dbGetAsync(pendentesSql, empOnly);
    const parametrosPeriodoEmpresa = dataInicio && dataFim
      ? [req.empresaId, dataInicio, dataFim]
      : [req.empresaId];
    const crAReceber = await dbGetAsync(crAReceberSql, parametrosPeriodoEmpresa);
    const crRecebido = await dbGetAsync(crRecebidoSql, parametrosPeriodoEmpresa);
    const recebimentosLegados = await dbAllAsync(proximosRecebimentosSql, empOnly);
    const recebimentosCr = await dbAllAsync(`
      SELECT cr.id, cr.venda_id, cr.valor_restante AS valor,
        cr.data_vencimento AS vencimento, NULL AS cliente, cr.status
      FROM contas_receber cr
      WHERE cr.empresa_id = ?
        AND cr.status IN ('aberto', 'parcial')
        AND ${sqlExcluirContaVendaCancelada('cr')}
        AND date(cr.data_vencimento) BETWEEN date('now') AND date('now', '+30 days')
      ORDER BY cr.data_vencimento ASC
      LIMIT 10
    `, empOnly);
    const mcfPagoParams = dataInicio && dataFim
      ? [req.empresaId, dataInicio, dataFim]
      : [req.empresaId];
    const mcfPago = await dbGetAsync(mcfPagoPeriodoSql, mcfPagoParams);
    const mcfAPagar = await dbGetAsync(mcfAPagarSql, [req.empresaId]);
    const proximosPagamentos = await dbAllAsync(proximosPagamentosMcfSql, [req.empresaId]);
    const alertasReceberLegado = await dbAllAsync(alertasReceberSql, empOnly);
    const alertasReceberCr = await dbAllAsync(`
      SELECT cr.id, cr.venda_id, cr.valor_restante AS valor,
        cr.data_vencimento AS vencimento, NULL AS pessoa, cr.status,
        'receita' AS tipo, 'vencido' AS status_exibicao
      FROM contas_receber cr
      WHERE cr.empresa_id = ?
        AND cr.status IN ('aberto', 'parcial')
        AND ${sqlExcluirContaVendaCancelada('cr')}
        AND cr.data_vencimento IS NOT NULL
        AND date(cr.data_vencimento) < date('now')
      ORDER BY cr.data_vencimento ASC
      LIMIT 5
    `, empOnly);
    const alertasPagar = await dbAllAsync(alertasPagarMcfSql, [req.empresaId]);
    const grafico = await dbGetAsync(graficoSql, params);

    const totalRecebido = parseNumber(resumo.totalRecebido) + parseNumber(crRecebido.total);
    const totalPago = parseNumber(resumo.totalPagoHistorico) + parseNumber(mcfPago.total);
    const totalReceber = parseNumber(pendentes.totalReceber) + parseNumber(crAReceber.total);
    const totalPagar = parseNumber(pendentes.totalPagarHistorico) + parseNumber(mcfAPagar.total);
    const proximosRecebimentos = [...recebimentosLegados, ...recebimentosCr]
      .sort((a, b) => String(a.vencimento).localeCompare(String(b.vencimento)))
      .slice(0, 10);
    const alertasReceber = [...alertasReceberLegado, ...alertasReceberCr]
      .sort((a, b) => String(a.vencimento).localeCompare(String(b.vencimento)))
      .slice(0, 5);
    const alertas = [...alertasPagar, ...alertasReceber].slice(0, 10);

    res.json({
      success: true,
      resumo: {
        totalRecebido,
        totalPago,
        totalReceber,
        totalPagar
      },
      proximos_recebimentos: proximosRecebimentos.map(row => ({
        id: row.id,
        descricao: row.descricao,
        valor: parseNumber(row.valor),
        dataVencimento: row.vencimento,
        cliente: row.cliente,
        status: row.status
      })),
      proximos_pagamentos: proximosPagamentos.map(row => ({
        id: row.id,
        descricao: row.descricao,
        valor: parseNumber(row.valor),
        dataVencimento: row.vencimento,
        fornecedor: row.fornecedor,
        status: row.status,
        fonte: 'contas_pagar'
      })),
      alertas: alertas.map(row => ({
        id: row.id,
        descricao: row.descricao,
        valor: parseNumber(row.valor),
        dataVencimento: row.vencimento,
        pessoa: row.pessoa,
        tipo: row.tipo,
        status: row.status_exibicao
      })),
      grafico: {
        recebido: totalRecebido,
        pago: totalPago,
        receber: totalReceber,
        pagar: totalPagar
      }
    });
  } catch (err) {
    console.error('Erro no endpoint dashboard:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/proximos-vencimentos', (req, res) => {
  const hoje = new Date();
  const daqui7dias = new Date(hoje.getTime() + (7 * 24 * 60 * 60 * 1000));

  db.all(`
    SELECT
      id,
      descricao,
      valor,
      vencimento,
      pessoa_nome as cliente,
      tipo,
      JULIANDAY(vencimento) - JULIANDAY('now') as diasRestantes
    FROM financeiro f
    WHERE vencimento IS NOT NULL
      AND status NOT IN ('recebido', 'pago', 'cancelado')
      AND vencimento >= date('now')
      AND vencimento <= date('now', '+30 days')
      AND empresa_id = ?
      AND ${sqlExcluirFinanceiroVendaCancelada('f')}
      ${sqlExcluirProjecaoMcf('f')}
      AND COALESCE(f.status, '') != 'cancelado'
    ORDER BY vencimento ASC
    LIMIT 10
  `, [req.empresaId], (err, rows) => {
    if (err) {
      console.error('Erro na query próximos vencimentos:', err);
      res.status(500).json({ error: err.message });
      return;
    }

    const vencimentos = rows.map(row => ({
      id: row.id,
      descricao: row.descricao,
      valor: parseNumber(row.valor),
      dataVencimento: row.vencimento,
      cliente: row.cliente,
      diasRestantes: Math.ceil(parseNumber(row.diasRestantes))
    }));

    res.json({
      success: true,
      vencimentos: vencimentos
    });
  });
});

router.get('/ultimas-movimentacoes', (req, res) => {
  db.all(`
    SELECT
      id,
      descricao,
      valor,
      data_movimento,
      pessoa_nome as cliente,
      tipo,
      status
    FROM financeiro
    WHERE empresa_id = ?
      ${sqlExcluirProjecaoMcf('')}
    ORDER BY data_movimento DESC
    LIMIT 10
  `, [req.empresaId], (err, rows) => {
    if (err) {
      console.error('Erro na query últimas movimentações:', err);
      res.status(500).json({ error: err.message });
      return;
    }

    const movimentacoes = rows.map(row => ({
      id: row.id,
      descricao: row.descricao,
      valor: parseNumber(row.valor),
      dataMovimento: row.data_movimento,
      cliente: row.cliente,
      tipo: row.tipo,
      status: row.status
    }));

    res.json({
      success: true,
      movimentacoes: movimentacoes
    });
  });
});

function buildReceberQueryFilters(query, empresaId, opcoes = {}) {
  const { dataInicio, dataFim, status, cliente, documento } = query;
  const excluirComContaCanonica = opcoes.excluirComContaCanonica === true;
  const emp = filtroEmpresaSql(empresaId, 'f');

  let sql = `
    SELECT
      f.id,
      f.descricao,
      f.valor,
      f.data_movimento as dataEmissao,
      f.vencimento as dataVencimento,
      COALESCE(f.pessoa_nome, c.nome) as cliente,
      f.status,
      f.observacao,
      f.documento,
      f.numero_parcela,
      f.total_parcelas,
      f.origem,
      f.venda_id,
      f.referencia_id,
      f.referencia_tipo
    FROM financeiro f
    LEFT JOIN clientes c
      ON (
        (f.pessoa_nome IS NOT NULL AND TRIM(f.pessoa_nome) <> '' AND c.nome = f.pessoa_nome)
        OR
        (f.documento IS NOT NULL AND c.cpf_cnpj = f.documento)
      )
    WHERE f.tipo = 'receita'
      ${emp.sql}
      AND ${sqlExcluirFinanceiroVendaCancelada('f')}
  `;

  const params = [emp.param];

  if (excluirComContaCanonica) {
    sql += ` AND ${sqlExcluirFinanceiroReceberComContaCanonica('f')}`;
  }

  if (dataInicio && dataFim) {
    sql += ' AND COALESCE(f.vencimento, f.data_movimento) BETWEEN ? AND ?';
    params.push(dataInicio, dataFim);
  }

  if (status && status !== 'todas') {
    if (status === 'vencidas') {
      sql += " AND f.status NOT IN ('recebido','pago') AND COALESCE(f.vencimento, f.data_movimento) < date('now')";
    } else if (status === 'a_vencer') {
      sql += " AND f.status NOT IN ('recebido','pago') AND COALESCE(f.vencimento, f.data_movimento) >= date('now')";
    } else if (status === 'recebidas') {
      sql += " AND f.status IN ('recebido','pago')";
    } else if (status === 'aberto' || status === 'pendente') {
      sql += " AND f.status NOT IN ('recebido','pago','cancelado','cancelada')";
    } else {
      sql += ' AND f.status = ?';
      params.push(status);
    }
  }

  if (cliente) {
    sql += `
      AND (
        COALESCE(f.pessoa_nome, c.nome, '') LIKE ?
        OR COALESCE(c.cpf_cnpj, '') LIKE ?
      )
    `;
    params.push(`%${cliente}%`, `%${cliente}%`);
  }

  if (documento) {
    sql += ' AND COALESCE(f.documento, "") LIKE ?';
    params.push(`%${documento}%`);
  }

  sql += ' ORDER BY COALESCE(f.vencimento, f.data_movimento) DESC';

  return { sql, params };
}

/**
 * FIN-INT-04 — consulta canônica para união da lista Contas a Receber.
 * Uma linha por registro de contas_receber (componente); saldo = valor_restante.
 */
function buildReceberCanonicoQueryFilters(query, empresaId) {
  const { dataInicio, dataFim, status, cliente, documento } = query;

  // Documento não existe em contas_receber: filtro documento restringe à origem legado.
  if (documento && String(documento).trim() !== '') {
    return { sql: null, params: [] };
  }

  let sql = `
    SELECT
      cr.id,
      cr.venda_id,
      cr.cliente_id,
      cr.numero_parcela,
      cr.total_parcelas,
      cr.componente,
      cr.valor_parcela,
      cr.valor_restante,
      cr.data_vencimento,
      cr.data_pagamento,
      cr.status,
      c.nome AS cliente,
      c.cpf_cnpj AS documento_cliente,
      v.id AS venda_id_validado,
      v.codigo AS venda_codigo
    FROM contas_receber cr
    LEFT JOIN clientes c ON c.id = cr.cliente_id
    LEFT JOIN vendas v
      ON v.id = cr.venda_id
     AND v.empresa_id = cr.empresa_id
    WHERE cr.empresa_id = ?
      AND ${sqlExcluirContaVendaCanceladaDaEmpresa('cr', 'v')}
  `;
  const params = [Number(empresaId)];

  if (dataInicio && dataFim) {
    sql += ' AND date(cr.data_vencimento) BETWEEN date(?) AND date(?)';
    params.push(dataInicio, dataFim);
  }

  if (status && status !== 'todas') {
    if (status === 'vencidas') {
      sql += " AND cr.status IN ('aberto','parcial') AND date(cr.data_vencimento) < date('now')";
    } else if (status === 'a_vencer') {
      sql += " AND cr.status IN ('aberto','parcial') AND date(cr.data_vencimento) >= date('now')";
    } else if (status === 'recebidas') {
      sql += " AND cr.status IN ('recebido','pago')";
    } else if (status === 'aberto' || status === 'pendente') {
      sql += " AND cr.status IN ('aberto','parcial')";
    } else if (status === 'parcial') {
      sql += " AND cr.status = 'parcial'";
    } else {
      sql += ' AND cr.status = ?';
      params.push(status);
    }
  }

  if (cliente) {
    sql += `
      AND (
        COALESCE(c.nome, '') LIKE ?
        OR COALESCE(c.cpf_cnpj, '') LIKE ?
        OR COALESCE(c.telefone, '') LIKE ?
      )
    `;
    params.push(`%${cliente}%`, `%${cliente}%`, `%${cliente}%`);
  }

  sql += ' ORDER BY date(cr.data_vencimento) DESC, cr.id DESC';
  return { sql, params };
}

function mapearStatusExibicaoReceber(statusPersistido, dataVencimento, hoje) {
  const status = statusPersistido == null ? '' : String(statusPersistido);
  const liquidados = ['recebido', 'pago', 'cancelado', 'cancelada'];
  if (!liquidados.includes(status) && dataVencimento && String(dataVencimento) < hoje) {
    return 'vencido';
  }
  return status || '—';
}

function mapearLinhaReceberLegado(row, hoje) {
  const dataVencimento = row.dataVencimento || null;
  return {
    id: row.id,
    fonte: 'financeiro',
    chave: `financeiro:${row.id}`,
    descricao: row.descricao,
    valor: parseNumber(row.valor),
    dataEmissao: row.dataEmissao || null,
    dataVencimento,
    cliente: row.cliente,
    status: mapearStatusExibicaoReceber(row.status, dataVencimento, hoje),
    status_persistido: row.status,
    observacao: row.observacao,
    documento: row.documento,
    numero_parcela: row.numero_parcela,
    total_parcelas: row.total_parcelas,
    origem: row.origem || 'manual',
    venda_id: row.venda_id || (row.referencia_tipo === 'venda' ? row.referencia_id : null) || null,
    cliente_id: null,
    componente: null,
    acoes_disponiveis: ['baixar', 'detalhes', 'editar', 'renegociar', 'cancelar']
  };
}

function mapearLinhaReceberCanonico(row, hoje) {
  const dataVencimento = row.data_vencimento || null;
  const componente = row.componente || 'produtos';
  const rotuloComp = componente === 'outros' ? 'Outros' : 'Produtos';
  const codigoVenda = row.venda_codigo || row.venda_id_validado || '-';
  const statusPersistido = row.status;
  const statusExibicao = mapearStatusExibicaoReceber(statusPersistido, dataVencimento, hoje);
  const podeBaixar = statusPersistido === 'aberto' && parseNumber(row.valor_restante) > 0;
  return {
    id: row.id,
    fonte: 'contas_receber',
    chave: `contas_receber:${row.id}`,
    descricao: `Parcela ${row.numero_parcela || '-'}/${row.total_parcelas || '-'} · ${rotuloComp} · Venda ${codigoVenda}`,
    valor: parseNumber(row.valor_restante),
    valor_parcela: parseNumber(row.valor_parcela),
    dataEmissao: null,
    dataVencimento,
    cliente: row.cliente || null,
    status: statusExibicao,
    status_persistido: statusPersistido,
    observacao: null,
    documento: row.documento_cliente || null,
    numero_parcela: row.numero_parcela,
    total_parcelas: row.total_parcelas,
    origem: 'contas_receber',
    venda_id: row.venda_id || null,
    cliente_id: row.cliente_id || null,
    componente,
    acoes_disponiveis: podeBaixar ? ['baixar', 'detalhes'] : ['detalhes']
  };
}

router.get('/receber', async (req, res) => {
  try {
    const hoje = moment().format('YYYY-MM-DD');
    const legado = buildReceberQueryFilters(req.query, req.empresaId, {
      excluirComContaCanonica: true
    });
    const canonico = buildReceberCanonicoQueryFilters(req.query, req.empresaId);

    const rowsLegado = await dbAllAsync(legado.sql, legado.params);
    const rowsCanonico = canonico.sql
      ? await dbAllAsync(canonico.sql, canonico.params)
      : [];

    const contas = [
      ...rowsLegado.map((row) => mapearLinhaReceberLegado(row, hoje)),
      ...rowsCanonico.map((row) => mapearLinhaReceberCanonico(row, hoje))
    ].sort((a, b) => {
      const da = String(a.dataVencimento || '');
      const dbv = String(b.dataVencimento || '');
      if (da !== dbv) return dbv.localeCompare(da);
      return String(b.chave).localeCompare(String(a.chave));
    });

    res.json({
      success: true,
      uniao: true,
      contas
    });
  } catch (err) {
    console.error('Erro na query receber (união):', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/contas-receber', (req, res) => {
  const { sql, params } = buildReceberQueryFilters(req.query, req.empresaId);

  db.all(sql, params, (err, rows) => {
    if (err) {
      console.error('Erro na query contas receber:', err);
      res.status(500).json({ error: err.message });
      return;
    }

    const hoje = moment().format('YYYY-MM-DD');
    const contas = rows.map(row => {
      let status = row.status;
      if (!['recebido', 'pago'].includes(status) && row.vencimento && row.vencimento < hoje) {
        status = 'vencido';
      }
      return {
        id: row.id,
        descricao: row.descricao,
        valor: parseNumber(row.valor),
        dataEmissao: row.dataEmissao,
        dataVencimento: row.dataVencimento,
        cliente: row.cliente,
        status: status,
        observacao: row.observacao
      };
    });

    res.json({
      success: true,
      contas: contas
    });
  });
});

router.get('/receber/agrupado', async (req, res) => {
  try {
    const { cliente, status, dataInicio, dataFim } = req.query;

    let sql = `
      SELECT
        c.id as cliente_id,
        c.nome as nome_cliente,
        COALESCE(c.cpf_cnpj, '') as cpf,
        COALESCE(c.telefone, '') as telefone,
        COUNT(DISTINCT v.id) as quantidade_vendas,
        COUNT(cr.id) as quantidade_titulos,
        COALESCE(SUM(CASE WHEN cr.status IN ('aberto','parcial') THEN cr.valor_restante ELSE 0 END), 0) as total_divida,
        COALESCE(SUM(CASE WHEN cr.status = 'recebido' THEN cr.valor_parcela ELSE 0 END), 0) as total_pago,
        COALESCE(SUM(CASE WHEN cr.status IN ('aberto','parcial') AND date(cr.data_vencimento) < date('now') THEN 1 ELSE 0 END), 0) as vencidas,
        COALESCE(SUM(CASE WHEN cr.status IN ('aberto','parcial') AND date(cr.data_vencimento) >= date('now') THEN 1 ELSE 0 END), 0) as a_vencer
      FROM clientes c
      JOIN contas_receber cr ON cr.cliente_id = c.id
      LEFT JOIN vendas v
        ON v.id = cr.venda_id
       AND v.empresa_id = cr.empresa_id
      WHERE cr.status IN ('aberto','parcial')
        AND cr.empresa_id = ?
        AND ${sqlExcluirContaVendaCanceladaDaEmpresa('cr', 'v')}
    `;

    const params = [req.empresaId];

    if (cliente) {
      sql += ` AND (c.nome LIKE ? OR c.cpf_cnpj LIKE ? OR c.telefone LIKE ?)`;
      params.push(`%${cliente}%`, `%${cliente}%`, `%${cliente}%`);
    }

    if (dataInicio && dataFim) {
      sql += ' AND date(cr.data_vencimento) BETWEEN ? AND ?';
      params.push(dataInicio, dataFim);
    }

    if (status && status !== 'todas') {
      if (status === 'vencidas') {
        sql += " AND date(cr.data_vencimento) < date('now')";
      } else if (status === 'a_vencer') {
        sql += " AND date(cr.data_vencimento) >= date('now')";
      }
    }

    sql += ' GROUP BY c.id, c.nome, c.cpf_cnpj, c.telefone';
    sql += ' ORDER BY c.nome ASC';

    const rows = await dbAllAsync(sql, params);

    const clientes = rows.map(row => ({
      cliente_id: row.cliente_id,
      nome_cliente: row.nome_cliente,
      cpf: row.cpf,
      telefone: row.telefone,
      quantidade_vendas: parseNumber(row.quantidade_vendas),
      quantidade_titulos: parseNumber(row.quantidade_titulos),
      total_divida: parseNumber(row.total_divida),
      total_pago: parseNumber(row.total_pago),
      saldo_atual: parseNumber(row.total_divida),
      vencidas: parseNumber(row.vencidas),
      a_vencer: parseNumber(row.a_vencer)
    }));

    res.json({ success: true, clientes });
  } catch (err) {
    console.error('Erro ao listar dívida agrupada:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/receber/agrupado/:clienteId', async (req, res) => {
  try {
    const { clienteId } = req.params;

    const cliente = await dbGetAsync(`
      SELECT
        id,
        nome,
        cpf_cnpj AS cpf,
        telefone,
        endereco,
        rua,
        numero,
        bairro,
        cidade,
        uf,
        cep
      FROM clientes
      WHERE id = ?
        AND EXISTS (
          SELECT 1
          FROM contas_receber cr
          WHERE cr.cliente_id = clientes.id
            AND cr.empresa_id = ?
        )
    `, [clienteId, req.empresaId]);

    if (!cliente) {
      return res.status(404).json({ success: false, error: 'Cliente não encontrado' });
    }

    const endereco = cliente.endereco || [cliente.rua, cliente.numero, cliente.bairro, cliente.cidade, cliente.uf, cliente.cep]
      .filter(Boolean)
      .join(', ');

    const contas = await dbAllAsync(`
      SELECT
        cr.id AS conta_receber_id,
        cr.venda_id,
        v.codigo AS numero_venda,
        v.data_venda,
        v.total AS valor_total,
        cr.numero_parcela,
        cr.total_parcelas,
        cr.componente,
        cr.valor_parcela,
        cr.valor_restante,
        cr.data_vencimento,
        cr.status
      FROM contas_receber cr
      JOIN vendas v
        ON v.id = cr.venda_id
       AND v.empresa_id = cr.empresa_id
      WHERE cr.cliente_id = ? AND cr.status IN ('aberto', 'parcial')
        AND cr.empresa_id = ?
        AND ${sqlExcluirContaVendaCanceladaDaEmpresa('cr', 'v')}
      ORDER BY v.data_venda ASC, cr.data_vencimento ASC
    `, [clienteId, req.empresaId]);

    const vendaIds = [...new Set(contas.map(conta => conta.venda_id))];

    let produtos = [];
    if (vendaIds.length > 0) {
      const placeholders = vendaIds.map(() => '?').join(',');
      produtos = await dbAllAsync(`
        SELECT
          vi.venda_id,
          vi.produto_id,
          p.nome AS nome_produto,
          vi.quantidade,
          vi.quantidade_fiscal,
          vi.quantidade_nao_fiscal,
          vi.valor_fiscal,
          vi.valor_nao_fiscal,
          vi.preco_unitario,
          vi.subtotal
        FROM vendas_itens vi
        JOIN vendas v
          ON v.id = vi.venda_id
         AND v.empresa_id = ?
        LEFT JOIN produtos p ON p.id = vi.produto_id
        WHERE vi.venda_id IN (${placeholders})
      `, [req.empresaId, ...vendaIds]);
    }

    const vendasMap = new Map();
    contas.forEach(conta => {
      if (!vendasMap.has(conta.venda_id)) {
        vendasMap.set(conta.venda_id, {
          venda_id: conta.venda_id,
          numero_venda: conta.numero_venda,
          data_venda: conta.data_venda,
          valor_total: parseNumber(conta.valor_total),
          valor_pago: 0,
          saldo_aberto: 0,
          data_vencimento: conta.data_vencimento,
          status: conta.status,
          parcelas: [],
          produtos: []
        });
      }

      const venda = vendasMap.get(conta.venda_id);
      venda.parcelas.push({
        conta_receber_id: conta.conta_receber_id,
        parcela: `${conta.numero_parcela || '-'} / ${conta.total_parcelas || '-'}`,
        componente: conta.componente || 'produtos',
        valor_parcela: parseNumber(conta.valor_parcela),
        valor_restante: parseNumber(conta.valor_restante),
        vencimento: conta.data_vencimento,
        status: conta.status
      });

      venda.saldo_aberto += parseNumber(conta.valor_restante);
      venda.valor_pago += parseNumber(conta.valor_parcela) - parseNumber(conta.valor_restante);

      if (!venda.data_vencimento || (conta.data_vencimento && conta.data_vencimento < venda.data_vencimento)) {
        venda.data_vencimento = conta.data_vencimento;
      }

      if (conta.status === 'vencido') {
        venda.status = 'vencido';
      } else if (venda.status !== 'vencido' && conta.status === 'parcial') {
        venda.status = 'parcial';
      }
    });

    produtos.forEach(prod => {
      const venda = vendasMap.get(prod.venda_id);
      if (venda) {
        venda.produtos.push({
          produto_id: prod.produto_id,
          nome_produto: prod.nome_produto,
          quantidade: parseNumber(prod.quantidade),
          quantidade_fiscal: parseNumber(prod.quantidade_fiscal),
          quantidade_nao_fiscal: parseNumber(prod.quantidade_nao_fiscal),
          valor_fiscal: parseNumber(prod.valor_fiscal),
          valor_nao_fiscal: parseNumber(prod.valor_nao_fiscal),
          preco_unitario: parseNumber(prod.preco_unitario),
          subtotal: parseNumber(prod.subtotal)
        });
      }
    });

    const vendas = Array.from(vendasMap.values()).map(venda => ({
      ...venda,
      data_vencimento: venda.data_vencimento,
      status: venda.status || 'aberto'
    }));

    const totalDivida = contas.reduce((sum, conta) => sum + parseNumber(conta.valor_parcela), 0);
    const totalPago = contas.reduce((sum, conta) => sum + (parseNumber(conta.valor_parcela) - parseNumber(conta.valor_restante)), 0);
    const saldoAtual = contas.reduce((sum, conta) => sum + parseNumber(conta.valor_restante), 0);
    const quantidadeVendas = new Set(contas.map(conta => conta.venda_id)).size;
    const quantidadeTitulos = contas.length;
    const vencidas = contas.filter(conta => conta.status !== 'recebido' && conta.data_vencimento && conta.data_vencimento < moment().format('YYYY-MM-DD')).length;
    const aVencer = contas.filter(conta => conta.status !== 'recebido' && conta.data_vencimento && conta.data_vencimento >= moment().format('YYYY-MM-DD')).length;

    res.json({
      success: true,
      cliente: {
        id: cliente.id,
        nome: cliente.nome,
        cpf: cliente.cpf,
        telefone: cliente.telefone,
        endereco: endereco
      },
      resumo: {
        totalDivida: parseNumber(totalDivida),
        totalPago: parseNumber(totalPago),
        saldoAtual: parseNumber(saldoAtual),
        quantidadeVendas,
        quantidadeTitulos,
        vencidas,
        aVencer
      },
      vendas
    });
  } catch (err) {
    console.error('Erro ao buscar duplicata agrupada:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/receber/agrupado/:clienteId/extrato', async (req, res) => {
  try {
    const meta = await obterMetaEmpresaPorId(req.empresaId, { db });
    const empresa = {
      nome: meta.empresa_nome || '',
      cnpj: meta.empresa_cnpj || '',
      telefone: '',
      endereco: ''
    };

    const clienteId = req.params.clienteId;

    const cliente = await dbGetAsync(`
      SELECT id, nome, cpf_cnpj AS cpf, telefone, endereco, rua, numero, bairro, cidade, uf, cep
      FROM clientes
      WHERE id = ?
        AND EXISTS (
          SELECT 1
          FROM contas_receber cr
          WHERE cr.cliente_id = clientes.id
            AND cr.empresa_id = ?
        )
    `, [clienteId, req.empresaId]);

    if (!cliente) {
      return res.status(404).json({ success: false, error: 'Cliente não encontrado' });
    }

    const endereco = cliente.endereco || [cliente.rua, cliente.numero, cliente.bairro, cliente.cidade, cliente.uf, cliente.cep]
      .filter(Boolean)
      .join(', ');

    const contas = await dbAllAsync(`
      SELECT
        cr.id AS conta_receber_id,
        cr.venda_id,
        v.codigo AS numero_venda,
        v.data_venda,
        v.total AS valor_total,
        cr.numero_parcela,
        cr.total_parcelas,
        cr.componente,
        cr.valor_parcela,
        cr.valor_restante,
        cr.data_vencimento,
        cr.status
      FROM contas_receber cr
      JOIN vendas v
        ON v.id = cr.venda_id
       AND v.empresa_id = cr.empresa_id
      WHERE cr.cliente_id = ?
        AND cr.empresa_id = ?
      ORDER BY v.data_venda ASC, cr.data_vencimento ASC
    `, [clienteId, req.empresaId]);

    const vendaIds = [...new Set(contas.map(conta => conta.venda_id))];
    let produtos = [];
    if (vendaIds.length > 0) {
      const placeholders = vendaIds.map(() => '?').join(',');
      produtos = await dbAllAsync(`
        SELECT
          vi.venda_id,
          vi.produto_id,
          p.nome AS nome_produto,
          vi.quantidade,
          vi.quantidade_fiscal,
          vi.quantidade_nao_fiscal,
          vi.valor_fiscal,
          vi.valor_nao_fiscal,
          vi.preco_unitario,
          vi.subtotal
        FROM vendas_itens vi
        JOIN vendas v
          ON v.id = vi.venda_id
         AND v.empresa_id = ?
        LEFT JOIN produtos p ON p.id = vi.produto_id
        WHERE vi.venda_id IN (${placeholders})
      `, [req.empresaId, ...vendaIds]);
    }

    const vendasMap = new Map();
    contas.forEach(conta => {
      if (!vendasMap.has(conta.venda_id)) {
        vendasMap.set(conta.venda_id, {
          venda_id: conta.venda_id,
          numero_venda: conta.numero_venda,
          data_venda: conta.data_venda,
          valor_total: parseNumber(conta.valor_total),
          valor_pago: 0,
          saldo_aberto: 0,
          data_vencimento: conta.data_vencimento,
          status: conta.status,
          parcelas: [],
          produtos: []
        });
      }
      const venda = vendasMap.get(conta.venda_id);
      venda.parcelas.push({
        conta_receber_id: conta.conta_receber_id,
        parcela: `${conta.numero_parcela || '-'} / ${conta.total_parcelas || '-'}`,
        valor_parcela: parseNumber(conta.valor_parcela),
        valor_restante: parseNumber(conta.valor_restante),
        vencimento: conta.data_vencimento,
        status: conta.status
      });
      venda.saldo_aberto += parseNumber(conta.valor_restante);
      venda.valor_pago += parseNumber(conta.valor_parcela) - parseNumber(conta.valor_restante);
      if (conta.status === 'vencido') {
        venda.status = 'vencido';
      } else if (venda.status !== 'vencido' && conta.status === 'parcial') {
        venda.status = 'parcial';
      }
      if (!venda.data_vencimento || (conta.data_vencimento && conta.data_vencimento < venda.data_vencimento)) {
        venda.data_vencimento = conta.data_vencimento;
      }
    });

    produtos.forEach(prod => {
      const venda = vendasMap.get(prod.venda_id);
      if (venda) {
        venda.produtos.push({
          produto_id: prod.produto_id,
          nome_produto: prod.nome_produto,
          quantidade: parseNumber(prod.quantidade),
          quantidade_fiscal: parseNumber(prod.quantidade_fiscal),
          quantidade_nao_fiscal: parseNumber(prod.quantidade_nao_fiscal),
          valor_fiscal: parseNumber(prod.valor_fiscal),
          valor_nao_fiscal: parseNumber(prod.valor_nao_fiscal),
          preco_unitario: parseNumber(prod.preco_unitario),
          subtotal: parseNumber(prod.subtotal)
        });
      }
    });

    const vendas = Array.from(vendasMap.values());
    const totalDivida = contas.reduce((sum, conta) => sum + parseNumber(conta.valor_parcela), 0);
    const totalPago = contas.reduce((sum, conta) => sum + (parseNumber(conta.valor_parcela) - parseNumber(conta.valor_restante)), 0);
    const saldoAtual = contas.reduce((sum, conta) => sum + parseNumber(conta.valor_restante), 0);
    const quantidadeVendas = new Set(contas.map(conta => conta.venda_id)).size;
    const quantidadeTitulos = contas.length;
    const vencidas = contas.filter(conta => conta.status !== 'recebido' && conta.data_vencimento && conta.data_vencimento < moment().format('YYYY-MM-DD')).length;
    const aVencer = contas.filter(conta => conta.status !== 'recebido' && conta.data_vencimento && conta.data_vencimento >= moment().format('YYYY-MM-DD')).length;

    res.json({
      success: true,
      empresa,
      cliente: {
        id: cliente.id,
        nome: cliente.nome,
        cpf: cliente.cpf,
        telefone: cliente.telefone,
        endereco: endereco
      },
      resumo: {
        totalDivida: parseNumber(totalDivida),
        totalPago: parseNumber(totalPago),
        saldoAtual: parseNumber(saldoAtual),
        quantidadeVendas,
        quantidadeTitulos,
        vencidas,
        aVencer
      },
      vendas,
      geradoEm: moment().format('YYYY-MM-DD HH:mm:ss')
    });
  } catch (err) {
    console.error('Erro ao gerar extrato de duplicata:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/receber/agrupado/:clienteId/pagamentos', async (req, res) => {
  try {
    const clienteId = req.params.clienteId;
    const rows = await dbAllAsync(`
      SELECT
        crp.id,
        crp.valor_pago,
        crp.data_pagamento,
        crp.forma_pagamento,
        crp.observacao,
        crp.created_at,
        cr.id AS conta_receber_id,
        v.codigo as venda_codigo,
        cr.numero_parcela,
        cr.total_parcelas
      FROM contas_receber_pagamentos crp
      JOIN contas_receber cr ON cr.id = crp.conta_receber_id
      JOIN vendas v
        ON v.id = cr.venda_id
       AND v.empresa_id = cr.empresa_id
      WHERE crp.cliente_id = ?
        AND cr.empresa_id = ?
      ORDER BY crp.data_pagamento DESC, crp.created_at DESC
    `, [clienteId, req.empresaId]);

    const pagamentos = rows.map(row => ({
      id: row.id,
      valor_pago: parseNumber(row.valor_pago),
      data_pagamento: row.data_pagamento,
      forma_pagamento: row.forma_pagamento,
      observacao: row.observacao,
      created_at: row.created_at,
      conta_receber_id: row.conta_receber_id,
      venda_codigo: row.venda_codigo,
      parcela: `${row.numero_parcela}/${row.total_parcelas}`
    }));

    res.json({ success: true, pagamentos });
  } catch (err) {
    console.error('Erro ao buscar histórico de pagamentos:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/receber/agrupado/:clienteId/pagamento-parcial', async (req, res) => {
  try {
    const clienteId = req.params.clienteId;
    const { valor, data_pagamento, forma_pagamento, observacao } = req.body;
    const valorPago = arredondarCentavos(valor);

    if (valorPago <= 0) {
      return res.status(400).json({ success: false, error: 'Valor deve ser maior que zero' });
    }

    if (!data_pagamento) {
      return res.status(400).json({ success: false, error: 'Data do pagamento é obrigatória' });
    }

    const cliente = await dbGetAsync('SELECT id, nome FROM clientes WHERE id = ?', [clienteId]);
    if (!cliente) {
      return res.status(404).json({ success: false, error: 'Cliente não encontrado' });
    }

    const contas = await dbAllAsync(`
      SELECT
        cr.id,
        cr.venda_id,
        cr.valor_parcela,
        cr.valor_restante,
        cr.data_vencimento,
        cr.numero_parcela,
        cr.total_parcelas,
        cr.empresa_id,
        v.codigo AS numero_venda,
        v.empresa_id AS venda_empresa_id
      FROM contas_receber cr
      LEFT JOIN vendas v ON v.id = cr.venda_id
      WHERE cr.cliente_id = ? AND cr.status IN ('aberto','parcial')
        AND cr.empresa_id = ?
        AND ${sqlExcluirContaVendaCancelada('cr')}
      ORDER BY cr.data_vencimento ASC, cr.id ASC
    `, [clienteId, req.empresaId]);

    if (!contas.length) {
      return res.status(400).json({ success: false, error: 'Cliente não possui contas em aberto' });
    }

    const totalAberto = arredondarCentavos(
      contas.reduce((sum, conta) => sum + arredondarCentavos(conta.valor_restante), 0)
    );

    if (valorPago > totalAberto + 0.009) {
      return res.status(400).json({
        success: false,
        error: `Valor informado (${valorPago.toFixed(2)}) é maior que o total em aberto (${totalAberto.toFixed(2)})`
      });
    }

    const pagamentosRealizados = await new Promise((resolve, reject) => {
      db.serialize(() => {
        db.run('BEGIN IMMEDIATE');

        let contasValidadas;
        try {
          contasValidadas = contas.map(conta => {
            if (Number(conta.empresa_id) !== Number(req.empresaId)) {
              const err = new Error('A conta a receber não pertence à empresa ativa.');
              err.code = 'FINANCEIRO_EMPRESA_DIVERGENTE';
              err.statusCode = 409;
              throw err;
            }

            if (
              conta.venda_id != null &&
              (!Number.isInteger(Number(conta.venda_empresa_id)) || Number(conta.venda_empresa_id) <= 0)
            ) {
              const err = new Error('A empresa da venda vinculada não pôde ser validada.');
              err.code = 'FINANCEIRO_EMPRESA_OBRIGATORIA';
              err.statusCode = 400;
              throw err;
            }

            const empresaIdFin = resolverEmpresaDaOrigemFinanceira({
              venda: conta.venda_id == null
                ? null
                : { empresa_id: conta.venda_empresa_id },
              empresaId: req.empresaId
            });
            return { ...conta, empresaIdFin };
          });
        } catch (ownErr) {
          db.run('ROLLBACK', () => reject(ownErr));
          return;
        }

        let valorRestantePagamento = arredondarCentavos(valorPago);
        const pagamentos = [];

        const processarConta = (index) => {
          if (index >= contasValidadas.length || valorRestantePagamento <= 0) {
            db.run(`
              UPDATE vendas
              SET status_pagamento = 'quitada'
              WHERE empresa_id = ?
                AND status_pagamento IN ('pendente', 'aguardando_nao_fiscal')
                AND EXISTS (
                  SELECT 1 FROM contas_receber cr
                  WHERE cr.venda_id = vendas.id AND cr.empresa_id = vendas.empresa_id
                )
                AND NOT EXISTS (
                  SELECT 1 FROM contas_receber cr
                  WHERE cr.venda_id = vendas.id
                    AND cr.empresa_id = vendas.empresa_id
                    AND COALESCE(cr.status, 'aberto') NOT IN ('pago', 'recebido')
                )
            `, [req.empresaId], (statusErr) => {
              if (statusErr) {
                db.run('ROLLBACK');
                reject(statusErr);
                return;
              }

              db.run('COMMIT', (err) => {
              if (err) {
                db.run('ROLLBACK');
                reject(err);
              } else {
                resolve(pagamentos);
              }
            });
            });
            return;
          }

          const conta = contasValidadas[index];
          const saldoAtualConta = parseNumber(conta.valor_restante);
          const valorAbater = Math.min(saldoAtualConta, valorRestantePagamento);

          if (valorAbater <= 0) {
            processarConta(index + 1);
            return;
          }

          db.run(`
            INSERT INTO contas_receber_pagamentos (
              conta_receber_id,
              cliente_id,
              valor_pago,
              data_pagamento,
              forma_pagamento,
              observacao
            ) VALUES (?, ?, ?, ?, ?, ?)
          `, [
            conta.id,
            clienteId,
            valorAbater,
            data_pagamento,
            forma_pagamento || 'dinheiro',
            observacao || `Pagamento parcial - Venda ${conta.venda_id}`
          ], function(err) {
            if (err) {
              db.run('ROLLBACK');
              reject(err);
              return;
            }

            const novoSaldo = saldoAtualConta - valorAbater;
            const novoStatus = novoSaldo <= 0 ? 'recebido' : 'parcial';
            const dataPagamentoFinal = novoSaldo <= 0 ? data_pagamento : null;

            db.run(`
              UPDATE contas_receber
              SET valor_restante = ?, status = ?, data_pagamento = ?
              WHERE id = ?
                AND empresa_id = ?
                AND status IN ('aberto', 'parcial')
                AND CAST(ROUND(valor_restante * 100) AS INTEGER) = ?
            `, [
              novoSaldo,
              novoStatus,
              dataPagamentoFinal,
              conta.id,
              req.empresaId,
              Math.round(saldoAtualConta * 100)
            ], function(err) {
              if (err || this.changes !== 1) {
                db.run('ROLLBACK');
                const updateErr = err || new Error('A parcela mudou durante o pagamento.');
                if (!err) updateErr.statusCode = 409;
                reject(updateErr);
                return;
              }

              const descricaoFinanceiro = `Recebimento venda #${conta.numero_venda || conta.venda_id} - Parcela ${conta.numero_parcela || '-'} / ${conta.total_parcelas || '-'}`;
              const empresaIdFin = conta.empresaIdFin;

              db.get(`
                SELECT id
                FROM financeiro
                WHERE tipo = 'receita'
                  AND referencia_tipo = 'venda'
                  AND referencia_id = ?
                  AND numero_parcela = ?
                  AND empresa_id = ?
                ORDER BY id DESC
                LIMIT 1
              `, [conta.venda_id, conta.numero_parcela || null, empresaIdFin], (err, movFinanceiro) => {
                if (err) {
                  db.run('ROLLBACK');
                  reject(err);
                  return;
                }

                if (movFinanceiro) {
                  db.get(`
                    SELECT CASE
                      WHEN SUM(CASE WHEN COALESCE(status, 'aberto') NOT IN ('pago', 'recebido') THEN 1 ELSE 0 END) = 0
                        THEN 'recebido'
                      WHEN SUM(CASE WHEN valor_restante < valor_parcela THEN 1 ELSE 0 END) > 0
                        THEN 'parcial'
                      ELSE 'pendente'
                    END AS status
                    FROM contas_receber
                    WHERE venda_id = ? AND numero_parcela = ? AND empresa_id = ?
                  `, [conta.venda_id, conta.numero_parcela, empresaIdFin], (statusErr, statusRow) => {
                    if (statusErr || !statusRow) {
                      db.run('ROLLBACK');
                      reject(statusErr || new Error('Não foi possível reconciliar a parcela financeira.'));
                      return;
                    }

                    const statusFinanceiro = statusRow.status;
                    db.run(`
                      UPDATE financeiro
                      SET
                        status = ?,
                        forma_pagamento = ?,
                        observacao = ?,
                        pessoa_nome = ?,
                        baixado_em = CASE WHEN ? = 'recebido' THEN ? ELSE NULL END,
                        data_movimento = CASE WHEN ? = 'recebido' THEN ? ELSE data_movimento END,
                        vencimento = CASE WHEN ? = 'recebido' THEN ? ELSE vencimento END
                      WHERE id = ? AND empresa_id = ?
                    `, [
                      statusFinanceiro,
                      forma_pagamento || 'dinheiro',
                      observacao || `Pagamento parcial registrado em ${data_pagamento}`,
                      cliente.nome || null,
                      statusFinanceiro,
                      data_pagamento,
                      statusFinanceiro,
                      data_pagamento,
                      statusFinanceiro,
                      data_pagamento,
                      movFinanceiro.id,
                      empresaIdFin
                    ], (financeiroErr) => {
                      if (financeiroErr) {
                        db.run('ROLLBACK');
                        reject(financeiroErr);
                        return;
                      }

                      pagamentos.push({
                        conta_receber_id: conta.id,
                        venda_id: conta.venda_id,
                        valor_pago: valorAbater,
                        saldo_restante: novoSaldo,
                        status: novoStatus
                      });

                      valorRestantePagamento -= valorAbater;
                      processarConta(index + 1);
                    });
                  });
                } else {
                  db.run(`
                    INSERT INTO financeiro (
                      tipo,
                      descricao,
                      valor,
                      data_movimento,
                      categoria,
                      forma_pagamento,
                      referencia_id,
                      referencia_tipo,
                      status,
                      origem,
                      documento,
                      vencimento,
                      numero_parcela,
                      total_parcelas,
                      venda_id,
                      pessoa_nome,
                      observacao,
                      baixado_em,
                      empresa_id
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                  `, [
                    'receita',
                    descricaoFinanceiro,
                    parseNumber(conta.valor_parcela),
                    data_pagamento,
                    'vendas',
                    forma_pagamento || 'dinheiro',
                    conta.venda_id,
                    'venda',
                    novoStatus,
                    'duplicata',
                    null,
                    novoStatus === 'recebido' ? data_pagamento : conta.data_vencimento,
                    conta.numero_parcela || null,
                    conta.total_parcelas || null,
                    conta.venda_id,
                    cliente.nome || null,
                    observacao || `Pagamento parcial registrado em ${data_pagamento}`,
                    novoStatus === 'recebido' ? data_pagamento : null,
                    empresaIdFin
                  ], (err) => {
                    if (err) {
                      db.run('ROLLBACK');
                      reject(err);
                      return;
                    }

                    pagamentos.push({
                      conta_receber_id: conta.id,
                      venda_id: conta.venda_id,
                      valor_pago: valorAbater,
                      saldo_restante: novoSaldo,
                      status: novoStatus
                    });

                    valorRestantePagamento -= valorAbater;
                    processarConta(index + 1);
                  });
                }
              });
            });
          });
        };

        processarConta(0);
      });
    });

    res.json({
      success: true,
      message: 'Pagamento parcial realizado com sucesso',
      pagamentosRealizados
    });
  } catch (err) {
    console.error('Erro ao processar pagamento parcial:', err);
    const status = statusDeErroEmpresa(err);
    res.status(status === 500 && !err.code ? 500 : status).json({
      success: false,
      error: err.message,
      code: err.code
    });
  }
});

function buildPagarQueryFilters(query, empresaId) {
  const { dataInicio, dataFim, status, fornecedor } = query;
  const emp = filtroEmpresaSql(empresaId, 'f');

  let sql = `
    SELECT
      f.id,
      f.descricao,
      f.valor,
      f.data_movimento AS dataEmissao,
      f.vencimento AS dataVencimento,
      COALESCE(f.pessoa_nome, forn.nome) AS fornecedor,
      COALESCE(f.documento, '') AS documento,
      f.status,
      f.observacao,
      f.categoria,
      f.origem
    FROM financeiro f
    LEFT JOIN fornecedores forn
      ON (
        (f.pessoa_nome IS NOT NULL AND TRIM(f.pessoa_nome) <> '' AND forn.nome = f.pessoa_nome)
      )
    WHERE f.tipo = 'despesa'
      ${emp.sql}
      ${sqlExcluirProjecaoMcf('f')}
  `;

  const params = [emp.param];

  if (dataInicio && dataFim) {
    sql += ' AND COALESCE(f.vencimento, f.data_movimento) BETWEEN ? AND ?';
    params.push(dataInicio, dataFim);
  }

  if (status && status !== 'todos' && status !== 'todas') {
    if (status === 'vencido') {
      sql += " AND f.status NOT IN ('pago','recebido') AND COALESCE(f.vencimento, f.data_movimento) < date('now')";
    } else if (status === 'a_vencer') {
      sql += " AND f.status NOT IN ('pago','recebido') AND COALESCE(f.vencimento, f.data_movimento) >= date('now')";
    } else if (status === 'pago') {
      sql += " AND f.status IN ('pago','recebido')";
    } else if (status === 'pendente') {
      sql += " AND f.status = 'pendente' AND COALESCE(f.vencimento, f.data_movimento) >= date('now')";
    } else {
      sql += ' AND f.status = ?';
      params.push(status);
    }
  }

  if (fornecedor) {
    sql += `
      AND (
        COALESCE(f.pessoa_nome, forn.nome, '') LIKE ?
        OR COALESCE(f.documento, '') LIKE ?
        OR COALESCE(forn.cpf_cnpj, '') LIKE ?
      )
    `;
    params.push(`%${fornecedor}%`, `%${fornecedor}%`, `%${fornecedor}%`);
  }

  sql += ' ORDER BY COALESCE(f.vencimento, f.data_movimento) DESC, f.id DESC';

  return { sql, params };
}

router.get('/pagar', (req, res) => {
  const { sql, params } = buildPagarQueryFilters(req.query, req.empresaId);

  db.all(sql, params, (err, rows) => {
    if (err) {
      console.error('Erro na query pagar:', err);
      res.status(500).json({ error: err.message });
      return;
    }

    const hoje = moment().format('YYYY-MM-DD');
    const contas = rows.map(row => {
      let status = row.status;
      if (!['recebido', 'pago'].includes(status) && row.vencimento && row.vencimento < hoje) {
        status = 'vencido';
      }
      return {
        id: row.id,
        descricao: row.descricao,
        valor: parseNumber(row.valor),
        dataEmissao: row.dataEmissao,
        dataVencimento: row.dataVencimento,
        fornecedor: row.fornecedor,
        categoria: row.categoria,
        status: status,
        observacao: row.observacao,
        documento: row.documento,
        numero_parcela: row.numero_parcela,
        total_parcelas: row.total_parcelas,
        origem: row.origem
      };
    });

    res.json({
      success: true,
      contas: contas
    });
  });
});

router.get('/contas-pagar', (req, res) => {
  const { sql, params } = buildPagarQueryFilters(req.query, req.empresaId);

  db.all(sql, params, (err, rows) => {
    if (err) {
      console.error('Erro ao carregar contas a pagar:', err);
      return res.status(500).json({
        success: false,
        error: err.message
      });
    }

    const hoje = moment().format('YYYY-MM-DD');

    const contas = (rows || []).map(row => {
      let statusFinal = row.status || 'pendente';

      if (
        !['pago', 'recebido'].includes(statusFinal) &&
        row.dataVencimento &&
        row.dataVencimento < hoje
      ) {
        statusFinal = 'vencido';
      }

      return {
        id: row.id,
        fornecedor: row.fornecedor || '-',
        descricao: row.descricao || '',
        documento: row.documento || '',
        valor: Number(row.valor || 0),
        dataEmissao: row.dataEmissao || null,
        dataVencimento: row.dataVencimento || null,
        status: statusFinal,
        categoria: row.categoria || '',
        observacao: row.observacao || '',
        origem: row.origem || ''
      };
    });

    return res.json({
      success: true,
      contas
    });
  });
});

// ========== RELATÓRIOS ==========

// Relatório de Resumo Financeiro
router.get('/relatorios/resumo', async (req, res) => {
  const { dataInicio, dataFim, modo_fiscal } = req.query;
  const emp = filtroEmpresaSql(req.empresaId);

  let sql = `
    SELECT
      tipo,
      status,
      SUM(valor) as total,
      COUNT(*) as quantidade
    FROM financeiro f
    WHERE 1=1
      ${emp.sql}
      AND ${sqlExcluirFinanceiroVendaCancelada('f')}
      ${sqlExcluirProjecaoMcf('f')}
      AND COALESCE(f.status, '') != 'cancelado'
  `;

  const params = [emp.param];

  if (dataInicio && dataFim) {
    sql += ' AND data_movimento BETWEEN ? AND ?';
    params.push(dataInicio, dataFim);
  }

  sql += ' GROUP BY tipo, status ORDER BY tipo, status';

  try {
    const rows = await dbAllAsync(sql, params);
    const recebimentosVenda = await consultarRecebimentosVendaSplit(
      dataInicio,
      dataFim,
      modo_fiscal,
      req.empresaId
    );

    const resumo = {
      receitas: {
        total: 0,
        recebidas: 0,
        pendentes: 0,
        quantidade: 0
      },
      despesas: {
        total: 0,
        pagas: 0,
        pendentes: 0,
        quantidade: 0
      }
    };

    rows.forEach(row => {
      const valor = parseNumber(row.total);
      if (row.tipo === 'receita') {
        resumo.receitas.total += valor;
        resumo.receitas.quantidade += row.quantidade;
        if (row.status === 'recebido') {
          resumo.receitas.recebidas += valor;
        } else {
          resumo.receitas.pendentes += valor;
        }
      } else if (row.tipo === 'despesa') {
        resumo.despesas.total += valor;
        resumo.despesas.quantidade += row.quantidade;
        if (row.status === 'pago') {
          resumo.despesas.pagas += valor;
        } else {
          resumo.despesas.pendentes += valor;
        }
      }
    });

    res.json({
      success: true,
      modo_fiscal_ativo: recebimentosVenda.modo_fiscal_ativo,
      resumo,
      recebimentos_venda: {
        fiscal: recebimentosVenda.fiscal,
        nao_fiscal: recebimentosVenda.nao_fiscal,
        total: recebimentosVenda.total
      },
      periodo: { dataInicio, dataFim }
    });
  } catch (err) {
    console.error('Erro no relatório resumo:', err);
    res.status(500).json({ error: err.message });
  }
});

// Relatório de Contas a Receber
router.get('/relatorios/receber', async (req, res) => {
  const { dataInicio, dataFim, status, cliente, modo_fiscal } = req.query;
  const modoFiscalAtivo = isModoFiscalRelatorio(modo_fiscal);
  const sqlDataLegado = 'date(COALESCE(f.vencimento, f.data_movimento))';
  const sqlDataCanonica = 'date(cr.data_vencimento)';
  const paramsLegado = [req.empresaId];
  const paramsCanonicos = [req.empresaId];
  let filtrosLegado = `
    f.tipo = 'receita'
    AND f.empresa_id = ?
    AND ${sqlExcluirFinanceiroVendaCancelada('f')}
    AND ${sqlExcluirFinanceiroReceberComContaCanonica('f')}
  `;
  let filtrosCanonicos = `
    cr.empresa_id = ?
    AND (
      cr.venda_id IS NULL
      OR v.id IS NULL
      OR (
        COALESCE(v.cancelada, 0) != 1
        AND LOWER(COALESCE(v.status, '')) != 'cancelada'
      )
    )
  `;

  if (dataInicio && dataFim) {
    filtrosLegado += ` AND ${sqlDataLegado} BETWEEN date(?) AND date(?)`;
    filtrosCanonicos += ` AND ${sqlDataCanonica} BETWEEN date(?) AND date(?)`;
    paramsLegado.push(dataInicio, dataFim);
    paramsCanonicos.push(dataInicio, dataFim);
  }

  if (status && status !== 'todas') {
    if (status === 'vencido') {
      filtrosLegado += ` AND f.status NOT IN ('recebido','pago','cancelado','cancelada')
        AND ${sqlDataLegado} < date('now')`;
      filtrosCanonicos += ` AND cr.status NOT IN ('recebido','pago','cancelado','cancelada')
        AND ${sqlDataCanonica} < date('now')`;
    } else if (status === 'pendente') {
      filtrosLegado += " AND f.status = 'pendente'";
      filtrosCanonicos += " AND cr.status = 'aberto'";
    } else {
      filtrosLegado += ' AND f.status = ?';
      filtrosCanonicos += ' AND cr.status = ?';
      paramsLegado.push(status);
      paramsCanonicos.push(status);
    }
  }

  if (cliente && String(cliente).trim() !== '') {
    const termoCliente = `%${String(cliente).trim()}%`;
    filtrosLegado += ' AND COALESCE(f.pessoa_nome, "") LIKE ?';
    filtrosCanonicos += " AND COALESCE(c.nome, '') LIKE ?";
    paramsLegado.push(termoCliente);
    paramsCanonicos.push(termoCliente);
  }

  if (modoFiscalAtivo) {
    filtrosLegado += ` AND (f.venda_id IS NULL OR COALESCE(v.valor_fiscal, 0) > 0)`;
    filtrosCanonicos += ` AND (cr.venda_id IS NULL OR COALESCE(v.valor_fiscal, 0) > 0)`;
  }

  try {
    const [rowsLegado, rowsCanonicos] = await Promise.all([
      dbAllAsync(`
        SELECT
          f.id,
          f.descricao,
          f.documento,
          f.valor,
          f.data_movimento,
          f.vencimento,
          f.status,
          f.origem,
          f.pessoa_nome,
          f.venda_id,
          f.referencia_id,
          f.referencia_tipo,
          v.total AS venda_total,
          v.valor_fiscal AS venda_valor_fiscal,
          v.valor_nao_fiscal AS venda_valor_nao_fiscal
        FROM financeiro f
        LEFT JOIN vendas v ON v.id = f.venda_id
        WHERE ${filtrosLegado}
        ORDER BY ${sqlDataLegado} DESC, f.id DESC
      `, paramsLegado),
      dbAllAsync(`
        SELECT
          cr.id,
          cr.venda_id,
          cr.numero_parcela,
          cr.total_parcelas,
          cr.componente,
          cr.valor_parcela,
          cr.valor_restante,
          cr.data_vencimento,
          cr.status,
          c.nome AS cliente,
          c.cpf_cnpj AS documento,
          v.codigo AS venda_codigo,
          v.total AS venda_total,
          v.valor_fiscal AS venda_valor_fiscal,
          v.valor_nao_fiscal AS venda_valor_nao_fiscal
        FROM contas_receber cr
        LEFT JOIN clientes c ON c.id = cr.cliente_id
        LEFT JOIN vendas v
          ON v.id = cr.venda_id
         AND v.empresa_id = cr.empresa_id
        WHERE ${filtrosCanonicos}
        ORDER BY ${sqlDataCanonica} DESC, cr.id DESC
      `, paramsCanonicos)
    ]);
    const hoje = moment().format('YYYY-MM-DD');

    const contasLegadas = rowsLegado.map(row => {
      let statusFinal = row.status || 'pendente';
      if (
        !['recebido', 'pago', 'cancelado', 'cancelada'].includes(statusFinal) &&
        row.vencimento &&
        row.vencimento < hoje
      ) {
        statusFinal = 'vencido';
      }

      const { valorFiscal, valorNaoFiscal } = valoresMotorDaVenda(row);
      const valorOriginal = parseNumber(row.valor);
      const liquidado = ['recebido', 'pago'].includes(row.status);
      const saldoConhecido = ['recebido', 'pago', 'cancelado', 'cancelada', 'pendente', 'aberto'].includes(row.status);
      const valorExibido = modoFiscalAtivo
        ? (parseNumber(row.venda_valor_nao_fiscal) <= 0
          ? valorOriginal
          : valorFiscal)
        : valorOriginal;

      return {
        id: row.id,
        fonte: 'financeiro',
        chave: `financeiro:${row.id}`,
        cliente: row.pessoa_nome || '',
        descricao: row.descricao || '',
        documento: row.documento || '',
        valor: valorExibido,
        valor_fiscal: valorFiscal,
        valor_nao_fiscal: valorNaoFiscal,
        valor_total: valorOriginal,
        valor_original: valorOriginal,
        valor_recebido: saldoConhecido ? (liquidado ? valorOriginal : 0) : null,
        valor_restante: saldoConhecido ? (liquidado || ['cancelado', 'cancelada'].includes(row.status) ? 0 : valorOriginal) : null,
        dataEmissao: row.data_movimento || null,
        dataVencimento: row.vencimento || null,
        status: statusFinal,
        status_persistido: row.status || 'pendente',
        origem: row.origem || '',
        venda_id: row.venda_id || null
      };
    });
    const contasCanonicas = rowsCanonicos.map(row => {
      let statusFinal = row.status || 'aberto';
      if (
        !['recebido', 'pago', 'cancelado', 'cancelada'].includes(statusFinal) &&
        row.data_vencimento &&
        row.data_vencimento < hoje
      ) {
        statusFinal = 'vencido';
      }

      const valorOriginal = parseNumber(row.valor_parcela);
      const valorRestante = parseNumber(row.valor_restante);
      const { valorFiscal, valorNaoFiscal } = valoresMotorDaVenda({
        venda_id: row.venda_id,
        valor: valorOriginal,
        venda_valor_fiscal: row.venda_valor_fiscal,
        venda_valor_nao_fiscal: row.venda_valor_nao_fiscal
      });
      const valorExibido = modoFiscalAtivo
        ? (parseNumber(row.venda_valor_nao_fiscal) <= 0 ? valorOriginal : valorFiscal)
        : valorOriginal;

      return {
        id: row.id,
        fonte: 'contas_receber',
        chave: `contas_receber:${row.id}`,
        cliente: row.cliente || '',
        descricao: `Parcela ${row.numero_parcela || '-'}/${row.total_parcelas || '-'} · ${row.componente === 'outros' ? 'Outros' : 'Produtos'} · Venda ${row.venda_codigo || row.venda_id || '-'}`,
        documento: row.documento || '',
        valor: valorExibido,
        valor_fiscal: valorFiscal,
        valor_nao_fiscal: valorNaoFiscal,
        valor_total: valorOriginal,
        valor_original: valorOriginal,
        valor_recebido: valorOriginal - valorRestante,
        valor_restante: valorRestante,
        dataEmissao: null,
        dataVencimento: row.data_vencimento || null,
        status: statusFinal,
        status_persistido: row.status || 'aberto',
        origem: 'contas_receber',
        venda_id: row.venda_id || null
      };
    });
    const contas = [...contasLegadas, ...contasCanonicas].sort((a, b) => {
      const dataA = String(a.dataVencimento || a.dataEmissao || '');
      const dataB = String(b.dataVencimento || b.dataEmissao || '');
      if (dataA !== dataB) return dataB.localeCompare(dataA);
      return Number(b.id) - Number(a.id) || String(a.fonte).localeCompare(String(b.fonte));
    }).filter((conta) => {
      if (!modoFiscalAtivo) return true;
      return parseNumber(conta.valor_fiscal) > 0;
    });

    return res.json({
      success: true,
      modo_fiscal_ativo: modoFiscalAtivo,
      contas,
      totais: totaisMotorSemDuplicarVenda(contas, modoFiscalAtivo),
      periodo: { dataInicio, dataFim }
    });
  } catch (err) {
    console.error('Erro no relatório receber:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Relatório de Contas a Pagar
router.get('/relatorios/pagar', (req, res) => {
  const { sql, params } = buildPagarQueryFilters(req.query, req.empresaId);

  db.all(sql, params, (err, rows) => {
    if (err) {
      console.error('Erro no relatório pagar:', err);
      return res.status(500).json({ success: false, error: err.message });
    }

    const hoje = moment().format('YYYY-MM-DD');

    const contas = (rows || []).map(row => {
      let statusFinal = row.status || 'pendente';

      if (
        !['recebido', 'pago'].includes(statusFinal) &&
        row.dataVencimento &&
        row.dataVencimento < hoje
      ) {
        statusFinal = 'vencido';
      }

      return {
        id: row.id,
        fornecedor: row.fornecedor || row.pessoa_nome || '',
        descricao: row.descricao || '',
        documento: row.documento || '',
        valor: parseNumber(row.valor),
        dataEmissao: row.dataEmissao || null,
        dataVencimento: row.dataVencimento || null,
        status: statusFinal,
        categoria: row.categoria || '',
        observacao: row.observacao || '',
        origem: row.origem || ''
      };
    });

    return res.json({
      success: true,
      contas,
      periodo: {
        dataInicio: req.query.dataInicio,
        dataFim: req.query.dataFim
      }
    });
  });
});

// Relatório de Fluxo Financeiro
router.get('/relatorios/fluxo', async (req, res) => {
  const { dataInicio, dataFim, modo_fiscal } = req.query;
  const emp = filtroEmpresaSql(req.empresaId);

  let sql = `
    SELECT
      DATE(f.data_movimento) as data,
      f.tipo,
      SUM(f.valor) as valor
    FROM financeiro f
    WHERE 1=1
      ${emp.sql}
      AND ${sqlExcluirFinanceiroVendaCancelada('f')}
      ${sqlExcluirProjecaoMcf('f')}
      AND COALESCE(f.status, '') != 'cancelado'
  `;

  const params = [emp.param];

  if (dataInicio && dataFim) {
    sql += ' AND data_movimento BETWEEN ? AND ?';
    params.push(dataInicio, dataFim);
  }

  sql += ' GROUP BY DATE(data_movimento), tipo ORDER BY data';

  try {
    const rows = await dbAllAsync(sql, params);
    const recebimentosVenda = await consultarRecebimentosVendaSplit(
      dataInicio,
      dataFim,
      modo_fiscal,
      req.empresaId
    );

    const fluxo = {};
    rows.forEach(row => {
      if (!fluxo[row.data]) {
        fluxo[row.data] = { data: row.data, receitas: 0, despesas: 0, saldo: 0 };
      }
      if (row.tipo === 'receita') {
        fluxo[row.data].receitas = parseNumber(row.valor);
      } else if (row.tipo === 'despesa') {
        fluxo[row.data].despesas = parseNumber(row.valor);
      }
      fluxo[row.data].saldo = fluxo[row.data].receitas - fluxo[row.data].despesas;
    });

    const fluxoArray = Object.values(fluxo);
    const entradasFinanceiro = fluxoArray.reduce((sum, item) => sum + item.receitas, 0);
    const entradasVendaFiscal = recebimentosVenda.fiscal.total;
    const entradasVendaNaoFiscal = recebimentosVenda.nao_fiscal.total;
    const entradasVendaTotal = recebimentosVenda.total.total;

    res.json({
      success: true,
      modo_fiscal_ativo: recebimentosVenda.modo_fiscal_ativo,
      entradas: recebimentosVenda.modo_fiscal_ativo ? entradasVendaFiscal : entradasVendaTotal,
      entradas_financeiro: entradasFinanceiro,
      entradas_venda: {
        fiscal: entradasVendaFiscal,
        nao_fiscal: entradasVendaNaoFiscal,
        total: entradasVendaTotal
      },
      saidas: fluxoArray.reduce((sum, item) => sum + item.despesas, 0),
      periodo: { dataInicio, dataFim }
    });
  } catch (err) {
    console.error('Erro no relatório fluxo:', err);
    res.status(500).json({ error: err.message });
  }
});

// Relatório de Inadimplência
router.get('/relatorios/inadimplencia', async (req, res) => {
  const { dataInicio, dataFim } = req.query;

  let sql = `
    SELECT
      f.*,
      f.pessoa_nome as pessoa_nome,
      CASE
        WHEN f.tipo = 'receita' THEN 'cliente'
        WHEN f.tipo = 'despesa' THEN 'fornecedor'
        ELSE 'outros'
      END as tipo_pessoa,
      julianday('now') - julianday(f.vencimento) as dias_atraso
    FROM financeiro f
    WHERE f.status NOT IN ('recebido', 'pago', 'cancelado') AND f.vencimento < date('now')
      AND f.empresa_id = ?
      AND ${sqlExcluirFinanceiroVendaCancelada('f')}
      AND ${sqlExcluirFinanceiroReceberComContaCanonica('f')}
      ${sqlExcluirProjecaoMcf('f')}
  `;

  const params = [req.empresaId];

  if (dataInicio && dataFim) {
    sql += ' AND f.data_movimento BETWEEN ? AND ?';
    params.push(dataInicio, dataFim);
  }

  sql += ' ORDER BY f.vencimento ASC';

  try {
    const rowsFinanceiro = await dbAllAsync(sql, params);
    const parametrosEmpresa = [Number(req.empresaId)];
    if (dataInicio && dataFim) {
      parametrosEmpresa.push(dataInicio, dataFim);
    }

    const rowsReceber = await dbAllAsync(`
      SELECT
        cr.id,
        'cliente' AS tipo_pessoa,
        'receita' AS tipo,
        'Parcela da venda #' || cr.venda_id || ' - parcela ' || COALESCE(cr.numero_parcela, '-') AS descricao,
        NULL AS documento,
        NULL AS data_movimento,
        cr.data_vencimento AS vencimento,
        cr.valor_restante AS valor,
        cr.status,
        julianday('now') - julianday(cr.data_vencimento) AS dias_atraso
      FROM contas_receber cr
      WHERE cr.empresa_id = ?
        AND cr.status IN ('aberto', 'parcial')
        AND ${sqlExcluirContaVendaCancelada('cr')}
        AND date(cr.data_vencimento) < date('now')
        ${dataInicio && dataFim ? 'AND date(cr.data_vencimento) BETWEEN date(?) AND date(?)' : ''}
      ORDER BY cr.data_vencimento ASC
    `, parametrosEmpresa);

    const rowsPagar = await dbAllAsync(`
      SELECT
        cp.id,
        'fornecedor' AS tipo_pessoa,
        'despesa' AS tipo,
        cp.descricao,
        cp.documento,
        cp.data_emissao AS data_movimento,
        cp.data_vencimento AS vencimento,
        cp.valor_restante AS valor,
        cp.status,
        COALESCE(cp.pessoa_nome, f.nome) AS pessoa_nome,
        julianday('now') - julianday(cp.data_vencimento) AS dias_atraso
      FROM contas_pagar cp
      LEFT JOIN fornecedores f ON f.id = cp.fornecedor_id
      WHERE cp.empresa_id = ?
        AND cp.status IN ('aberto', 'parcial')
        AND date(cp.data_vencimento) < date('now')
        ${dataInicio && dataFim ? 'AND date(cp.data_vencimento) BETWEEN date(?) AND date(?)' : ''}
      ORDER BY cp.data_vencimento ASC
    `, parametrosEmpresa);

    const inadimplentes = [
      ...rowsFinanceiro.map(row => ({
        id: row.id,
        pessoa: row.pessoa_nome,
        tipo_pessoa: row.tipo_pessoa,
        descricao: row.descricao,
        documento: row.documento,
        valor: parseNumber(row.valor),
        dataEmissao: row.data_movimento,
        dataVencimento: row.vencimento,
        status: row.status,
        dias_atraso: Math.floor(row.dias_atraso),
        tipo: row.tipo,
        fonte: 'financeiro'
      })),
      ...rowsReceber.map(row => ({
        id: row.id,
        pessoa: row.pessoa_nome || null,
        tipo_pessoa: row.tipo_pessoa,
        descricao: row.descricao,
        documento: row.documento,
        valor: parseNumber(row.valor),
        dataEmissao: row.data_movimento,
        dataVencimento: row.vencimento,
        status: row.status,
        dias_atraso: Math.floor(row.dias_atraso),
        tipo: row.tipo,
        fonte: 'contas_receber'
      })),
      ...rowsPagar.map(row => ({
        id: row.id,
        pessoa: row.pessoa_nome,
        tipo_pessoa: row.tipo_pessoa,
        descricao: row.descricao,
        documento: row.documento,
        valor: parseNumber(row.valor),
        dataEmissao: row.data_movimento,
        dataVencimento: row.vencimento,
        status: row.status,
        dias_atraso: Math.floor(row.dias_atraso),
        tipo: row.tipo,
        fonte: 'contas_pagar'
      }))
    ].sort((a, b) => String(a.dataVencimento).localeCompare(String(b.dataVencimento)));

    const vencidas = inadimplentes.filter(item => item.dias_atraso > 0).length;
    const vencer7dias = inadimplentes.filter(item => item.dias_atraso <= 7 && item.dias_atraso > 0).length;
    const valorAtraso = inadimplentes.reduce((sum, item) => sum + item.valor, 0);

    res.json({
      success: true,
      vencidas,
      vencer7dias,
      valorAtraso,
      contasAtraso: inadimplentes,
      periodo: { dataInicio, dataFim }
    });
  } catch (err) {
    console.error('Erro no relatório inadimplência:', err);
    res.status(500).json({ error: err.message });
  }
});

// Nova rota para detalhes de conta a pagar com dados da compra
router.get('/contas-pagar/:id/detalhes', (req, res) => {
  const { id } = req.params;

  db.get(`SELECT * FROM financeiro WHERE id = ? AND tipo = 'despesa' AND empresa_id = ?`, [id, req.empresaId], (err, conta) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!conta) return res.status(404).json({ error: 'Conta a pagar não encontrada.' });

    try {
      exigirRegistroDaEmpresa(conta, req.empresaId, { rotulo: 'Conta a pagar' });
    } catch (empErr) {
      return responderErroEmpresa(res, empErr);
    }

    const compraId = conta.compra_id || conta.referencia_id;

    if (!compraId || conta.origem !== 'compra') {
      return res.json({
        ...conta,
        compra: null,
        itens_compra: []
      });
    }

    db.get(`SELECT * FROM compras WHERE id = ?`, [compraId], (compraErr, compra) => {
      if (compraErr) return res.status(500).json({ error: compraErr.message });

      db.all(`
        SELECT
          ci.*,
          COALESCE(p.nome, ci.descricao_produto) AS produto_nome,
          p.codigo AS produto_codigo
        FROM compras_itens ci
        LEFT JOIN produtos p ON p.id = ci.produto_id
        WHERE ci.compra_id = ?
        ORDER BY ci.id
      `, [compraId], (itensErr, itens) => {
        if (itensErr) return res.status(500).json({ error: itensErr.message });

        res.json({
          ...conta,
          compra: compra || null,
          itens_compra: itens || []
        });
      });
    });
  });
});

router.get('/:id(\\d+)', (req, res) => {
  const { id } = req.params;
  db.get('SELECT * FROM financeiro WHERE id = ?', [id], (err, row) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    try {
      exigirLancamentoDaEmpresa(row, req.empresaId);
    } catch (empErr) {
      return responderErroEmpresa(res, empErr);
    }
    res.json(row);
  });
});

router.delete('/:id(\\d+)', (req, res) => {
  if (!requireAdminFinanceiro(req, res)) return;

  const { id } = req.params;

  db.get('SELECT * FROM financeiro WHERE id = ? AND empresa_id = ?', [id, req.empresaId], async (err, row) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }

    if (!row) {
      res.status(404).json({ error: 'Movimentação não encontrada.' });
      return;
    }

    try {
      exigirRegistroDaEmpresa(row, req.empresaId);
    } catch (empErr) {
      return responderErroEmpresa(res, empErr);
    }

    // MCF-02.1 — projeção não se exclui no legado
    if (ehProjecaoMcfRow(row) || await buscarVinculoPorFinanceiroId(db, req.empresaId, id)) {
      const e = erroProjecaoImutavel('cancelar');
      const vinculo = await buscarVinculoPorFinanceiroId(db, req.empresaId, id);
      return res.status(e.statusCode || 409).json({
        error: e.message,
        code: e.code,
        conta_pagar_id: vinculo?.conta_pagar_id || null
      });
    }

    if (row.origem && row.origem !== 'manual') {
      res.status(400).json({
        error: 'Movimentações automáticas devem ser removidas na origem (compra/venda).'
      });
      return;
    }

    db.run('DELETE FROM financeiro WHERE id = ? AND empresa_id = ?', [id, req.empresaId], function(deleteErr) {
      if (deleteErr) {
        res.status(500).json({ error: deleteErr.message });
        return;
      }

      res.json({
        success: true,
        message: 'Movimentação excluída com sucesso.'
      });
    });
  });
});

module.exports = router;
