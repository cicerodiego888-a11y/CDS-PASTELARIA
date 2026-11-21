/**
 * Estado operacional da entrada mobile.
 * Guarda pedido e pagamento na aba, sem autenticar e sem concluir a operação.
 */
(function (root) {
  'use strict';

  const CHAVE_PEDIDO = 'cdsMobilePedido';
  const CHAVE_PDV = 'cdsMobilePdv';
  const CHAVE_CLIENTE_MESA = 'cdsMobileClienteMesa:';

  function armazenamento() {
    return root.sessionStorage || null;
  }

  function usuario() {
    try {
      return JSON.parse(root.localStorage.getItem('user') || 'null');
    } catch (_erro) {
      return null;
    }
  }

  function operadorId() {
    const atual = usuario();
    return Number(atual && (atual.id || atual.usuario_id)) || null;
  }

  function empresaId() {
    const contexto = root.CdsEmpresaContexto;
    if (!contexto || typeof contexto.lerEmpresaId !== 'function') return null;
    return contexto.lerEmpresaId();
  }

  function lerBruto(chave) {
    const storage = armazenamento();
    if (!storage) return null;
    try {
      const bruto = storage.getItem(chave);
      if (!bruto) return null;
      return JSON.parse(bruto);
    } catch (_erro) {
      return { invalido: true };
    }
  }

  function compativel(registro) {
    if (!registro) return { ok: false, codigo: 'AUSENTE' };
    if (registro.invalido) return { ok: false, codigo: 'INVALIDO', registro };
    const atual = operadorId();
    if (registro.sessao_operador_id && atual && Number(registro.sessao_operador_id) !== atual) {
      return { ok: false, codigo: 'OPERADOR_DIVERGENTE', registro };
    }
    return { ok: true, registro };
  }

  function gravar(chave, dados) {
    const storage = armazenamento();
    if (!storage) return { ok: false, codigo: 'SEM_STORAGE' };
    const existente = lerBruto(chave);
    const leitura = compativel(existente);
    if (leitura.codigo === 'OPERADOR_DIVERGENTE') return leitura;
    const envelope = Object.assign({}, dados, {
      sessao_operador_id: operadorId(),
      empresa_id: empresaId(),
      atualizado_em: new Date().toISOString()
    });
    storage.setItem(chave, JSON.stringify(envelope));
    return { ok: true };
  }

  function chavePedido(mesaId) {
    const id = Number(mesaId);
    return Number.isInteger(id) && id > 0 ? CHAVE_PEDIDO + ':mesa:' + id : CHAVE_PEDIDO;
  }

  function salvarPedido(estado) {
    return gravar(chavePedido(estado.mesaId), {
      estado: {
        etapa: estado.etapa,
        cliente: estado.cliente || null,
        itens: Array.isArray(estado.itens) ? estado.itens : [],
        sequencia: Number(estado.sequencia) || 0,
        desconto: Number(estado.desconto) || 0,
        observacao: estado.observacao || '',
        chave: estado.chave || null,
        assinaturaChave: estado.assinaturaChave || null,
        confirmacao: estado.confirmacao || null
      }
    });
  }

  function lerPedido(mesaId) {
    return compativel(lerBruto(chavePedido(mesaId)));
  }

  function salvarClienteMesa(dados) {
    const mesaId = Number(dados.mesaId);
    const atendimentoId = Number(dados.atendimentoId);
    if (!Number.isInteger(mesaId) || mesaId <= 0 || !Number.isInteger(atendimentoId) || atendimentoId <= 0
      || !operadorId() || !empresaId() || !dados.cliente || !String(dados.cliente.nome || '').trim()) {
      return { ok: false, codigo: 'CONTEXTO_INVALIDO' };
    }
    return gravar(CHAVE_CLIENTE_MESA + mesaId, {
      atendimento_id: atendimentoId,
      cliente: { id: dados.cliente.id || null, nome: String(dados.cliente.nome).trim() }
    });
  }

  function lerClienteMesa(mesaId, atendimentoId) {
    const leitura = compativel(lerBruto(CHAVE_CLIENTE_MESA + Number(mesaId)));
    if (!leitura.ok) return leitura;
    if (!operadorId() || Number(leitura.registro.sessao_operador_id) !== Number(operadorId())
      || !empresaId() || Number(leitura.registro.empresa_id) !== Number(empresaId())
      || Number(leitura.registro.atendimento_id) !== Number(atendimentoId)) {
      return { ok: false, codigo: 'CONTEXTO_DIVERGENTE' };
    }
    return leitura;
  }

  function limparClienteMesa(mesaId, atendimentoId) {
    const leitura = lerClienteMesa(mesaId, atendimentoId);
    if (!leitura.ok) return leitura;
    armazenamento().removeItem(CHAVE_CLIENTE_MESA + Number(mesaId));
    return { ok: true };
  }

  function salvarPdv(dados) {
    return gravar(CHAVE_PDV, {
      itens: Array.isArray(dados.itens) ? dados.itens : [],
      desconto: Number(dados.desconto) || 0,
      total: Number(dados.total) || 0,
      chave: dados.chave || null,
      vendaPersistida: dados.vendaPersistida || null,
      pagamento: dados.pagamento || null
    });
  }

  function lerPdv() {
    return compativel(lerBruto(CHAVE_PDV));
  }

  function limparPdv() {
    const storage = armazenamento();
    const leitura = lerPdv();
    if (!storage || !leitura.ok) return leitura;
    storage.removeItem(CHAVE_PDV);
    return { ok: true };
  }

  function pedidoEmAndamento(registro) {
    const estado = registro && registro.estado;
    if (!estado) return false;
    if (estado.confirmacao) return true;
    if (Array.isArray(estado.itens) && estado.itens.length) return true;
    if (estado.cliente) return true;
    if (Number(estado.desconto) > 0) return true;
    if (String(estado.observacao || '').trim()) return true;
    return false;
  }

  function pdvEmAndamento(registro) {
    if (!registro) return false;
    if (Array.isArray(registro.itens) && registro.itens.length) return true;
    const parcelas = registro.pagamento && registro.pagamento.parcelas;
    return Array.isArray(parcelas) && parcelas.length > 0;
  }

  root.CdsMobileOperacao = {
    salvarPedido,
    lerPedido,
    salvarClienteMesa,
    lerClienteMesa,
    limparClienteMesa,
    salvarPdv,
    lerPdv,
    limparPdv,
    pedidoEmAndamento,
    pdvEmAndamento,
    operadorId
  };
})(typeof window !== 'undefined' ? window : globalThis);
