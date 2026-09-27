/**
 * Persistência do extrato Mercado Pago no MBC-03 (MBC-16.2).
 * Não grava diretamente: usa TransacaoBancariaService.registrar.
 * Não cria financeiro / conciliação / matching.
 *
 * @module motores/bancario/services/MercadoPagoPersistenciaService
 */
'use strict';

const { STATUS_REGISTRO } = require('../contracts/constantes');
const { exigirEmpresaId } = require('../contracts/TransacaoBancariaNormalizada');
const TransacaoBancariaService = require('./TransacaoBancariaService');

/**
 * Persiste lote de DTOs já normalizados pelo MBC-16.1 via MBC-03.
 * Movimentações inválidas (ex.: valor 0) entram em rejeitadas sem abortar o lote.
 *
 * @returns {{
 *   recebidas: number,
 *   criadas: number,
 *   ja_existentes: number,
 *   rejeitadas: Array<{ external_id: string|null, motivo: string, code?: string }>,
 *   ids_criados: number[]
 * }}
 */
async function persistirLote(params = {}) {
  const db = params.db;
  const empresaId = exigirEmpresaId(params.empresaId);
  const contaId = Number(params.conta_bancaria_id || params.contaBancariaId);
  const dtos = Array.isArray(params.movimentacoes) ? params.movimentacoes : [];

  let criadas = 0;
  let jaExistentes = 0;
  const rejeitadas = [];
  const idsCriados = [];

  for (const dto of dtos) {
    const externalId = dto && dto.external_id != null ? String(dto.external_id) : null;
    try {
      // empresa_id do DTO/body NÃO é autoridade — contexto + conta definem a propriedade
      const out = await TransacaoBancariaService.registrar({
        db,
        empresaId,
        conta_bancaria_id: contaId,
        accountId: contaId,
        external_id: dto.external_id,
        external_source: dto.external_source,
        data_transacao: dto.data_transacao || dto.data,
        data_processamento: dto.data_processamento,
        valor: dto.valor,
        direcao: dto.direcao,
        descricao: dto.descricao,
        tipo: dto.tipo || 'OUTROS',
        saldo_apos_transacao: dto.saldo_apos_transacao == null ? null : dto.saldo_apos_transacao,
        referencia_externa: dto.referencia_externa || dto.referencia || null,
        observacao: dto.observacao || null,
        raw_reference: dto.raw_reference || null
      });
      if (out.status === STATUS_REGISTRO.CRIADA) {
        criadas += 1;
        if (out.transacao && out.transacao.id != null) idsCriados.push(out.transacao.id);
      } else {
        jaExistentes += 1;
      }
    } catch (err) {
      rejeitadas.push({
        external_id: externalId,
        motivo: err.message || 'rejeitada',
        code: err.code || null
      });
    }
  }

  return {
    recebidas: dtos.length,
    criadas,
    ja_existentes: jaExistentes,
    rejeitadas,
    ids_criados: idsCriados
  };
}

module.exports = {
  persistirLote,
  STATUS_REGISTRO
};
