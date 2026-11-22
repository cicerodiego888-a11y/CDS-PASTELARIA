(function (global) {
  'use strict';

  const ABAS = [
    ['visao-geral', 'Visão geral'],
    ['pedidos', 'Pedidos'],
    ['desempenho', 'Desempenho'],
    ['equipe', 'Equipe'],
    ['produtos', 'Produtos e categorias'],
    ['relatorios', 'Relatórios']
  ];

  function escapar(valor) {
    return String(valor == null ? '' : valor)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function formatarNumero(valor, casas = 1) {
    return valor == null || !Number.isFinite(Number(valor))
      ? '—'
      : Number(valor).toLocaleString('pt-BR', { maximumFractionDigits: casas });
  }

  function formatarHora(valor) {
    if (!valor) return '—';
    const data = new Date(String(valor).endsWith('Z') ? valor : `${valor}Z`);
    return Number.isNaN(data.getTime())
      ? escapar(valor)
      : data.toLocaleString('pt-BR', { timeZone: 'America/Fortaleza' });
  }

  function tempoDecorrido(inicio) {
    if (!inicio) return '—';
    const data = new Date(String(inicio).endsWith('Z') ? inicio : `${inicio}Z`);
    if (Number.isNaN(data.getTime())) return '—';
    const total = Math.max(0, Math.floor((Date.now() - data.getTime()) / 1000));
    return `${String(Math.floor(total / 3600)).padStart(2, '0')}:${String(Math.floor((total % 3600) / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  }

  async function requisitar(path, method = 'GET', body) {
    const token = global.localStorage.getItem('token') || '';
    const response = await global.fetch(`${global.API_URL || '/api'}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.mensagem || data.error || `HTTP ${response.status}`);
      error.codigo = data.codigo;
      error.pendencias = Array.isArray(data.pendencias) ? data.pendencias : [];
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function usuarioPodeAcessar() {
    try {
      const user = JSON.parse(global.localStorage.getItem('user') || '{}');
      const perfil = String(user.perfil || '').trim().toUpperCase();
      const role = String(user.role || '').trim().toLowerCase();
      return role === 'gerente' || perfil === 'GERENTE' || perfil === 'SUPER_ADMIN';
    } catch (_error) {
      return false;
    }
  }

  function montarPainel(global) {
    const state = {
      aba: 'visao-geral',
      dados: null,
      erro: '',
      carregando: false,
      historico: [],
      relatorioHistorico: null,
      relatorioTurnoId: '',
      timer: null,
      reqEmCurso: false
    };

    function nomesOperadores() {
      const desempenho = state.dados && state.dados.relatorio && state.dados.relatorio.desempenho || {};
      const nomes = new Map();
      [...(desempenho.cozinheiros || []), ...(desempenho.garcons || [])].forEach((item) => {
        if (item.operador_id != null) nomes.set(Number(item.operador_id), item.operador_nome);
      });
      return nomes;
    }

    function operadorNome(id, nomes) {
      if (id == null) return '—';
      return escapar(nomes.get(Number(id)) || `Operador #${id}`);
    }

    function tabela(dados, colunas, vazio) {
      if (!Array.isArray(dados) || !dados.length) {
        return `<div class="alert alert-light border mb-0">${escapar(vazio || 'Sem dados para este turno.')}</div>`;
      }
      return `<div class="table-responsive"><table class="table table-sm table-striped align-middle mb-0">
        <thead><tr>${colunas.map(c => `<th>${escapar(c.label)}</th>`).join('')}</tr></thead>
        <tbody>${dados.map(row => `<tr>${colunas.map(c => `<td>${c.render ? c.render(row) : escapar(row[c.key] == null ? '—' : row[c.key])}</td>`).join('')}</tr>`).join('')}</tbody>
      </table></div>`;
    }

    function renderVisaoGeral() {
      const data = state.dados || {};
      const report = data.relatorio || {};
      const indicadores = report.indicadores || {};
      const turno = data.turno || report.turno || data.turno_relatorio || null;
      const pendencias = indicadores.pendencias || [];
      const cards = [
        ['Pedidos recebidos', indicadores.pedidos_recebidos],
        ['Em preparação', indicadores.pedidos_em_preparacao],
        ['Prontos aguardando retirada', indicadores.pedidos_prontos_aguardando_retirada],
        ['Retirados', indicadores.pedidos_retirados],
        ['Pendências operacionais', indicadores.pedidos_pendentes]
      ];
      return `
        <div class="row g-3 mb-3">
          <div class="col-12"><div class="card"><div class="card-body d-flex flex-wrap gap-4 align-items-center">
            <div><div class="text-muted small">Estado da cozinha</div><strong class="${data.estado === 'ABERTA' ? 'text-success' : 'text-secondary'}">${escapar(data.estado || '—')}</strong></div>
            <div><div class="text-muted small">Turno</div><strong>${turno ? `#${escapar(turno.id)}` : '—'}</strong></div>
            <div><div class="text-muted small">Abertura</div><strong>${turno ? escapar(formatarHora(turno.abertura_em)) : '—'}</strong></div>
            <div><div class="text-muted small">Responsável</div><strong>${turno ? escapar(turno.abertura_operador_nome || '—') : '—'}</strong></div>
            <div><div class="text-muted small">Unidade</div><strong>${escapar(data.unidade && data.unidade.codigo || `#${data.unidade && data.unidade.id || '—'}`)}</strong></div>
          </div></div></div>
          ${cards.map(([label, valor]) => `<div class="col-6 col-lg"><div class="card h-100"><div class="card-body">
            <div class="text-muted small">${label}</div><div class="fs-3 fw-bold">${formatarNumero(valor, 0)}</div>
          </div></div></div>`).join('')}
        </div>
        <h3 class="h6">Alertas operacionais</h3>
        ${pendencias.length
          ? `<div class="list-group">${pendencias.map(item => `<div class="list-group-item d-flex justify-content-between">
              <span>${escapar(item.tipo)}</span><strong>${formatarNumero(item.quantidade, 0)}</strong>
            </div>`).join('')}</div>`
          : '<div class="alert alert-success mb-0">Nenhuma pendência operacional informada.</div>'}`;
    }

    function renderPedidos() {
      const data = state.dados || {};
      const rodadas = data.painel && Array.isArray(data.painel.rodadas) ? data.painel.rodadas : [];
      const nomes = nomesOperadores();
      const meta = data.turno && data.turno.meta_espera_minutos_snapshot;
      const itens = rodadas.map((rodada) => {
        const estado = rodada.estado_preparacao || '—';
        const itensPendentes = (rodada.itens || []).filter(item =>
          !['PRONTO', 'RETIRADO', 'CANCELADO'].includes(String(item.estado_preparacao || item.estado || '').toUpperCase()));
        const responsaveis = [...new Set((rodada.itens || []).flatMap(item =>
          [item.operador_inicio_id, item.operador_pronto_id].filter(id => id != null)))];
        const atraso = meta != null && estado !== 'PRONTA' && estado !== 'CANCELADA'
          && (Date.now() - new Date(String(rodada.enviada_em || '').endsWith('Z')
            ? rodada.enviada_em : `${rodada.enviada_em || ''}Z`).getTime()) > Number(meta) * 60000;
        return `<tr>
          <td>${escapar(rodada.mesa_numero != null ? `Mesa ${rodada.mesa_numero}` : `Destino ${rodada.atendimento_id || '—'}`)}</td>
          <td>#${escapar(rodada.numero_rodada || rodada.id)}</td>
          <td>${escapar(estado)}</td>
          <td>${tempoDecorrido(rodada.enviada_em)}</td>
          <td>${itensPendentes.length ? itensPendentes.map(item => escapar(item.produto_nome_snapshot || item.produto_nome || 'Item')).join(', ') : '—'}</td>
          <td>${responsaveis.length ? responsaveis.map(id => operadorNome(id, nomes)).join(', ') : '—'}</td>
          <td>${atraso ? '<span class="badge text-bg-danger">Atrasado</span>' : '—'}</td>
        </tr>`;
      });
      return rodadas.length ? `<div class="table-responsive"><table class="table table-sm table-hover align-middle">
        <thead><tr><th>Mesa/destino</th><th>Rodada</th><th>Etapa</th><th>Tempo acumulado</th><th>Itens pendentes</th><th>Responsáveis</th><th>Prazo</th></tr></thead>
        <tbody>${itens.join('')}</tbody></table></div>`
        : '<div class="alert alert-light border">Não há pedidos ativos vinculados ao turno atual.</div>';
    }

    function renderDesempenho() {
      const report = state.dados && state.dados.relatorio || {};
      const tempos = report.tempos || {};
      const turno = report.turno || {};
      const metricas = [
        ['Tempo médio de preparo', tempos.preparo_medio_minutos, turno.meta_preparo_minutos_snapshot],
        ['Tempo médio de espera', tempos.espera_media_minutos, turno.meta_espera_minutos_snapshot],
        ['PRONTO até retirada', tempos.pronto_para_retirada_medio_minutos, null],
        ['Maior atraso', tempos.maior_atraso_minutos, turno.meta_espera_minutos_snapshot],
        ['Dentro da meta', tempos.percentual_no_prazo, 100]
      ];
      return `<div class="table-responsive"><table class="table table-sm table-striped">
        <thead><tr><th>Indicador</th><th>Resultado</th><th>Meta capturada na abertura</th></tr></thead>
        <tbody>${metricas.map(([nome, valor, meta]) => `<tr>
          <td>${nome}</td><td>${valor == null ? 'Sem dados' : `${formatarNumero(valor)}${nome === 'Dentro da meta' ? '%' : ' min'}`}</td>
          <td>${meta == null ? 'Não configurada' : `${formatarNumero(meta, 0)}${nome === 'Dentro da meta' ? '%' : ' min'}`}</td>
        </tr>`).join('')}</tbody>
      </table></div>
      <p class="text-muted small">As metas são as capturadas na abertura do turno; alterações posteriores não recalculam este relatório.</p>`;
    }

    function renderEquipe() {
      const desempenho = state.dados && state.dados.relatorio && state.dados.relatorio.desempenho || {};
      const cozinheiros = (desempenho.cozinheiros || []).map(item => ({ ...item, funcao: 'Cozinha' }));
      const garcons = (desempenho.garcons || []).map(item => ({ ...item, funcao: 'Garçom' }));
      const equipe = [...cozinheiros, ...garcons];
      return `<h3 class="h6">Desempenho por operador</h3>${tabela(equipe, [
        { label: 'Função', key: 'funcao' },
        { label: 'Operador', key: 'operador_nome' },
        { label: 'Itens iniciados', key: 'itens_iniciados' },
        { label: 'Itens prontos', key: 'itens_prontos' },
        { label: 'Retiradas', key: 'pedidos_retirados' },
        { label: 'No prazo', key: 'dentro_meta' },
        { label: 'PRONTO até retirada (min)', render: row => formatarNumero(row.pronto_retirada_medio_minutos) }
      ])}
      <h3 class="h6 mt-4">Retiradas parciais e responsáveis</h3>${tabela(desempenho.retiradas_parciais, [
        { label: 'Operador', key: 'operador_nome' },
        { label: 'Eventos', key: 'eventos' },
        { label: 'Quantidade (milesimal)', key: 'qty_millis' },
        { label: 'Rodada', key: 'rodada_id' },
        { label: 'Item', key: 'cozinha_item_id' }
      ])}`;
    }

    function renderProdutos() {
      const desempenho = state.dados && state.dados.relatorio && state.dados.relatorio.desempenho || {};
      return `<div class="row g-4">
        <div class="col-12 col-xl-6"><h3 class="h6">Categorias</h3>${tabela(desempenho.categorias, [
          { label: 'Categoria', key: 'categoria' },
          { label: 'Volume', key: 'total' },
          { label: 'Preparados', key: 'preparados' },
          { label: 'Cancelados', key: 'cancelados' },
          { label: 'Preparo médio (min)', render: row => formatarNumero(row.tempo_medio_preparo_minutos) },
          { label: 'Maior atraso (min)', render: row => formatarNumero(row.maior_atraso_minutos) }
        ])}</div>
        <div class="col-12 col-xl-6"><h3 class="h6">Produtos</h3>${tabela(desempenho.produtos, [
          { label: 'Produto', key: 'produto' },
          { label: 'Volume', key: 'total' },
          { label: 'Preparados', key: 'preparados' },
          { label: 'Cancelados', key: 'cancelados' },
          { label: 'Preparo médio (min)', render: row => formatarNumero(row.tempo_medio_preparo_minutos) },
          { label: 'Maior atraso (min)', render: row => formatarNumero(row.maior_atraso_minutos) }
        ])}</div>
      </div>
      <p class="text-muted small mt-3">Tempos calculados com os horários registrados no turno e sem metas padrão.</p>`;
    }

    function renderRelatorios() {
      const relatorio = state.relatorioHistorico || state.dados && state.dados.relatorio;
      const turnos = state.historico;
      const turnoId = state.relatorioTurnoId;
      const turnosHtml = `<div class="row g-2 align-items-end mb-3">
        <div class="col-md-8"><label class="form-label" for="cozinhaGerencialTurno">Turno</label>
          <select class="form-select" id="cozinhaGerencialTurno">
            ${turnos.map(t => `<option value="${escapar(t.id)}" ${String(t.id) === String(turnoId) ? 'selected' : ''}>
              #${escapar(t.id)} · ${escapar(t.estado)} · ${escapar(formatarHora(t.abertura_em))}
            </option>`).join('')}
          </select>
        </div>
        <div class="col-md-4"><button type="button" class="btn btn-outline-primary" data-acao="carregar-turno">Carregar relatório</button></div>
      </div>`;
      const intervencoes = relatorio && relatorio.intervencoes || [];
      const turno = relatorio && relatorio.turno || {};
      const excepcional = turno.fechamento_tipo === 'EXCEPCIONAL';
      const ocorrencias = relatorio && relatorio.ocorrencias || {};
      const desempenho = relatorio && relatorio.desempenho || {};
      const configuracoesSnapshot = relatorio && relatorio.configuracoes || [];
      const equipe = [
        ...(desempenho.cozinheiros || []).map(item => ({ ...item, funcao: 'Cozinha' })),
        ...(desempenho.garcons || []).map(item => ({ ...item, funcao: 'Retirada' }))
      ];
      return `${turnosHtml}
        ${relatorio ? `<div class="row g-3 mb-3">
          <div class="col-md-3"><strong>Empresa:</strong> ${escapar(turno.empresa_nome_fantasia || turno.empresa_nome || '—')}</div>
          <div class="col-md-3"><strong>Unidade:</strong> ${escapar(turno.unidade_codigo || '—')}</div>
          <div class="col-md-3"><strong>Turno:</strong> #${escapar(turno.id || turnoId || '—')}</div>
          <div class="col-md-3"><strong>Relatório:</strong> #${escapar(relatorio.relatorio_id || '—')}</div>
          <div class="col-md-3"><strong>Tipo:</strong> ${escapar(turno.fechamento_tipo || 'Em andamento')}</div>
          <div class="col-md-3"><strong>Estado:</strong> ${escapar(turno.estado || '—')}</div>
          <div class="col-md-3"><strong>Abertura:</strong> ${escapar(formatarHora(turno.abertura_em))}</div>
          <div class="col-md-3"><strong>Fechamento:</strong> ${escapar(formatarHora(turno.fechamento_em))}</div>
          <div class="col-md-3"><strong>Responsável pela abertura:</strong> ${escapar(turno.abertura_operador_nome || '—')}</div>
          <div class="col-md-3"><strong>Responsável pelo fechamento:</strong> ${escapar(turno.fechamento_operador_nome || '—')}</div>
        </div>
        ${excepcional ? `<div class="alert alert-warning" role="alert">
          <strong>FECHAMENTO EXCEPCIONAL</strong> — autorizado por ${escapar(turno.fechamento_operador_nome || '—')}.
          Justificativa: ${escapar(turno.fechamento_justificativa || '—')}
          <div class="mt-2"><strong>Pendências preservadas e situação:</strong>
            ${tabela(relatorio.indicadores.pendencias || [], [
              { label: 'Pendência', key: 'tipo' },
              { label: 'Quantidade', key: 'quantidade' },
              { label: 'Situação', key: 'situacao' }
            ], 'Nenhuma pendência operacional registrada.')}
          </div>
        </div>` : `<div class="mb-3"><strong>Justificativa:</strong> ${escapar(turno.fechamento_justificativa || '—')}</div>`}
        <div class="d-flex gap-2 flex-wrap mb-3">
          <button type="button" class="btn btn-outline-secondary" data-acao="imprimir-relatorio">Imprimir relatório</button>
          <button type="button" class="btn btn-outline-primary" data-acao="exportar-pdf">Exportar PDF</button>
          ${relatorio.snapshot_persistido ? '<span class="badge text-bg-success align-content-center">Snapshot oficial persistido</span>' : '<span class="badge text-bg-warning align-content-center">Relatório sem snapshot persistido</span>'}
        </div>
        ${relatorio.snapshot_sha256 ? `<div class="small text-muted mb-3">Snapshot SHA-256: ${escapar(relatorio.snapshot_sha256)}</div>` : ''}
        <h3 class="h6">Indicadores do turno</h3>${renderResumoRelatorio(relatorio)}
        <h3 class="h6 mt-4">Configurações capturadas na abertura</h3>${tabela(configuracoesSnapshot, [
          { label: 'Configuração', key: 'chave' },
          { label: 'Valor', key: 'valor' },
          { label: 'Versão', key: 'versao' }
        ])}
        <h3 class="h6 mt-4">Desempenho</h3>${tabela([
          { indicador: 'Meta de preparo (min)', valor: turno.meta_preparo_minutos_snapshot },
          { indicador: 'Meta de espera (min)', valor: turno.meta_espera_minutos_snapshot },
          { indicador: 'Tempo médio de preparo (min)', valor: relatorio.tempos.preparo_medio_minutos },
          { indicador: 'Tempo médio de espera (min)', valor: relatorio.tempos.espera_media_minutos },
          { indicador: 'PRONTO até retirada (min)', valor: relatorio.tempos.pronto_para_retirada_medio_minutos },
          { indicador: 'Dentro da meta (%)', valor: relatorio.tempos.percentual_no_prazo },
          { indicador: 'Fora da meta (%)', valor: relatorio.tempos.percentual_fora_prazo },
          { indicador: 'Maior atraso (min)', valor: relatorio.tempos.maior_atraso_minutos },
          { indicador: 'Horários de pico', valor: (relatorio.tempos.horarios_pico || []).map(p => `${p.hora}h (${p.pedidos})`).join(', ') || '—' }
        ], [
          { label: 'Indicador', key: 'indicador' },
          { label: 'Resultado', render: row => typeof row.valor === 'number' ? formatarNumero(row.valor, 1) : escapar(row.valor) }
        ])}
        <h3 class="h6 mt-4">Produtos e categorias</h3>${tabela(relatorio.desempenho.produtos, [
          { label: 'Produto', key: 'produto' },
          { label: 'Preparado (unidades)', render: row => formatarNumero(Number(row.preparados_millis || 0) / 1000, 3) },
          { label: 'Retirado (unidades)', render: row => formatarNumero(Number(row.retirados_millis || 0) / 1000, 3) },
          { label: 'Tempo médio de preparo (min)', render: row => formatarNumero(row.tempo_medio_preparo_minutos) }
        ])}
        ${tabela(desempenho.categorias, [
          { label: 'Categoria', key: 'categoria' },
          { label: 'Preparado (unidades)', render: row => formatarNumero(Number(row.preparados_millis || 0) / 1000, 3) },
          { label: 'Cancelados', key: 'cancelados' },
          { label: 'Tempo médio de preparo (min)', render: row => formatarNumero(row.tempo_medio_preparo_minutos) }
        ])}
        <h3 class="h6 mt-4">Equipe e retiradas</h3>${tabela(equipe, [
          { label: 'Função', key: 'funcao' },
          { label: 'Operador', key: 'operador_nome' },
          { label: 'Pedidos retirados', key: 'pedidos_retirados' },
          { label: 'Itens prontos', key: 'itens_prontos' },
          { label: 'Retiradas parciais', render: row => (desempenho.retiradas_parciais || [])
            .filter(item => Number(item.operador_id) === Number(row.operador_id))
            .reduce((total, item) => total + Number(item.eventos || 0), 0) }
        ])}
        <h3 class="h6 mt-4">Ocorrências e intervenções</h3>
        <h4 class="h6">Cancelamentos</h4>${tabela(ocorrencias.cancelamentos, [
          { label: 'Tipo', key: 'tipo' }, { label: 'Operador', key: 'operador_id' },
          { label: 'Quantidade (milesimal)', key: 'qty_millis' }, { label: 'Justificativa', key: 'justificativa' },
          { label: 'Horário', render: row => escapar(formatarHora(row.registrado_em)) }
        ])}
        <h4 class="h6 mt-3">Estornos e ajustes</h4>${tabela(ocorrencias.estornos_e_ajustes, [
          { label: 'Tipo', key: 'tipo' }, { label: 'Operador', key: 'operador_id' },
          { label: 'Autorizador', key: 'autorizado_por_operador_id' },
          { label: 'Quantidade (milesimal)', key: 'qty_millis' }, { label: 'Justificativa', key: 'justificativa' },
          { label: 'Horário', render: row => escapar(formatarHora(row.registrado_em)) }
        ])}
        <h3 class="h6 mt-4">Intervenções e justificativas</h3>${tabela(intervencoes, [
          { label: 'Tipo', key: 'tipo' },
          { label: 'Operador', key: 'operador_nome' },
          { label: 'Observação', key: 'observacao' },
          { label: 'Horário', render: row => escapar(formatarHora(row.created_at)) }
        ])}`
          : '<div class="alert alert-light border">Não há turnos para apresentar.</div>'}`;
    }

    function renderResumoRelatorio(relatorio) {
      const indicadores = relatorio.indicadores || {};
      const tempos = relatorio.tempos || {};
      return `<div class="row g-2 mb-3">
        ${[
          ['Recebidos', indicadores.pedidos_recebidos],
          ['Concluídos', indicadores.pedidos_concluidos],
          ['Preparados', indicadores.pedidos_preparados],
          ['Retirados', indicadores.pedidos_retirados],
          ['Cancelados', indicadores.pedidos_cancelados],
          ['Pendentes', indicadores.pedidos_pendentes],
          ['Itens preparados', Number(indicadores.itens_preparados_millis || 0) / 1000],
          ['Itens prontos', Number(indicadores.itens_prontos_millis || 0) / 1000],
          ['Itens retirados', Number(indicadores.itens_retirados_millis || 0) / 1000],
          ['Retiradas parciais', indicadores.retiradas_parciais],
          ['Maior atraso (min)', tempos.maior_atraso_minutos]
        ].map(([label, value]) => `<div class="col-6 col-lg-2"><div class="border rounded p-2">
          <div class="small text-muted">${label}</div><strong>${formatarNumero(value, label.startsWith('Itens') ? 3 : 1)}</strong>
        </div></div>`).join('')}
      </div>`;
    }

    function renderAba() {
      switch (state.aba) {
        case 'pedidos': return renderPedidos();
        case 'desempenho': return renderDesempenho();
        case 'equipe': return renderEquipe();
        case 'produtos': return renderProdutos();
        case 'relatorios': return renderRelatorios();
        default: return renderVisaoGeral();
      }
    }

    function render() {
      const host = global.document && global.document.getElementById('page-content');
      if (!host) return;
      const data = state.dados || {};
      const turno = data.turno || (data.relatorio && data.relatorio.turno) || data.turno_relatorio;
      host.innerHTML = `
        <main class="container-fluid py-3" id="cdsCozinhaGerencial">
          <header class="d-flex flex-wrap justify-content-between align-items-center gap-3 mb-3">
            <div><div class="text-uppercase text-muted small">CDS Sistemas</div>
              <h1 class="h3 mb-1">Gestão da Cozinha</h1>
              <div class="text-muted">Unidade ${escapar(data.unidade && data.unidade.codigo || `#${data.unidade && data.unidade.id || '—'}`)}
                · Cozinha <strong class="${data.estado === 'ABERTA' ? 'text-success' : 'text-secondary'}">${escapar(data.estado || '—')}</strong>
                ${turno ? `· Turno #${escapar(turno.id)} · ${escapar(turno.abertura_operador_nome || '—')} · ${escapar(formatarHora(turno.abertura_em))}` : ''}
              </div>
            </div>
            <div class="d-flex gap-2 flex-wrap">
              <button type="button" class="btn btn-outline-secondary" data-acao="kds"><i class="fas fa-arrow-left me-1"></i> Voltar ao KDS</button>
              <button type="button" class="btn btn-outline-primary" data-acao="atualizar" ${state.carregando ? 'disabled' : ''}><i class="fas fa-sync-alt me-1"></i> Atualizar</button>
              ${data.estado === 'ABERTA' ? '<button type="button" class="btn btn-danger" data-acao="fechar">Fechar turno</button>' : ''}
            </div>
          </header>
          ${state.erro ? `<div class="alert alert-danger" role="alert">${escapar(state.erro)}</div>` : ''}
          <nav class="nav nav-tabs mb-3" aria-label="Abas da Gestão da Cozinha">
            ${ABAS.map(([id, label]) => `<button type="button" class="nav-link ${state.aba === id ? 'active' : ''}" data-aba="${id}">${label}</button>`).join('')}
          </nav>
          <section aria-live="polite">${state.carregando && !state.dados ? '<div class="text-muted">Carregando dados oficiais da cozinha…</div>' : renderAba()}</section>
          <div class="text-muted small mt-3">Atualização automática · dados do KDS e dos relatórios oficiais do turno.</div>
        </main>`;
      host.querySelectorAll('[data-aba]').forEach((button) => {
        button.addEventListener('click', () => {
          state.aba = button.getAttribute('data-aba');
          if (state.aba === 'relatorios') void carregarHistorico();
          render();
        });
      });
      host.querySelector('[data-acao="kds"]')?.addEventListener('click', () => {
        if (typeof global.loadPage === 'function') global.loadPage('cozinha-kds');
      });
      host.querySelector('[data-acao="atualizar"]')?.addEventListener('click', () => void atualizar());
      host.querySelector('[data-acao="fechar"]')?.addEventListener('click', () => void fecharTurno());
      host.querySelector('[data-acao="carregar-turno"]')?.addEventListener('click', () => {
        const select = host.querySelector('#cozinhaGerencialTurno');
        if (select && select.value) void carregarRelatorio(select.value);
      });
      host.querySelector('[data-acao="imprimir-relatorio"]')?.addEventListener('click', () => global.print());
      host.querySelector('[data-acao="exportar-pdf"]')?.addEventListener('click', () => global.print());
    }

    async function atualizar() {
      if (state.reqEmCurso) return;
      state.reqEmCurso = true;
      state.carregando = true;
      state.erro = '';
      render();
      try {
        state.dados = await requisitar('/cozinha/gerencial/painel');
        global.CDS_COZINHA_TURNO_ATUAL = state.dados.turno || null;
      } catch (error) {
        state.erro = error.message || 'Falha ao carregar o painel gerencial.';
      } finally {
        state.reqEmCurso = false;
        state.carregando = false;
        render();
      }
    }

    async function carregarHistorico() {
      try {
        const response = await requisitar('/cozinha/gerencial/turnos/historico?limit=100');
        state.historico = response.turnos || [];
        if (!state.relatorioTurnoId && state.dados) {
          const turno = state.dados.turno || state.dados.turno_relatorio;
          if (turno) state.relatorioTurnoId = String(turno.id);
        }
        if (state.relatorioTurnoId && state.historico.some(t => String(t.id) === state.relatorioTurnoId)) {
          await carregarRelatorio(state.relatorioTurnoId, false);
        }
      } catch (error) {
        state.erro = error.message || 'Falha ao carregar o histórico de turnos.';
      }
      render();
    }

    async function carregarRelatorio(turnoId, redesenhar = true) {
      try {
        state.relatorioHistorico = await requisitar(`/cozinha/gerencial/turnos/${encodeURIComponent(turnoId)}/relatorio`);
        state.relatorioTurnoId = String(turnoId);
        state.erro = '';
      } catch (error) {
        state.erro = error.message || 'Falha ao consultar o relatório do turno.';
      }
      if (redesenhar) render();
    }

    async function fecharTurno() {
      if (!global.confirm('Deseja tentar o fechamento normal deste turno?')) return;
      state.erro = '';
      try {
        const fechamento = await requisitar('/cozinha/turnos/fechar', 'POST', { tipo: 'NORMAL' });
        await abrirRelatorioFechado(fechamento);
      } catch (error) {
        if (error.codigo !== 'FECHAMENTO_NORMAL_BLOQUEADO') {
          state.erro = error.message || 'Falha ao fechar o turno.';
          render();
          return;
        }
        const motivos = error.pendencias.map(p => `${p.tipo}: ${p.quantidade}`).join('\n');
        const confirmarExcepcional = global.confirm(`O fechamento normal foi bloqueado pelas pendências:\n${motivos || error.message}\n\nDeseja solicitar fechamento excepcional?`);
        if (!confirmarExcepcional) {
          state.erro = `${error.message}${motivos ? ` — ${motivos.replace(/\n/g, ' · ')}` : ''}`;
          render();
          return;
        }
        const justificativa = global.prompt('Justificativa obrigatória para fechamento excepcional (mínimo 10 caracteres):');
        if (!justificativa || justificativa.trim().length < 10) {
          state.erro = 'Fechamento excepcional não realizado: a justificativa deve ter pelo menos 10 caracteres.';
          render();
          return;
        }
        try {
          const fechamento = await requisitar('/cozinha/turnos/fechar', 'POST', {
            tipo: 'EXCEPCIONAL',
            justificativa: justificativa.trim()
          });
          await abrirRelatorioFechado(fechamento);
        } catch (exceptionalError) {
          state.erro = exceptionalError.message || 'Falha no fechamento excepcional.';
          render();
        }
      }
    }

    async function abrirRelatorioFechado(fechamento) {
      if (!fechamento || !fechamento.relatorio_id || !fechamento.turno_id) {
        throw new Error('Fechamento confirmado sem identificador de relatório persistido.');
      }
      state.aba = 'relatorios';
      state.relatorioTurnoId = String(fechamento.turno_id);
      state.relatorioHistorico = await requisitar(
        `/cozinha/gerencial/turnos/${encodeURIComponent(fechamento.turno_id)}/relatorio`
      );
      await atualizar();
      await carregarHistorico();
    }

    function iniciar() {
      render();
      void atualizar();
      state.timer = global.setInterval(() => {
        if (global.CDS_ERP_ACTIVE_PAGE !== 'cozinha-gerencial') {
          parar();
          return;
        }
        void atualizar();
      }, 10000);
    }

    function parar() {
      if (state.timer != null) global.clearInterval(state.timer);
      state.timer = null;
    }

    return { iniciar, parar };
  }

  global.loadCozinhaGerencial = function loadCozinhaGerencial() {
    if (!usuarioPodeAcessar()) {
      const host = global.document && global.document.getElementById('page-content');
      if (host) host.innerHTML = '<div class="alert alert-danger m-3">A Gestão da Cozinha é exclusiva de Gerentes e Super Administradores.</div>';
      return;
    }
    if (global.CdsCozinhaGerencial) global.CdsCozinhaGerencial.parar();
    const painel = montarPainel(global);
    global.CdsCozinhaGerencial = painel;
    painel.iniciar();
  };
}(window));
