# Implementação 03.8 — CREATE produto / saldos iniciais → Porta Pública

**Status:** concluída · **Data:** 2026-08-21  
**Projeto:** Pastelaria · Fase 2 Fundação Multiempresa

---

## Auditoria obrigatória

### CREATE de produto (produção)

| Arquivo | Método | Saldos no INSERT | Migrar 03.8? |
|---|---|---|---|
| `backend/rotas/produtos.js` | `POST /` | `estoque_atual`, `saldo_fiscal`, `saldo_nao_fiscal` calculados | **sim — escritor principal** |
| `backend/rotas/compras.js` | `ensureProductForItemLegado` | `0, 0, 0` (cadastro vazio; estoque entra na compra) | não — compras |
| `backend/services/importacao-inicial-produtos/importer.js` | `inserirProduto` | `0, 0, 0` depois `aplicarAjusteAsync` (já 02.1) | não — importação |
| Certification / testes | seeds | N/A | não |

Nenhum CREATE já usava `estoqueSaldosPublico` no INSERT. O PUT de saldos iniciais já usava a porta (02.1).

### empresaId no HEAD

O `POST /` não propagava empresa. Contexto possível: `req.empresaId` (03.2), body, `req.user`. Ausência → COMPAT de CREATE.

---

## Fluxo anterior

```
POST /produtos
  ↓
definirSaldosIniciaisProduto (SF/SNF ou estoque_atual legado → todo fiscal)
  ↓
INSERT produtos (estoque_atual, saldo_fiscal, saldo_nao_fiscal)
```

Regra legada (preservada): se o body não traz `saldo_fiscal_inicial` / `saldo_nao_fiscal_inicial`, `estoque_atual` inteiro vai para **fiscal**; NF = 0. Sem divisão automática inventada.

---

## Fluxo novo

```
POST /produtos
  ↓
definirSaldosIniciaisProduto (mesma regra)
  ↓
INSERT produto (SF=0, SNF=0, estoque_atual=0)
  ↓
se SF > 0 ou SNF > 0:
  aplicarSaldoInicialCreateProduto
        ↓
  estoqueSaldosPublico.creditarSaldo (FISCAL / NAO_FISCAL)
```

Zero não chama a porta.

`estoque_atual = SF + SNF` permanece invariante da porta.

Tracking/lotes/MIP/MIB/embalagens inalterados. `estoqueInicial` em memória segue alimentando lote inicial (fora do escopo).

---

## Porta

`estoqueSaldosPublico` via `aplicarSaldosIniciaisViaPorta` / `creditarSaldo`.

Não criada porta nova.

---

## empresaId / COMPAT

1. `opts.empresaId` / `req.empresaId` / body / user  
2. header `X-Empresa-Id`  
3. Ausência + quantidade positiva → `COMPAT_CREATE_PRODUTO_SALDO_INICIAL_PRE_MULTIEMPRESA`  
4. `exigirEmpresa: true` → `EMPRESA_OBRIGATORIA`

Sem empresa 1 / CNPJ / fallback silencioso.

---

## Transação

Mesmo `db` do CREATE. Sem BEGIN próprio no fluxo. Rollback externo reverte produto + saldo (testado).

---

## Escritores apenas documentados

- Compras: INSERT zerado (estoque na compra, já 02.x).
- Importação inicial: INSERT zerado + ajuste 02.1.
- PUT saldos iniciais: já porta (02.1).
- Lotes: não migrados.

---

## Testes

`tests/estoque/create-produto-saldo-inicial-porta-publica.test.js` — 01–10.

---

## Limitações

1. Storage ainda em `produtos`.
2. COMPAT até o cadastro enviar empresa.
3. `estoque_atual` legado continua 100% fiscal.
4. Sem `estoque_empresa`.

---

## Próximo escritor pendente

**Lotes** (consolidação / `estoque_atual`). Não avançado nesta Sprint.
