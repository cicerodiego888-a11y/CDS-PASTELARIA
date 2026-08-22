# Implementação 03.21 — primeira leitura operacional por empresa

**Status:** concluída · **Data:** 2026-08-21  
**Projeto:** Pastelaria · Fase 2 Fundação Multiempresa

---

## Consumidor escolhido

`GET /api/produtos/:id`

Helper: `resolverSaldosProdutoParaResposta`  
(`backend/services/estoque/leituraEstoqueEmpresaProduto.js`)

`empresaId` vem de `req.empresaId` (middleware opcional 03.19: empresa existente, ativa e com vínculo).

---

## Candidatos recusados

| Candidato | Motivo |
|---|---|
| Porta `consultarSaldo` | Writer / leitura oficial global — proibido |
| Listagens / dashboard / vencimentos | Sem produto+empresa pontual confiável |
| PDV / identificar | Crítico; fora do escopo |
| Compra / venda / ajuste / NF-e | Escritores |
| MTS / MUC / Motor Comercial | Proibidos |
| Consulta 03.18 | Já é endpoint administrativo dedicado, não cadastro operacional |

---

## Comportamento

**Sem empresa:** resposta legada de `produtos` (inalterada).

**Com empresa + registro:** SF, SNF, EA, RF, RNF de `estoque_empresa`.

**Com empresa + sem registro:** zeros explícitos. Sem fallback para o saldo legado. Flags `estoque_empresa_isolado` / `estoque_empresa_encontrado`.

---

## Storage oficial legado

`produtos` permanece a fonte dos demais fluxos. Porta pública, dual-write e PDV intactos.
