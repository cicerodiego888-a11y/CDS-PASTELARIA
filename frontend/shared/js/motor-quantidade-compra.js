/**
 * RC4.31.19 / MUC-06 — Identidade comercial na UI.
 * Não converte CAIXA→UN, SI nem encadeamento. Quantidade de estoque vem do preview MUC
 * (quantidade_convertida já preenchida pelo backend).
 */
(function (global) {
    'use strict';

    function obterQuantidadeComercial(item = {}) {
        const explicita = Number(item.quantidade_comercial);
        if (Number.isFinite(explicita) && explicita > 0) return explicita;

        const emb = Number(item.quantidade_embalagens || 0);
        if (emb > 0) return emb;

        const convertida = Number(item.quantidade_convertida || 0);
        const fator = Number(item.quantidade_por_embalagem || 0);
        if (convertida > 0 && fator <= 0) return convertida;

        return Number(item.quantidade || 0);
    }

    function obterQuantidadeConvertida(item = {}) {
        const convertidaExplicita = Number(item.quantidade_convertida || 0);
        if (Number.isFinite(convertidaExplicita) && convertidaExplicita > 0) {
            return convertidaExplicita;
        }
        return Number(item.quantidade || 0);
    }

    global.obterQuantidadeComercial = obterQuantidadeComercial;
    global.obterQuantidadeConvertida = obterQuantidadeConvertida;
}(typeof window !== 'undefined' ? window : global));
