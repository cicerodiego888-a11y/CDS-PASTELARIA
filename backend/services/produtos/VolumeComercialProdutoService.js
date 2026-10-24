'use strict';

const { familiaDe, normalizarUnidade } = require('../../motores/muc/core/unidadesSi');
const { normalizarSigla } = require('./VolumeUnidadeComercialService');

const MIGRACOES_SCHEMA = Object.freeze([
  `ALTER TABLE produtos ADD COLUMN utiliza_volume INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE produtos ADD COLUMN volume_valor REAL`,
  `ALTER TABLE produtos ADD COLUMN volume_unidade TEXT`
]);

const CAMPOS_VOLUME_COMERCIAL = Object.freeze([
  'utiliza_volume',
  'volume_valor',
  'volume_unidade',
  'volume_unidade_id'
]);

function erroVolume(code, message) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = 400;
  return err;
}

function temCampoVolume(body) {
  return CAMPOS_VOLUME_COMERCIAL.some((campo) =>
    Object.prototype.hasOwnProperty.call(body || {}, campo)
  );
}

function normalizarFlag(valor) {
  if (valor === true || valor === 1 || valor === '1' || String(valor).toLowerCase() === 'true') return 1;
  if (valor === false || valor === 0 || valor === '0' || String(valor).toLowerCase() === 'false') return 0;
  return null;
}

function normalizarVolumeComercial(body = {}) {
  if (!temCampoVolume(body)) {
    return {
      informado: false,
      utiliza_volume: 0,
      volume_valor: null,
      volume_unidade: null
    };
  }

  if (!Object.prototype.hasOwnProperty.call(body, 'utiliza_volume')) {
    throw erroVolume('UTILIZA_VOLUME_OBRIGATORIO', 'Informe se o produto utiliza volume.');
  }

  const utilizaVolume = normalizarFlag(body.utiliza_volume);
  if (utilizaVolume === null) {
    throw erroVolume('UTILIZA_VOLUME_INVALIDO', 'O campo Utiliza volume? deve ser verdadeiro ou falso.');
  }
  if (!utilizaVolume) {
    return {
      informado: true,
      utiliza_volume: 0,
      volume_valor: null,
      volume_unidade: null
    };
  }

  const bruto = body.volume_valor;
  let volumeValor;
  if (typeof bruto === 'number') {
    volumeValor = bruto;
  } else if (typeof bruto === 'string' && bruto.trim()) {
    const texto = bruto.trim();
    if (!/^(?:\d+(?:[.,]\d+)?|[.,]\d+)(?:[eE][+-]?\d+)?$/.test(texto)) {
      throw erroVolume('VOLUME_VALOR_INVALIDO', 'Informe um volume numérico válido e maior que zero.');
    }
    volumeValor = Number(texto.replace(',', '.'));
  } else {
    throw erroVolume('VOLUME_VALOR_INVALIDO', 'Informe um volume numérico válido e maior que zero.');
  }

  if (!Number.isFinite(volumeValor) || volumeValor <= 0) {
    throw erroVolume('VOLUME_VALOR_INVALIDO', 'Informe um volume numérico válido e maior que zero.');
  }

  let unidade = normalizarUnidade(body.volume_unidade);
  let unidadeId = null;
  if (body.volume_unidade_id !== undefined && body.volume_unidade_id !== null && String(body.volume_unidade_id).trim() !== '') {
    unidadeId = Number(body.volume_unidade_id);
    if (!Number.isSafeInteger(unidadeId) || unidadeId <= 0) {
      throw erroVolume('VOLUME_UNIDADE_INVALIDA', 'Selecione uma unidade de volume cadastrada.');
    }
    try {
      unidade = normalizarSigla(body.volume_unidade);
    } catch (_) {
      throw erroVolume('VOLUME_UNIDADE_INVALIDA', 'Selecione uma unidade de volume válida.');
    }
  } else if (!unidade || familiaDe(unidade) !== 'VOLUME' || !['L', 'ML'].includes(unidade)) {
    throw erroVolume('VOLUME_UNIDADE_INVALIDA', 'Selecione Litro (L), Mililitro (ML) ou uma unidade cadastrada.');
  }

  return {
    informado: true,
    utiliza_volume: 1,
    volume_valor: volumeValor,
    volume_unidade: unidade,
    volume_unidade_id: unidadeId
  };
}

function normalizarVolumeComercialResposta(produto = {}) {
  const tipo = String(produto.tipo_operacional || 'COMERCIAL').trim().toUpperCase();
  const utilizaVolume = tipo === 'COMERCIAL' && Number(produto.utiliza_volume) === 1 ? 1 : 0;
  if (!utilizaVolume) {
    return {
      utiliza_volume: 0,
      volume_valor: null,
      volume_unidade: null,
      volume_unidade_id: null,
      volume_unidade_nome: null
    };
  }

  let sigla = normalizarUnidade(produto.volume_unidade);
  if (!sigla && produto.volume_unidade != null) {
    try {
      sigla = normalizarSigla(produto.volume_unidade);
    } catch (_) {
      sigla = String(produto.volume_unidade).trim() || null;
    }
  }

  return {
    utiliza_volume: 1,
    volume_valor: Number(produto.volume_valor),
    volume_unidade: sigla,
    volume_unidade_id: Number.isSafeInteger(Number(produto.volume_unidade_id)) && Number(produto.volume_unidade_id) > 0
      ? Number(produto.volume_unidade_id)
      : null,
    volume_unidade_nome: produto.volume_unidade_nome || null
  };
}

module.exports = {
  MIGRACOES_SCHEMA,
  CAMPOS_VOLUME_COMERCIAL,
  normalizarVolumeComercial,
  normalizarVolumeComercialResposta
};
