# Relatório — Implementação 03.31
## Auditoria de fechamento dos escritores operacionais de estoque

**Data:** 2026-08-21 · **Status:** concluída

---

## 1. Escritores encontrados

Porta de saldos: `estoqueSaldosPublico` (`creditarSaldo` / `debitarSaldo`).  
Porta de reservas: `reservasPublico` (`reservarQuantidade` / `liberarQuantidadeReservada`).

Callers operacionais: ajuste, recálculo, compras (crédito/débito), venda (baixa e crédito), NF-e devolução venda, reservas PDV, consumo PDV, ponte pedido→venda, ReservaRepair, Motor Comercial, MTS, CREATE de produto (saldo inicial).

Não encontrados: produção, ficha técnica, transformação de estoque, Central de Entradas como escritor.

---

## 2. Tabela de classificação

| Fluxo | Arquivo | Tipo | Classe | empresaId | Ação |
|---|---|---|---|---|---|
| Ajuste / saldo inicial / importação | `ajusteEstoqueService.js` | saldo | A | `req.empresaId` | não alterar (03.28) |
| Recálculo HTTP | `estoqueFiscalService.js` | saldo | A | `req.empresaId` | não alterar (03.28) |
| Crédito compra | `creditoEstoqueCompraViaPorta.js` | saldo | A | `req.empresaId` | não alterar (03.27) |
| Débito compra / cancel / devolução | `debitoEstoqueCompraViaPorta.js` | saldo | A | `req.empresaId` | não alterar (03.27) |
| Baixa venda | `debitoEstoqueVendaViaPorta.js` | saldo | A | `req.empresaId` | não alterar (03.25) |
| Crédito cancel/devolução venda | `creditoEstoqueVendaViaPorta.js` | saldo | B | `req.empresaId` | **corrigido** |
| NF-e devolução venda (retorno + revert) | `estoqueNfeDevolucaoVenda.js` | saldo | B | `req.empresaId` | **corrigido** |
| Reservas PDV | `EstoqueReservaService.js` | reserva | A | `req.empresaId` | não alterar (03.26) |
| Consumo reserva PDV | `EstoqueConsumoReserva.js` | reserva | A | `req.empresaId` | não alterar (03.26) |
| Pedido / Expedição → MC → MTS | `PedidoOperacionalService` / MTS | saldo | A | `req.empresaId` → `params.empresaId` | não alterar (03.30/03.29) |
| MTS F↔NF | `MtsService.js` | saldo | A | `params.empresaId` | não alterar (03.29) |
| Ponte consumo reserva pedido | `pedidoReservaPonteNucleo.js` | reserva | C | caller ou COMPAT | manter COMPAT |
| ReservaRepairService | `ReservaRepairService.js` | reserva | C | sem HTTP | COMPAT; sem rota |
| CREATE produto + saldo inicial | `rotas/produtos.js` | saldo | A | `req.empresaId` | não alterar (03.8/03.28) |
| `atualizarEstoqueConsolidado` | `lotesService.js` | EA | D | n/a | código morto |
| Migração unidades | `migracaoConversaoUnidades.js` | cadastro | D | n/a | não toca saldo |
| Certificação / fixtures | `ReleaseCertificationService.js` | script | D | n/a | não migrar |
| Produção / ficha / transformação | — | — | — | n/a | domínio inexistente |

---

## 3. Fluxos corrigidos

Domínio único: **retorno de estoque de venda**.

- `montarOpcoesRetornoEstoqueVenda` lê só `req.empresaId`
- `montarOptsPortaCreditoVenda` lê só `opcoes.empresaId`
- `devolverSaldosDistribuidos` deixa de encaminhar `contexto`/`ctx`
- HTTP emitir/cancelar NF-e de devolução envia `resolverEmpresaId(req.empresaId)`
- `retornarEstoqueNfeDevolucaoVenda` passa `empresaId` ao crédito 02.5
- revert NF-e deixa de ler `contexto`/`ctx`

---

## 4. Fluxos mantidos em COMPAT

Ponte pedido (quando o caller não informa empresa), ReservaRepair (sem HTTP), e qualquer caller dos fluxos A/B sem `req.empresaId`. Sem empresa 1. Sem copiar legado para `estoque_empresa`.

---

## 5. Código morto / scripts / certificações

`lotesService.atualizarEstoqueConsolidado` (sem callers). `migracaoConversaoUnidades` (flags de cadastro). `ReleaseCertificationService` e backfill de saldos (D). Scripts de certificação MTS/MUC.

---

## 6. Leitores descartados

Dashboard, CIP, MIB, GET produto, listagem, disponibilidade PDV, consulta admin `estoque/empresa`. Fora do escopo (Classe E).

---

## 7. Testes executados

- `tests/estoque/auditoria-escritores-operacionais-03-31.test.js`
- `tests/estoque/credito-venda-nfe-devolucao-multiempresa-contexto.test.js`
- `tests/estoque/credito-cancel-dev-venda-porta-publica.test.js`
- `tests/estoque/revert-devolucao-venda-porta-publica.test.js`
- `tests/estoque/porta-publica-saldos-multiempresa.test.js`
- `tests/estoque/reservas-dual-write-empresa.test.js`
- `tests/muc/muc-public-contract.test.js`

MTS não executado: o domínio corrigido não chega ao MTS.

---

## 8. Regressão

Porta pública, dual-write 03.19/03.20, MUC, 02.5 e 03.5 permanecem. Sem SQL direto novo. Sem porta paralela.

---

## 9. O que NÃO foi alterado

MTS, Motor Comercial, Motor Fiscal, Motor Não Fiscal, regras F/NF, PDV, compras, baixa de venda, reservas PDV já migradas, schema `estoque_empresa`, dual-write, backfill, leitura oficial de `produtos`. Sprint 03.32 **não iniciada**.

---

## Encerramento

Não restam escritores operacionais de produção/transformação. O único Classe B encontrado (retorno de estoque de venda) foi corrigido por propagação de `req.empresaId`.

**AUDITORIA DE ESCRITORES OPERACIONAIS ENCERRADA**
