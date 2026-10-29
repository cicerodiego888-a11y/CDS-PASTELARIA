# PDV-MULTIEMPRESA-05 — Integração do preview com o contrato de estoque por item

**Data:** 2026-10-26  
**Módulo:** PDV oficial `/pdv`  
**Pré-requisito:** PDV-MULTIEMPRESA-04  
**Estado final:** **CONCLUÍDA**

## 1. Origem dos campos

| Campo | Origem no PDV / contrato | Confiável para bucket de estoque? |
|---|---|---|
| `produto_id` / `quantidade` / `unidade` | Carrinho (`id`, `quantidade`; `unidade` quando presente) | Sim (identidade do item) |
| `emitir_fiscal` / `venda_fiscal` | Flag de operação (`pdvEmitirFiscalNaVenda`) | Sim — tipo **operacional** padrão (R08) |
| `tipo_saldo` / `tipoSaldo` | Somente se já estiver no item do carrinho | Sim, quando explícito e válido (`FISCAL` / `NAO_FISCAL`) |
| `quantidade_fiscal` / `quantidade_nao_fiscal` | Contrato de venda / distribuição Motor F×NF (finalização); raros no carrinho em edição | Sim, quando explícitos (modo SPLIT no motor M04) |
| `item_fiscal` | Catálogo → item do carrinho | **Não** sozinho — natureza do SKU para NF, não bucket de baixa |

Na edição normal do carrinho o PDV **não** calcula split F×NF antes do preview (isso ocorre no pré-cálculo da finalização). Por isso o preview só propaga split/tipo quando esses campos **já existem** no item; caso contrário mantém o fallback operacional.

## 2. Contrato antes × depois

### Antes

```json
{
  "itens": [{ "produto_id": N, "quantidade": Q, "unidade": "..." }],
  "emitir_fiscal": true|false,
  "origem": "PDV"
}
```

### Depois (compatível)

```json
{
  "itens": [{
    "produto_id": N,
    "quantidade": Q,
    "unidade": "...",
    "tipo_saldo": "FISCAL"|"NAO_FISCAL",          // opcional, só se confiável
    "quantidade_fiscal": number,                   // opcional
    "quantidade_nao_fiscal": number,               // opcional
    "item_fiscal": 0|1                             // metadado; não escolhe bucket
  }],
  "emitir_fiscal": true|false,
  "venda_fiscal": true|false,
  "origem": "PDV"
}
```

Campos opcionais **omitidos** quando ausentes ou inválidos → comportamento idêntico ao anterior (tipo da operação).

Servidor permanece autoritativo: capacidade / seleção recalculadas; frontend não substitui validações.

## 3. Arquivos alterados

| Arquivo | Ação |
|---|---|
| `frontend/pdv/js/pdv.js` | `montarItensSelecaoEmpresaPreviewPdv` + uso em `atualizarSelecaoEmpresaPdv`; envia `venda_fiscal` alinhado a `emitir_fiscal` |
| `backend/services/vendas/SelecaoEmpresaVendaPdvService.js` | Export de `extrairItensCarrinho` (já propagava campos no M04) |
| `tests/pdv/pdv-multiempresa-05-preview-itens.test.js` | Novo |
| `docs/arquitetura/PDV-MULTIEMPRESA-05-RELATORIO.md` | Este relatório |

Motor de capacidade e regra de ficha: **sem alteração** nesta sprint (reutiliza M04).

## 4. Testes executados

```text
node --test tests/pdv/pdv-multiempresa-05-preview-itens.test.js
→ 8 pass / 0 fail

node --test tests/pdv/pdv-multiempresa-04-capacidade-por-item.test.js
→ 10 pass / 0 fail

node --test tests/muv/muv-cap-01-capacidade-selecao.test.js
→ 10 pass / 0 fail

node --test tests/pdv/pdv-sel-01-selecao-empresa.test.js
→ 18 pass / 0 fail
```

Cobertura: homogêneo; misto com `tipo_saldo`; preservação F/NF; fallback; `item_fiscal` isolado não escolhe bucket; revalidação; sem soma/divisão CNPJ; hash diferencia requisitos.

## 5. Campos ausentes ou inválidos

- `tipo_saldo` inválido → omitido.
- Sem quantidades F/NF → sem modo SPLIT.
- Sem tipo por item → herança do `emitir_fiscal`/`venda_fiscal` no servidor.
- `item_fiscal` pode ser enviado como metadado; capacidade **não** o usa para escolher saldo.

## 6. Isolamento

Testes com `:memory:` / leitura estática de `pdv.js` via `vm`. Sem `CDS_ALLOW_OFFICIAL_DB`, sem banco oficial/cliente, sem SEFAZ, sem vendas reais.

## 7. Pendências

1. Carrinho em edição ainda tipicamente sem split F×NF até a finalização — enriquecer o carrinho com distribuição antecipada exigiria decisão de produto (e risco de usar saldo da empresa do header, não da selecionada).
2. UI para editar `tipo_saldo` por item: fora de escopo.
3. E2E SEL-02 não reexecutado nesta entrega (fora dos testes direcionados pedidos).

## 8. Encerramento

Critérios atendidos: campos confiáveis chegam ao motor quando existem; fallback preservado; testes direcionados e regressões M04 / CAP-01 / SEL-01 aprovados.

**Estado: CONCLUÍDA**
