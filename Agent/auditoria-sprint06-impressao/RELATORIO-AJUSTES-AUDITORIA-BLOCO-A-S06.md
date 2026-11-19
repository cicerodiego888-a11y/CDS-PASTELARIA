# RELATÓRIO — Ajustes da auditoria · Sprint 06 Bloco A

**Data:** 2026-11-16  
**Status:** AJUSTES ENTREGUES — aguardando nova auditoria do Tech Lead  
**Bloco B:** NÃO INICIADO  
**Schema:** permanece **v3** (sem V4)  
**Banco oficial:** intocado  

---

## Correções solicitadas

### 1. Isolamento JWT — POST `/impressao/estacoes`

- Removido `...body` que podia sobrescrever `empresaId` / `unidadeId`.
- Whitelist explícita de campos do body.
- Unidade via `unidadeCozinhaDaSessao(req.user)` — **ignora** `unidade_id` do body (não usa `resolverUnidadeOperacionalReq`, que rejeitaria IDs falsos em vez de ignorá-los).
- Mesmo padrão aplicado a GET/PUT/teste/snapshot preview das rotas de impressão.
- Teste HTTP **13**: envia `empresaId`/`unidadeId`/`empresa_id`/`unidade_id` falsos; grava na sessão autenticada.

### 2. Imutabilidade do snapshot

- `Object.freeze` em snapshot, array `itens`, cada item e cada ingrediente.
- Teste **11**: mutações lançam `TypeError`.

### 3. Serialização canônica

- `serializarSnapshot()` reexecuta `montarPayloadSnapshot` e rejeita campos proibidos antes do `JSON.stringify`.
- Teste **12**: input sujo (preço/ncm/valor) sai limpo.

### 4. Versão de schema no banco

- Teste **3** usa `lerVersaoSchema(db)` e `SELECT valor FROM cozinha_schema_meta WHERE chave = 'schema_version'`.
- Assert `Number(valor) === 3` antes e depois do ajuste de índice.

---

## Testes

| Suite | Resultado |
|---|---|
| `sprint06-bloco-a-fundacao-contratos.test.js` | **14/14** |
| Regressão S01 isolamento + S05 ops | **31/31** · `TOTAL_FAIL=0` |

Artefatos: `DIFF-BLOCO-A-S06.patch` (atualizado) · `LOG-BLOCO-A-AJUSTES-AUDITORIA.txt`

---

## Condição de encerramento

**AJUSTES DO BLOCO A ENTREGUES — AGUARDANDO NOVA AUDITORIA DO TECH LEAD.**

Não avançar para o Bloco B.
